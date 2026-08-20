import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createTursoPairingSessionStore } from "../src/pairing-store.js";
import {
  classifyApnsFailure,
  createApnsPushNotificationSender,
  createPushNotificationDispatcher,
  type ApnsNotification,
  type ApnsTransport,
  type PushNotificationSender,
} from "../src/push-notifications.js";

describe("APNs push notification sender", () => {
  it("routes sandbox and production requests with APNs alert headers", async () => {
    const requests: Array<{
      body: string;
      endpoint: string;
      headers: Record<string, string | number>;
    }> = [];
    const transport: ApnsTransport = {
      async request(endpoint, headers, body) {
        requests.push({ body, endpoint, headers });
        return { body: "", headers: { "apns-id": "apns-1" }, status: 200 };
      },
    };
    const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const sender = createApnsPushNotificationSender({
      keyId: "KEY123",
      privateKey,
      teamId: "TEAM123",
      topic: "com.allenneverland.codexrelay",
      transport,
      now: () => 1_800_000_000_000,
    });
    const notification: ApnsNotification = {
      body: "The requested change is complete.",
      bundleId: "com.allenneverland.codexrelay",
      collapseId: "event-1",
      deviceToken: "a".repeat(64),
      environment: "development",
      eventId: "turn_terminal:thread-1:turn-1",
      expiresAt: 1_800_086_400_000,
      intent: "turn_terminal",
      relayId: "relay-identity-1",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await expect(sender.send(notification)).resolves.toEqual({
      accepted: true,
      apnsId: "apns-1",
      status: 200,
    });
    await sender.send({ ...notification, environment: "production" });

    expect(requests.map((request) => request.endpoint)).toEqual([
      "https://api.sandbox.push.apple.com",
      "https://api.push.apple.com",
    ]);
    expect(requests[0]?.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${"a".repeat(64)}`,
      "apns-collapse-id": "event-1",
      "apns-priority": 10,
      "apns-push-type": "alert",
      "apns-topic": "com.allenneverland.codexrelay",
    });
    expect(requests[0]?.headers.authorization).toMatch(/^bearer [^.]+\.[^.]+\.[^.]+$/);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      aps: {
        alert: { body: "The requested change is complete.", title: "Codex Relay" },
        sound: "default",
      },
      eventId: "turn_terminal:thread-1:turn-1",
      intent: "turn_terminal",
      relayId: "relay-identity-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
  });

  it("classifies APNs invalid-token, transient, and permanent responses", () => {
    expect(
      classifyApnsFailure({
        accepted: false,
        reason: "Unregistered",
        status: 410,
      }),
    ).toBe("invalid_device_token");
    expect(
      classifyApnsFailure({
        accepted: false,
        reason: "TooManyRequests",
        status: 429,
      }),
    ).toBe("transient");
    expect(
      classifyApnsFailure({
        accepted: false,
        reason: "BadTopic",
        status: 400,
      }),
    ).toBe("permanent");
  });
});

describe("durable APNs outbox", () => {
  it("retries a transient failure after a dispatcher restart and deduplicates the event", async () => {
    const sessions = await registeredSessions();
    let currentTime = 1_800_000_000_000;
    let attempts = 0;
    const deliveredBodies: Array<string | undefined> = [];
    const sender: PushNotificationSender = {
      configured: true,
      topic: "com.allenneverland.codexrelay",
      async send(notification) {
        attempts += 1;
        deliveredBodies.push(notification.body);
        return attempts === 1
          ? { accepted: false, reason: "InternalServerError", status: 500 }
          : { accepted: true, apnsId: "apns-retry", status: 200 };
      },
    };
    const event = {
      body: "Durable completion message",
      eventId: "turn_terminal:thread-1:turn-1",
      intent: "turn_terminal" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    };
    const first = createPushNotificationDispatcher({
      now: () => currentTime,
      sender,
      sessions,
    });

    await first.dispatch(event);
    expect(await first.health("phone-session")).toMatchObject({
      lastErrorCode: "InternalServerError",
      pendingCount: 1,
    });

    currentTime += 5_000;
    const restarted = createPushNotificationDispatcher({
      now: () => currentTime,
      sender,
      sessions,
    });
    await waitUntil(() => attempts === 2);
    expect(await restarted.health("phone-session")).toMatchObject({
      lastAcceptedAt: currentTime,
      pendingCount: 0,
    });

    await restarted.dispatch(event);
    expect(attempts).toBe(2);
    expect(deliveredBodies).toEqual(["Durable completion message", "Durable completion message"]);
  });

  it("disables a subscription when APNs rejects its device token", async () => {
    const sessions = await registeredSessions();
    const sender: PushNotificationSender = {
      configured: true,
      topic: "com.allenneverland.codexrelay",
      async send() {
        return { accepted: false, reason: "BadDeviceToken", status: 400 };
      },
    };
    const dispatcher = createPushNotificationDispatcher({ sender, sessions });

    await dispatcher.dispatch({
      eventId: "turn_terminal:thread-1:turn-1",
      intent: "turn_terminal",
      threadId: "thread-1",
      turnId: "turn-1",
    });

    expect(await sessions.getPushNotificationSubscription("phone-session")).toBeUndefined();
  });
});

async function registeredSessions() {
  const sessions = await createTursoPairingSessionStore(":memory:");
  await sessions.createSession("client-token", {
    clientSessionId: "phone-session",
    expiresAt: Date.now() + 60_000,
  });
  await sessions.upsertPushNotificationSubscription({
    actionRequired: true,
    bundleId: "com.allenneverland.codexrelay",
    clientSessionId: "phone-session",
    deviceToken: "a".repeat(64),
    environment: "development",
    turnTerminal: true,
  });
  return sessions;
}

async function waitUntil(condition: () => boolean) {
  const timeoutAt = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= timeoutAt) {
      throw new Error("Timed out waiting for notification delivery.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
