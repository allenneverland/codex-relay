import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fromByteArray, toByteArray } from "base64-js";

import { connect } from "./libsql-database.js";
import type { SecureSession } from "./secure-transport.js";

export type ClientSession = {
  clientSessionId?: string;
  clientName?: string;
  expiresAt?: number;
  secureSession?: SecureSession;
};

// Preserve the legacy database/API fields without making session validity time-based.
export const permanentClientSessionExpiresAt = Date.parse("9999-12-31T23:59:59.999Z");

export type PendingPairing = {
  approvalCode: string;
  approved: boolean;
  clientEphemeralPublicKey: string;
  clientSessionId?: string;
  clientName?: string;
  clientNonce: string;
  expiresAt: number;
  serverUrl: string;
};

export type PushNotificationPreferences = {
  actionRequired: boolean;
  turnTerminal: boolean;
};

export type PushNotificationSubscription = PushNotificationPreferences & {
  bundleId: string;
  clientSessionId: string;
  deviceToken: string;
  environment: "development" | "production";
};

export type PushNotificationOutboxEvent = {
  body?: string;
  eventId: string;
  intent: "turn_terminal" | "action_required" | "test";
  threadId: string;
  turnId?: string;
};

export type PushNotificationDelivery = PushNotificationOutboxEvent & {
  attemptCount: number;
  bundleId: string;
  clientSessionId: string;
  collapseId: string;
  deliveryKey: string;
  deviceToken: string;
  environment: "development" | "production";
  expiresAt: number;
};

export type PushNotificationDeliveryHealth = {
  environment: "development" | "production" | null;
  lastAcceptedAt: number | null;
  lastErrorCode: string | null;
  pendingCount: number;
};

export type PairingSessionStore = {
  approvePendingPairing(approvalCode: string, now: number): Promise<PendingPairing | undefined>;
  clearAll(): Promise<{ pendingPairingsCleared: number; sessionsCleared: number }>;
  countActive(): Promise<number>;
  deletePushNotificationSubscription(clientSessionId: string): Promise<void>;
  deletePushNotificationSubscriptionByDeviceToken(deviceToken: string): Promise<void>;
  enqueuePushNotificationEvent(
    event: PushNotificationOutboxEvent,
    now: number,
    targetClientSessionId?: string,
  ): Promise<number>;
  createPendingPairing(pairing: PendingPairing): Promise<void>;
  createSession(tokenHash: string, session: ClientSession): Promise<number>;
  deleteSession(tokenHash: string): Promise<void>;
  deletePendingPairing(approvalCode: string): Promise<void>;
  getPendingPairing(approvalCode: string, now: number): Promise<PendingPairing | undefined>;
  getPushNotificationSubscription(
    clientSessionId: string,
  ): Promise<PushNotificationSubscription | undefined>;
  getPushNotificationPreferences(clientSessionId: string): Promise<PushNotificationPreferences>;
  getPushNotificationDeliveryHealth(
    clientSessionId: string,
  ): Promise<PushNotificationDeliveryHealth>;
  getPushNotificationMetadata(key: string): Promise<string | undefined>;
  getValidSession(tokenHash: string): Promise<ClientSession | undefined>;
  listActivePushNotificationSubscriptions(): Promise<PushNotificationSubscription[]>;
  listDuePushNotificationDeliveries(
    now: number,
    limit?: number,
  ): Promise<PushNotificationDelivery[]>;
  markPushNotificationDeliveryAccepted(
    deliveryKey: string,
    apnsId: string | undefined,
    now: number,
  ): Promise<void>;
  markPushNotificationDeliveryFailed(
    deliveryKey: string,
    errorCode: string,
    apnsId: string | undefined,
    now: number,
  ): Promise<void>;
  pruneExpiredPendingPairings(now: number): Promise<void>;
  recordThreadWaitingState(
    threadId: string,
    waiting: boolean,
    now: number,
  ): Promise<number | undefined>;
  reschedulePushNotificationDelivery(
    deliveryKey: string,
    nextAttemptAt: number,
    errorCode: string,
    apnsId: string | undefined,
    now: number,
  ): Promise<void>;
  rotateSession(
    oldTokenHash: string,
    newTokenHash: string,
    session: ClientSession,
  ): Promise<number>;
  updateSecureSession(tokenHash: string, secureSession: SecureSession): Promise<void>;
  setPushNotificationMetadata(key: string, value: string, now: number): Promise<void>;
  upsertPushNotificationSubscription(subscription: PushNotificationSubscription): Promise<void>;
};

export async function createTursoPairingSessionStore(path: string): Promise<PairingSessionStore> {
  if (path !== ":memory:") {
    await mkdir(dirname(path), { recursive: true });
  }

  const db = await connect(path);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_sessions (
      token_hash TEXT PRIMARY KEY,
      client_session_id TEXT,
      client_name TEXT,
      expires_at INTEGER NOT NULL,
      key_epoch INTEGER,
      mobile_to_server_key TEXT,
      server_to_mobile_key TEXT,
      last_mobile_counter INTEGER,
      next_server_counter INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_pairings (
      approval_code TEXT PRIMARY KEY,
      client_session_id TEXT,
      client_name TEXT,
      client_ephemeral_public_key TEXT NOT NULL,
      client_nonce TEXT NOT NULL,
      server_url TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_notification_subscriptions (
      client_session_id TEXT PRIMARY KEY,
      expo_push_token TEXT NOT NULL,
      platform TEXT NOT NULL,
      turn_terminal_enabled INTEGER NOT NULL,
      action_required_enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS apns_push_notification_subscriptions (
      client_session_id TEXT PRIMARY KEY,
      device_token TEXT NOT NULL,
      environment TEXT NOT NULL,
      bundle_id TEXT NOT NULL,
      turn_terminal_enabled INTEGER NOT NULL,
      action_required_enabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS apns_push_notification_device_token_idx
      ON apns_push_notification_subscriptions(device_token);

    CREATE TABLE IF NOT EXISTS push_notification_events (
      event_id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      body TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_notification_deliveries (
      delivery_key TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      intent TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      body TEXT,
      collapse_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      apns_id TEXT,
      last_error_code TEXT,
      accepted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS push_notification_deliveries_due_idx
      ON push_notification_deliveries(status, next_attempt_at);

    CREATE TABLE IF NOT EXISTS push_notification_thread_state (
      thread_id TEXT PRIMARY KEY,
      waiting INTEGER NOT NULL,
      waiting_generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_notification_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  await ensurePairingSessionColumns();
  await ensurePushNotificationColumns();

  async function countActive() {
    const row = await db
      .prepare(
        "SELECT COUNT(DISTINCT COALESCE(client_session_id, token_hash)) AS count FROM pairing_sessions",
      )
      .get();
    return Number(row?.count ?? 0);
  }

  async function deleteSession(tokenHash: string) {
    await db.transaction(async (transaction) => {
      const row = await transaction
        .prepare(
          "SELECT client_session_id AS clientSessionId FROM pairing_sessions WHERE token_hash = ?",
        )
        .get(tokenHash);
      await transaction.prepare("DELETE FROM pairing_sessions WHERE token_hash = ?").run(tokenHash);
      if (typeof row?.clientSessionId !== "string") {
        return;
      }
      await transaction
        .prepare("DELETE FROM apns_push_notification_subscriptions WHERE client_session_id = ?")
        .run(row.clientSessionId);
      await transaction
        .prepare("DELETE FROM push_notification_subscriptions WHERE client_session_id = ?")
        .run(row.clientSessionId);
      await transaction
        .prepare("DELETE FROM push_notification_deliveries WHERE client_session_id = ?")
        .run(row.clientSessionId);
    })();
  }

  async function deletePendingPairing(approvalCode: string) {
    await db.prepare("DELETE FROM pending_pairings WHERE approval_code = ?").run(approvalCode);
  }

  async function getPendingPairing(approvalCode: string, now: number) {
    const row = await db
      .prepare(
        `SELECT approval_code AS approvalCode,
                client_session_id AS clientSessionId,
                client_name AS clientName,
                client_ephemeral_public_key AS clientEphemeralPublicKey,
                client_nonce AS clientNonce,
                server_url AS serverUrl,
                approved,
                expires_at AS expiresAt
         FROM pending_pairings
         WHERE approval_code = ?`,
      )
      .get(approvalCode);
    if (!row) {
      return undefined;
    }

    const expiresAt = Number(row.expiresAt);
    if (now > expiresAt) {
      await deletePendingPairing(approvalCode);
      return undefined;
    }

    return {
      approvalCode: String(row.approvalCode),
      approved: Number(row.approved) === 1,
      clientEphemeralPublicKey: String(row.clientEphemeralPublicKey),
      clientSessionId: typeof row.clientSessionId === "string" ? row.clientSessionId : undefined,
      clientName: typeof row.clientName === "string" ? row.clientName : undefined,
      clientNonce: String(row.clientNonce),
      expiresAt,
      serverUrl: String(row.serverUrl),
    };
  }

  async function getPushNotificationSubscription(clientSessionId: string) {
    const row = await db
      .prepare(
        `SELECT client_session_id AS clientSessionId,
                device_token AS deviceToken,
                environment,
                bundle_id AS bundleId,
                turn_terminal_enabled AS turnTerminal,
                action_required_enabled AS actionRequired
         FROM apns_push_notification_subscriptions
         WHERE client_session_id = ?`,
      )
      .get(clientSessionId);
    return row ? pushNotificationSubscriptionFromRow(row) : undefined;
  }

  return {
    async approvePendingPairing(approvalCode, now) {
      const pending = await getPendingPairing(approvalCode, now);
      if (!pending) {
        return undefined;
      }

      await db
        .prepare("UPDATE pending_pairings SET approved = 1, updated_at = ? WHERE approval_code = ?")
        .run(now, approvalCode);
      return { ...pending, approved: true };
    },
    async clearAll() {
      const result = await db.transaction(async (transaction) => {
        const sessionRow = await transaction
          .prepare("SELECT COUNT(*) AS count FROM pairing_sessions")
          .get();
        const pendingRow = await transaction
          .prepare("SELECT COUNT(*) AS count FROM pending_pairings")
          .get();
        await transaction.prepare("DELETE FROM pairing_sessions").run();
        await transaction.prepare("DELETE FROM pending_pairings").run();
        await transaction.prepare("DELETE FROM push_notification_subscriptions").run();
        await transaction.prepare("DELETE FROM apns_push_notification_subscriptions").run();
        await transaction.prepare("DELETE FROM push_notification_events").run();
        await transaction.prepare("DELETE FROM push_notification_deliveries").run();
        await transaction.prepare("DELETE FROM push_notification_thread_state").run();
        await transaction.prepare("DELETE FROM push_notification_metadata").run();
        return {
          pendingPairingsCleared: Number(pendingRow?.count ?? 0),
          sessionsCleared: Number(sessionRow?.count ?? 0),
        };
      })();
      return result;
    },
    countActive,
    async deletePushNotificationSubscription(clientSessionId) {
      await db.transaction(async (transaction) => {
        await transaction
          .prepare("DELETE FROM apns_push_notification_subscriptions WHERE client_session_id = ?")
          .run(clientSessionId);
        await transaction
          .prepare("DELETE FROM push_notification_subscriptions WHERE client_session_id = ?")
          .run(clientSessionId);
      })();
    },
    async deletePushNotificationSubscriptionByDeviceToken(deviceToken) {
      await db.transaction(async (transaction) => {
        const row = await transaction
          .prepare(
            "SELECT client_session_id AS clientSessionId FROM apns_push_notification_subscriptions WHERE device_token = ?",
          )
          .get(deviceToken);
        if (typeof row?.clientSessionId === "string") {
          await transaction
            .prepare(
              `UPDATE push_notification_deliveries
               SET status = 'failed',
                   last_error_code = COALESCE(last_error_code, 'InvalidDeviceToken'),
                   updated_at = ?
               WHERE client_session_id = ? AND status = 'pending'`,
            )
            .run(Date.now(), row.clientSessionId);
        }
        await transaction
          .prepare("DELETE FROM apns_push_notification_subscriptions WHERE device_token = ?")
          .run(deviceToken);
      })();
    },
    async enqueuePushNotificationEvent(event, now, targetClientSessionId) {
      return db.transaction(async (transaction) => {
        const eventInsert = await transaction
          .prepare(
            `INSERT OR IGNORE INTO push_notification_events (
             event_id, intent, thread_id, turn_id, body, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.eventId,
            event.intent,
            event.threadId,
            event.turnId ?? null,
            event.body ?? null,
            now,
          );
        if (affectedRows(eventInsert) === 0) {
          return 0;
        }
        const subscriptions = await transaction
          .prepare(
            `SELECT subscriptions.client_session_id AS clientSessionId
           FROM apns_push_notification_subscriptions AS subscriptions
           INNER JOIN pairing_sessions AS sessions
             ON sessions.client_session_id = subscriptions.client_session_id
           WHERE (? IS NULL OR subscriptions.client_session_id = ?)
             AND (
               ? = 'test'
               OR (? = 'action_required' AND subscriptions.action_required_enabled = 1)
               OR (? = 'turn_terminal' AND subscriptions.turn_terminal_enabled = 1)
             )
           GROUP BY subscriptions.client_session_id`,
          )
          .all(
            targetClientSessionId ?? null,
            targetClientSessionId ?? null,
            event.intent,
            event.intent,
            event.intent,
          );
        const expiresAt =
          now + (event.intent === "action_required" ? 60 * 60_000 : 24 * 60 * 60_000);
        let inserted = 0;
        for (const row of resultRows(subscriptions)) {
          if (typeof row.clientSessionId !== "string") {
            continue;
          }
          const deliveryKey = `${event.eventId}:${row.clientSessionId}`;
          const result = await transaction
            .prepare(
              `INSERT OR IGNORE INTO push_notification_deliveries (
               delivery_key,
               event_id,
               client_session_id,
               intent,
               thread_id,
               turn_id,
               body,
               collapse_id,
               status,
               attempt_count,
               next_attempt_at,
               expires_at,
               created_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
            )
            .run(
              deliveryKey,
              event.eventId,
              row.clientSessionId,
              event.intent,
              event.threadId,
              event.turnId ?? null,
              event.body ?? null,
              collapseIdForEvent(event.eventId),
              now,
              expiresAt,
              now,
              now,
            );
          inserted += affectedRows(result);
        }
        return inserted;
      })();
    },
    async createPendingPairing(pairing) {
      const now = Date.now();
      await db
        .prepare(
          `INSERT INTO pending_pairings (
             approval_code,
             client_session_id,
             client_name,
             client_ephemeral_public_key,
             client_nonce,
             server_url,
             approved,
             expires_at,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          pairing.approvalCode,
          pairing.clientSessionId ?? null,
          pairing.clientName ?? null,
          pairing.clientEphemeralPublicKey,
          pairing.clientNonce,
          pairing.serverUrl,
          pairing.approved ? 1 : 0,
          pairing.expiresAt,
          now,
          now,
        );
    },
    async createSession(tokenHash, session) {
      const now = Date.now();
      const secure = encodeSecureSession(session.secureSession);
      if (session.clientSessionId) {
        await db
          .prepare("DELETE FROM pairing_sessions WHERE client_session_id = ?")
          .run(session.clientSessionId);
        if (session.clientName) {
          await db
            .prepare(
              "DELETE FROM pairing_sessions WHERE client_session_id IS NULL AND client_name = ?",
            )
            .run(session.clientName);
        }
      }
      await db
        .prepare(
          `INSERT INTO pairing_sessions (
             token_hash,
             client_session_id,
             client_name,
             expires_at,
             key_epoch,
             mobile_to_server_key,
             server_to_mobile_key,
             last_mobile_counter,
             next_server_counter,
             created_at,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          session.clientSessionId ?? null,
          session.clientName ?? null,
          session.expiresAt ?? permanentClientSessionExpiresAt,
          secure?.keyEpoch ?? null,
          secure?.mobileToServerKey ?? null,
          secure?.serverToMobileKey ?? null,
          secure?.lastMobileCounter ?? null,
          secure?.nextServerCounter ?? null,
          now,
          now,
        );
      return countActive();
    },
    deleteSession,
    deletePendingPairing,
    getPendingPairing,
    getPushNotificationSubscription,
    async getPushNotificationPreferences(clientSessionId) {
      const subscription = await getPushNotificationSubscription(clientSessionId);
      if (subscription) {
        return {
          actionRequired: subscription.actionRequired,
          turnTerminal: subscription.turnTerminal,
        };
      }
      const legacy = await db
        .prepare(
          `SELECT turn_terminal_enabled AS turnTerminal,
                  action_required_enabled AS actionRequired
           FROM push_notification_subscriptions
           WHERE client_session_id = ?`,
        )
        .get(clientSessionId);
      return legacy
        ? {
            actionRequired: Number(legacy.actionRequired) === 1,
            turnTerminal: Number(legacy.turnTerminal) === 1,
          }
        : { actionRequired: false, turnTerminal: false };
    },
    async getPushNotificationDeliveryHealth(clientSessionId) {
      const subscription = await getPushNotificationSubscription(clientSessionId);
      const row = await db
        .prepare(
          `SELECT
             SUM(CASE WHEN status = 'pending' AND expires_at > ? THEN 1 ELSE 0 END) AS pendingCount,
             MAX(accepted_at) AS lastAcceptedAt
           FROM push_notification_deliveries
           WHERE client_session_id = ?`,
        )
        .get(Date.now(), clientSessionId);
      const error = await db
        .prepare(
          `SELECT last_error_code AS lastErrorCode
           FROM push_notification_deliveries
           WHERE client_session_id = ? AND last_error_code IS NOT NULL
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(clientSessionId);
      return {
        environment: subscription?.environment ?? null,
        lastAcceptedAt:
          row?.lastAcceptedAt === null || row?.lastAcceptedAt === undefined
            ? null
            : Number(row.lastAcceptedAt),
        lastErrorCode: typeof error?.lastErrorCode === "string" ? error.lastErrorCode : null,
        pendingCount: Number(row?.pendingCount ?? 0),
      };
    },
    async getPushNotificationMetadata(key) {
      const row = await db
        .prepare("SELECT value FROM push_notification_metadata WHERE key = ?")
        .get(key);
      return typeof row?.value === "string" ? row.value : undefined;
    },
    async getValidSession(tokenHash) {
      const row = await db
        .prepare(
          `SELECT client_name AS clientName,
                  client_session_id AS clientSessionId,
                  expires_at AS expiresAt,
                  key_epoch AS keyEpoch,
                  mobile_to_server_key AS mobileToServerKey,
                  server_to_mobile_key AS serverToMobileKey,
                  last_mobile_counter AS lastMobileCounter,
                  next_server_counter AS nextServerCounter
           FROM pairing_sessions
           WHERE token_hash = ?`,
        )
        .get(tokenHash);
      if (!row) {
        return undefined;
      }

      return {
        clientSessionId: typeof row.clientSessionId === "string" ? row.clientSessionId : undefined,
        clientName: typeof row.clientName === "string" ? row.clientName : undefined,
        expiresAt: Number(row.expiresAt),
        secureSession: decodeSecureSession(row),
      };
    },
    async listActivePushNotificationSubscriptions() {
      const rows = await db
        .prepare(
          `SELECT subscriptions.client_session_id AS clientSessionId,
                  subscriptions.device_token AS deviceToken,
                  subscriptions.environment,
                  subscriptions.bundle_id AS bundleId,
                  subscriptions.turn_terminal_enabled AS turnTerminal,
                  subscriptions.action_required_enabled AS actionRequired
           FROM apns_push_notification_subscriptions AS subscriptions
           INNER JOIN pairing_sessions AS sessions
             ON sessions.client_session_id = subscriptions.client_session_id
           GROUP BY subscriptions.client_session_id`,
        )
        .all();
      return resultRows(rows).flatMap((row) => {
        const subscription = pushNotificationSubscriptionFromRow(row);
        return subscription ? [subscription] : [];
      });
    },
    async listDuePushNotificationDeliveries(now, limit = 100) {
      const rows = await db
        .prepare(
          `SELECT deliveries.delivery_key AS deliveryKey,
                  deliveries.event_id AS eventId,
                  deliveries.client_session_id AS clientSessionId,
                  deliveries.intent,
                  deliveries.thread_id AS threadId,
                  deliveries.turn_id AS turnId,
                  deliveries.body,
                  deliveries.collapse_id AS collapseId,
                  deliveries.attempt_count AS attemptCount,
                  deliveries.expires_at AS expiresAt,
                  subscriptions.device_token AS deviceToken,
                  subscriptions.environment,
                  subscriptions.bundle_id AS bundleId
           FROM push_notification_deliveries AS deliveries
           INNER JOIN apns_push_notification_subscriptions AS subscriptions
             ON subscriptions.client_session_id = deliveries.client_session_id
           WHERE deliveries.status = 'pending'
             AND deliveries.next_attempt_at <= ?
             AND deliveries.expires_at > ?
           ORDER BY deliveries.next_attempt_at, deliveries.created_at
           LIMIT ?`,
        )
        .all(now, now, limit);
      return resultRows(rows).flatMap((row) => {
        const delivery = pushNotificationDeliveryFromRow(row);
        return delivery ? [delivery] : [];
      });
    },
    async markPushNotificationDeliveryAccepted(deliveryKey, apnsId, now) {
      await db
        .prepare(
          `UPDATE push_notification_deliveries
           SET status = 'accepted',
               attempt_count = attempt_count + 1,
               apns_id = ?,
               last_error_code = NULL,
               accepted_at = ?,
               updated_at = ?
           WHERE delivery_key = ?`,
        )
        .run(apnsId ?? null, now, now, deliveryKey);
    },
    async markPushNotificationDeliveryFailed(deliveryKey, errorCode, apnsId, now) {
      await db
        .prepare(
          `UPDATE push_notification_deliveries
           SET status = 'failed',
               attempt_count = attempt_count + 1,
               apns_id = ?,
               last_error_code = ?,
               updated_at = ?
           WHERE delivery_key = ?`,
        )
        .run(apnsId ?? null, errorCode, now, deliveryKey);
    },
    async pruneExpiredPendingPairings(now) {
      await db.prepare("DELETE FROM pending_pairings WHERE expires_at <= ?").run(now);
      await db
        .prepare(
          `DELETE FROM apns_push_notification_subscriptions
           WHERE NOT EXISTS (
             SELECT 1
             FROM pairing_sessions
             WHERE pairing_sessions.client_session_id = apns_push_notification_subscriptions.client_session_id
           )`,
        )
        .run();
      await db
        .prepare(
          `DELETE FROM push_notification_subscriptions
           WHERE NOT EXISTS (
             SELECT 1
             FROM pairing_sessions
             WHERE pairing_sessions.client_session_id = push_notification_subscriptions.client_session_id
           )`,
        )
        .run();
      await db
        .prepare(
          `DELETE FROM push_notification_deliveries
           WHERE updated_at <= ?
             AND (status != 'pending' OR expires_at <= ?)`,
        )
        .run(now - 7 * 24 * 60 * 60_000, now);
      await db
        .prepare("DELETE FROM push_notification_events WHERE created_at <= ?")
        .run(now - 7 * 24 * 60 * 60_000);
      await db
        .prepare(
          `UPDATE push_notification_deliveries
           SET status = 'expired', updated_at = ?
           WHERE status = 'pending' AND expires_at <= ?`,
        )
        .run(now, now);
    },
    async recordThreadWaitingState(threadId, waiting, now) {
      return db.transaction(async (transaction) => {
        const row = await transaction
          .prepare(
            `SELECT waiting, waiting_generation AS waitingGeneration
           FROM push_notification_thread_state
           WHERE thread_id = ?`,
          )
          .get(threadId);
        if (!row) {
          const generation = waiting ? 1 : 0;
          await transaction
            .prepare(
              `INSERT INTO push_notification_thread_state (
               thread_id, waiting, waiting_generation, updated_at
             ) VALUES (?, ?, ?, ?)`,
            )
            .run(threadId, waiting ? 1 : 0, generation, now);
          return waiting ? generation : undefined;
        }

        const wasWaiting = Number(row.waiting) === 1;
        const generation = Number(row.waitingGeneration);
        if (wasWaiting === waiting) {
          await transaction
            .prepare("UPDATE push_notification_thread_state SET updated_at = ? WHERE thread_id = ?")
            .run(now, threadId);
          return undefined;
        }

        const nextGeneration = waiting ? generation + 1 : generation;
        await transaction
          .prepare(
            `UPDATE push_notification_thread_state
           SET waiting = ?, waiting_generation = ?, updated_at = ?
           WHERE thread_id = ?`,
          )
          .run(waiting ? 1 : 0, nextGeneration, now, threadId);
        return waiting ? nextGeneration : undefined;
      })();
    },
    async reschedulePushNotificationDelivery(deliveryKey, nextAttemptAt, errorCode, apnsId, now) {
      await db
        .prepare(
          `UPDATE push_notification_deliveries
           SET attempt_count = attempt_count + 1,
               next_attempt_at = ?,
               apns_id = ?,
               last_error_code = ?,
               updated_at = ?
           WHERE delivery_key = ?`,
        )
        .run(nextAttemptAt, apnsId ?? null, errorCode, now, deliveryKey);
    },
    async rotateSession(oldTokenHash, newTokenHash, session) {
      const now = Date.now();
      const secure = encodeSecureSession(session.secureSession);
      await db.transaction(async (transaction) => {
        await transaction
          .prepare("DELETE FROM pairing_sessions WHERE token_hash = ?")
          .run(oldTokenHash);
        if (session.clientSessionId) {
          await transaction
            .prepare("DELETE FROM pairing_sessions WHERE client_session_id = ?")
            .run(session.clientSessionId);
          if (session.clientName) {
            await transaction
              .prepare(
                "DELETE FROM pairing_sessions WHERE client_session_id IS NULL AND client_name = ?",
              )
              .run(session.clientName);
          }
        }
        await transaction
          .prepare(
            `INSERT INTO pairing_sessions (
               token_hash,
               client_session_id,
               client_name,
               expires_at,
               key_epoch,
               mobile_to_server_key,
               server_to_mobile_key,
               last_mobile_counter,
               next_server_counter,
               created_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newTokenHash,
            session.clientSessionId ?? null,
            session.clientName ?? null,
            session.expiresAt ?? permanentClientSessionExpiresAt,
            secure?.keyEpoch ?? null,
            secure?.mobileToServerKey ?? null,
            secure?.serverToMobileKey ?? null,
            secure?.lastMobileCounter ?? null,
            secure?.nextServerCounter ?? null,
            now,
            now,
          );
      })();
      return countActive();
    },
    async updateSecureSession(tokenHash, secureSession) {
      const secure = encodeSecureSession(secureSession)!;
      const now = Date.now();
      await db
        .prepare(
          `UPDATE pairing_sessions
           SET key_epoch = ?,
               mobile_to_server_key = ?,
               server_to_mobile_key = ?,
               last_mobile_counter = ?,
               next_server_counter = ?,
               updated_at = ?
           WHERE token_hash = ?`,
        )
        .run(
          secure.keyEpoch,
          secure.mobileToServerKey,
          secure.serverToMobileKey,
          secure.lastMobileCounter,
          secure.nextServerCounter,
          now,
          tokenHash,
        );
    },
    async setPushNotificationMetadata(key, value, now) {
      await db
        .prepare(
          `INSERT INTO push_notification_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`,
        )
        .run(key, value, now);
    },
    async upsertPushNotificationSubscription(subscription) {
      const now = Date.now();
      await db.transaction(async (transaction) => {
        await transaction
          .prepare(
            "DELETE FROM apns_push_notification_subscriptions WHERE device_token = ? AND client_session_id != ?",
          )
          .run(subscription.deviceToken, subscription.clientSessionId);
        await transaction
          .prepare(
            `INSERT INTO apns_push_notification_subscriptions (
               client_session_id,
               device_token,
               environment,
               bundle_id,
               turn_terminal_enabled,
               action_required_enabled,
               created_at,
               updated_at
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(client_session_id) DO UPDATE SET
               device_token = excluded.device_token,
               environment = excluded.environment,
               bundle_id = excluded.bundle_id,
               turn_terminal_enabled = excluded.turn_terminal_enabled,
               action_required_enabled = excluded.action_required_enabled,
               updated_at = excluded.updated_at`,
          )
          .run(
            subscription.clientSessionId,
            subscription.deviceToken,
            subscription.environment,
            subscription.bundleId,
            subscription.turnTerminal ? 1 : 0,
            subscription.actionRequired ? 1 : 0,
            now,
            now,
          );
        await transaction
          .prepare("DELETE FROM push_notification_subscriptions WHERE client_session_id = ?")
          .run(subscription.clientSessionId);
      })();
    },
  };

  async function ensurePairingSessionColumns() {
    const rows = await db.prepare("PRAGMA table_info(pairing_sessions)").all();
    const columns = new Set(resultRows(rows).map((row) => String(row.name)));
    const migrations: Array<[string, string]> = [
      ["client_session_id", "ALTER TABLE pairing_sessions ADD COLUMN client_session_id TEXT"],
      ["key_epoch", "ALTER TABLE pairing_sessions ADD COLUMN key_epoch INTEGER"],
      ["mobile_to_server_key", "ALTER TABLE pairing_sessions ADD COLUMN mobile_to_server_key TEXT"],
      ["server_to_mobile_key", "ALTER TABLE pairing_sessions ADD COLUMN server_to_mobile_key TEXT"],
      [
        "last_mobile_counter",
        "ALTER TABLE pairing_sessions ADD COLUMN last_mobile_counter INTEGER",
      ],
      [
        "next_server_counter",
        "ALTER TABLE pairing_sessions ADD COLUMN next_server_counter INTEGER",
      ],
    ];

    for (const [column, sql] of migrations) {
      if (!columns.has(column)) {
        await db.exec(sql);
      }
    }

    const pendingRows = await db.prepare("PRAGMA table_info(pending_pairings)").all();
    const pendingColumns = new Set(resultRows(pendingRows).map((row) => String(row.name)));
    if (!pendingColumns.has("client_session_id")) {
      await db.exec("ALTER TABLE pending_pairings ADD COLUMN client_session_id TEXT");
    }
  }

  async function ensurePushNotificationColumns() {
    for (const table of ["push_notification_events", "push_notification_deliveries"]) {
      const rows = await db.prepare(`PRAGMA table_info(${table})`).all();
      const columns = new Set(resultRows(rows).map((row) => String(row.name)));
      if (!columns.has("body")) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN body TEXT`);
      }
    }
  }
}

function encodeSecureSession(session: SecureSession | undefined) {
  if (!session) {
    return undefined;
  }

  return {
    keyEpoch: session.keyEpoch,
    lastMobileCounter: session.lastMobileCounter,
    mobileToServerKey: fromByteArray(session.mobileToServerKey),
    nextServerCounter: session.nextServerCounter,
    serverToMobileKey: fromByteArray(session.serverToMobileKey),
  };
}

function decodeSecureSession(row: Record<string, unknown>) {
  if (
    typeof row.mobileToServerKey !== "string" ||
    typeof row.serverToMobileKey !== "string" ||
    row.keyEpoch === null ||
    row.lastMobileCounter === null ||
    row.nextServerCounter === null
  ) {
    return undefined;
  }

  return {
    keyEpoch: Number(row.keyEpoch),
    lastMobileCounter: Number(row.lastMobileCounter),
    mobileToServerKey: toByteArray(row.mobileToServerKey),
    nextServerCounter: Number(row.nextServerCounter),
    serverToMobileKey: toByteArray(row.serverToMobileKey),
  };
}

function pushNotificationSubscriptionFromRow(
  row: Record<string, unknown>,
): PushNotificationSubscription | undefined {
  if (
    typeof row.clientSessionId !== "string" ||
    typeof row.deviceToken !== "string" ||
    typeof row.bundleId !== "string" ||
    (row.environment !== "development" && row.environment !== "production")
  ) {
    return undefined;
  }

  return {
    actionRequired: Number(row.actionRequired) === 1,
    bundleId: row.bundleId,
    clientSessionId: row.clientSessionId,
    deviceToken: row.deviceToken,
    environment: row.environment,
    turnTerminal: Number(row.turnTerminal) === 1,
  };
}

function pushNotificationDeliveryFromRow(
  row: Record<string, unknown>,
): PushNotificationDelivery | undefined {
  if (
    typeof row.deliveryKey !== "string" ||
    typeof row.eventId !== "string" ||
    typeof row.clientSessionId !== "string" ||
    typeof row.threadId !== "string" ||
    typeof row.collapseId !== "string" ||
    typeof row.deviceToken !== "string" ||
    typeof row.bundleId !== "string" ||
    (row.environment !== "development" && row.environment !== "production") ||
    (row.intent !== "turn_terminal" && row.intent !== "action_required" && row.intent !== "test")
  ) {
    return undefined;
  }

  return {
    attemptCount: Number(row.attemptCount),
    ...(typeof row.body === "string" ? { body: row.body } : {}),
    bundleId: row.bundleId,
    clientSessionId: row.clientSessionId,
    collapseId: row.collapseId,
    deliveryKey: row.deliveryKey,
    deviceToken: row.deviceToken,
    environment: row.environment,
    eventId: row.eventId,
    expiresAt: Number(row.expiresAt),
    intent: row.intent,
    threadId: row.threadId,
    ...(typeof row.turnId === "string" ? { turnId: row.turnId } : {}),
  };
}

function collapseIdForEvent(eventId: string) {
  return createHash("sha256").update(eventId).digest("hex");
}

function affectedRows(result: unknown) {
  if (!result || typeof result !== "object") {
    return 0;
  }
  const changes = (result as { changes?: unknown }).changes;
  const rowsAffected = (result as { rowsAffected?: unknown }).rowsAffected;
  return Number(changes ?? rowsAffected ?? 0);
}

function resultRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}
