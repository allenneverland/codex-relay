import { createPrivateKey, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { setInterval } from "node:timers";

import type { PairingSessionStore, PushNotificationDelivery } from "./pairing-store.js";

const defaultApnsTopic = "com.allenneverland.codexrelay";
const apnsEndpoints = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;
const invalidDeviceTokenReasons = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
  "Unregistered",
]);

export type PushNotificationIntent = "turn_terminal" | "action_required" | "test";

export type PushNotificationEvent = {
  eventId: string;
  intent: PushNotificationIntent;
  threadId: string;
  turnId?: string;
};

export type ApnsNotification = PushNotificationEvent & {
  bundleId: string;
  collapseId: string;
  deviceToken: string;
  environment: "development" | "production";
  expiresAt: number;
};

export type ApnsSendResult = {
  accepted: boolean;
  apnsId?: string;
  reason?: string;
  status: number;
};

export type PushNotificationSender = {
  configured: boolean;
  topic: string;
  send(notification: ApnsNotification): Promise<ApnsSendResult>;
};

export type PushNotificationDispatcher = {
  dispatch(event: PushNotificationEvent): Promise<void>;
  health(clientSessionId: string): Promise<{
    environment: "development" | "production" | null;
    lastAcceptedAt: number | null;
    lastErrorCode: string | null;
    pendingCount: number;
    providerConfigured: boolean;
  }>;
  sendTest(clientSessionId: string): Promise<boolean>;
};

type ApnsTransportResponse = {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  status: number;
};

export type ApnsTransport = {
  request(
    endpoint: string,
    headers: Record<string, string | number>,
    body: string,
  ): Promise<ApnsTransportResponse>;
};

export function createApnsPushNotificationSender(options: {
  keyId: string;
  privateKey: string | KeyObject;
  teamId: string;
  topic?: string;
  transport?: ApnsTransport;
  now?: () => number;
}): PushNotificationSender {
  const now = options.now ?? Date.now;
  const privateKey =
    typeof options.privateKey === "string"
      ? createPrivateKey(options.privateKey)
      : options.privateKey;
  const transport = options.transport ?? createHttp2ApnsTransport();
  let cachedJwt: { createdAt: number; value: string } | undefined;

  function authorizationToken() {
    const currentTime = now();
    if (cachedJwt && currentTime - cachedJwt.createdAt < 50 * 60_000) {
      return cachedJwt.value;
    }
    const header = base64UrlJson({ alg: "ES256", kid: options.keyId });
    const payload = base64UrlJson({ iss: options.teamId, iat: Math.floor(currentTime / 1000) });
    const signingInput = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(signingInput), {
      dsaEncoding: "ieee-p1363",
      key: privateKey,
    }).toString("base64url");
    const value = `${signingInput}.${signature}`;
    cachedJwt = { createdAt: currentTime, value };
    return value;
  }

  return {
    configured: true,
    topic: options.topic ?? defaultApnsTopic,
    async send(notification) {
      const response = await transport.request(
        apnsEndpoints[notification.environment],
        {
          ":method": "POST",
          ":path": `/3/device/${notification.deviceToken}`,
          authorization: `bearer ${authorizationToken()}`,
          "apns-collapse-id": notification.collapseId,
          "apns-expiration": Math.floor(notification.expiresAt / 1000),
          "apns-priority": 10,
          "apns-push-type": "alert",
          "apns-topic": options.topic ?? defaultApnsTopic,
          "content-type": "application/json",
        },
        JSON.stringify(notificationPayload(notification)),
      );
      const reason = apnsReason(response.body);
      if (reason === "ExpiredProviderToken") {
        cachedJwt = undefined;
      }
      return {
        accepted: response.status === 200,
        apnsId: firstHeader(response.headers["apns-id"]),
        ...(reason ? { reason } : {}),
        status: response.status,
      };
    },
  };
}

export function createApnsPushNotificationSenderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PushNotificationSender {
  const keyPath = environment.CODEX_RELAY_APNS_KEY_PATH?.trim();
  const keyId = environment.CODEX_RELAY_APNS_KEY_ID?.trim();
  const teamId = environment.CODEX_RELAY_APNS_TEAM_ID?.trim();
  const topic = environment.CODEX_RELAY_APNS_TOPIC?.trim() || defaultApnsTopic;
  if (!keyPath || !keyId || !teamId) {
    return {
      configured: false,
      topic,
      async send() {
        return { accepted: false, reason: "ProviderNotConfigured", status: 0 };
      },
    };
  }
  try {
    return createApnsPushNotificationSender({
      keyId,
      privateKey: readFileSync(keyPath, "utf8"),
      teamId,
      topic,
    });
  } catch {
    return {
      configured: false,
      topic,
      async send() {
        return { accepted: false, reason: "ProviderConfigurationError", status: 0 };
      },
    };
  }
}

export function createPushNotificationDispatcher(input: {
  sender: PushNotificationSender;
  sessions: PairingSessionStore;
  now?: () => number;
}): PushNotificationDispatcher {
  const now = input.now ?? Date.now;
  let drainPromise: Promise<void> | undefined;
  let drainRequested = false;
  const retryTimer = setInterval(() => void drain().catch(() => undefined), 5_000);
  (retryTimer as unknown as { unref(): void }).unref();

  async function drain() {
    drainRequested = true;
    if (drainPromise) {
      await drainPromise;
      if (drainRequested) {
        await drain();
      }
      return;
    }
    const currentDrain = (async () => {
      while (drainRequested) {
        drainRequested = false;
        await drainOutbox(input.sessions, input.sender, now);
      }
    })();
    drainPromise = currentDrain;
    try {
      await currentDrain;
    } finally {
      if (drainPromise === currentDrain) {
        drainPromise = undefined;
      }
    }
  }

  void drain().catch(() => undefined);

  return {
    async dispatch(event) {
      await input.sessions.enqueuePushNotificationEvent(event, now());
      await drain();
    },
    async health(clientSessionId) {
      return {
        ...(await input.sessions.getPushNotificationDeliveryHealth(clientSessionId)),
        providerConfigured: input.sender.configured,
      };
    },
    async sendTest(clientSessionId) {
      const currentTime = now();
      await input.sessions.enqueuePushNotificationEvent(
        {
          eventId: `test:${randomUUID()}`,
          intent: "test",
          threadId: "test",
        },
        currentTime,
        clientSessionId,
      );
      await drain();
      const after = await input.sessions.getPushNotificationDeliveryHealth(clientSessionId);
      return after.lastAcceptedAt !== null && after.lastAcceptedAt >= currentTime;
    },
  };
}

export function classifyApnsFailure(result: ApnsSendResult) {
  if (result.accepted) {
    return "accepted" as const;
  }
  if (result.reason && invalidDeviceTokenReasons.has(result.reason)) {
    return "invalid_device_token" as const;
  }
  if (
    result.status === 0 ||
    result.status === 429 ||
    result.status >= 500 ||
    result.reason === "ExpiredProviderToken"
  ) {
    return "transient" as const;
  }
  return "permanent" as const;
}

async function drainOutbox(
  sessions: PairingSessionStore,
  sender: PushNotificationSender,
  now: () => number,
) {
  for (;;) {
    const currentTime = now();
    const deliveries = await sessions.listDuePushNotificationDeliveries(currentTime);
    if (deliveries.length === 0) {
      await sessions.pruneExpiredPendingPairings(currentTime);
      return;
    }
    for (const delivery of deliveries) {
      await deliver(sessions, sender, delivery, now);
    }
  }
}

async function deliver(
  sessions: PairingSessionStore,
  sender: PushNotificationSender,
  delivery: PushNotificationDelivery,
  now: () => number,
) {
  let result: ApnsSendResult;
  try {
    result = await sender.send(delivery);
  } catch (error) {
    result = {
      accepted: false,
      reason: error instanceof Error ? error.name : "TransportError",
      status: 0,
    };
  }
  const currentTime = now();
  const classification = classifyApnsFailure(result);
  if (classification === "accepted") {
    await sessions.markPushNotificationDeliveryAccepted(
      delivery.deliveryKey,
      result.apnsId,
      currentTime,
    );
    return;
  }

  const errorCode = result.reason ?? `HTTP_${result.status}`;
  if (classification === "invalid_device_token") {
    await sessions.markPushNotificationDeliveryFailed(
      delivery.deliveryKey,
      errorCode,
      result.apnsId,
      currentTime,
    );
    await sessions.deletePushNotificationSubscriptionByDeviceToken(delivery.deviceToken);
    return;
  }
  if (classification === "permanent") {
    await sessions.markPushNotificationDeliveryFailed(
      delivery.deliveryKey,
      errorCode,
      result.apnsId,
      currentTime,
    );
    return;
  }

  const backoff = Math.min(5_000 * 2 ** delivery.attemptCount, 30 * 60_000);
  await sessions.reschedulePushNotificationDelivery(
    delivery.deliveryKey,
    currentTime + backoff,
    errorCode,
    result.apnsId,
    currentTime,
  );
}

function notificationPayload(notification: ApnsNotification) {
  const body =
    notification.intent === "action_required"
      ? "Codex needs your attention."
      : notification.intent === "test"
        ? "Test notification delivered."
        : "A Codex turn has finished.";
  return {
    aps: {
      alert: { body, title: "Codex Relay" },
      sound: "default",
    },
    eventId: notification.eventId,
    intent: notification.intent,
    threadId: notification.threadId,
    ...(notification.turnId ? { turnId: notification.turnId } : {}),
  };
}

function createHttp2ApnsTransport(): ApnsTransport {
  const sessions = new Map<string, ClientHttp2Session>();

  function sessionFor(endpoint: string) {
    const current = sessions.get(endpoint);
    if (current && !current.closed && !current.destroyed) {
      return current;
    }
    const session = connect(endpoint);
    session.unref();
    session.once("close", () => {
      if (sessions.get(endpoint) === session) {
        sessions.delete(endpoint);
      }
    });
    session.on("error", () => undefined);
    sessions.set(endpoint, session);
    return session;
  }

  return {
    request(endpoint, headers, body) {
      return new Promise((resolve, reject) => {
        const session = sessionFor(endpoint);
        const request = session.request(headers);
        let responseBody = "";
        let responseHeaders: Record<string, string | string[] | undefined> = {};
        let status = 0;
        request.setEncoding("utf8");
        request.on("response", (headers) => {
          status = Number(headers[":status"] ?? 0);
          responseHeaders = headers as Record<string, string | string[] | undefined>;
        });
        request.on("data", (chunk: string) => {
          responseBody += chunk;
        });
        request.once("end", () =>
          resolve({ body: responseBody, headers: responseHeaders, status }),
        );
        request.once("error", (error) => {
          session.destroy();
          reject(error);
        });
        request.end(body);
      });
    },
  };
}

function apnsReason(body: string) {
  try {
    const parsed = JSON.parse(body) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
