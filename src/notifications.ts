import { buildPushPayload } from "@block65/webcrypto-web-push";
import { emailAlertConfig, type EmailAlertReason } from "./email-alerts";
import type { AppEnv } from "./env";
import type { SecurityStore } from "./security-store";

export type NotificationType =
  | "CLIENT_AUTHORIZATION_PENDING"
  | "CLIENT_AUTHORIZED"
  | "TRADE_APPROVAL_PENDING"
  | "TRADE_RESULT"
  | "SCHWAB_REAUTH_DUE_SOON"
  | "SCHWAB_REAUTH_REQUIRED"
  | "TEST";

export type DeliveryStatus = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SUPPRESSED";

export interface NotificationEvent {
  id: string;
  dedupeKey: string;
  type: NotificationType;
  entityId: string;
  summary: string;
  createdAt: number;
  expiresAt: number;
  readAt: number | null;
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  ownerCredentialVersion: number;
  createdAt: number;
  disabledAt: number | null;
  disabledReason: string | null;
  lastTestAt: number | null;
}

export interface NotificationDelivery {
  id: string;
  eventId: string;
  subscriptionId: string;
  status: DeliveryStatus;
  attemptCount: number;
  nextAttemptAt: number;
  leaseUntil: number;
  lastStatusCode: number | null;
}

export interface ClaimedEmailDelivery {
  deliveryId: string;
  eventId: string;
  eventEntityId: string;
  reason: EmailAlertReason;
  eventCreatedAt: number;
  eventExpiresAt: number;
  attemptCount: number;
  leaseUntil: number;
  senderAddress: string;
  destinationAddress: string;
}

export class NotificationError extends Error {
  constructor(
    public readonly code: "INVALID_ARGUMENT" | "BROWSER_AUTH_REQUIRED" | "SECURITY_POLICY_CHANGED" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE",
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = "NotificationError";
  }
}

export function decodeBase64Url(data: string): Uint8Array {
  try {
    return Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  } catch {
    throw new NotificationError("INVALID_ARGUMENT", "Invalid base64url data");
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const APPLE_PUSH_HOST_REGEX = /^([a-zA-Z0-9-]+\.)*push\.apple\.com$/i;

export function validateSubscriptionInput(sub: unknown, labelInput: unknown): {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
} {
  if (typeof labelInput !== "string") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription label must be a string");
  }
  const label = labelInput.trim();
  if (label.length < 1 || label.length > 80) {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription label must be 1 to 80 characters");
  }

  if (!sub || typeof sub !== "object") {
    throw new NotificationError("INVALID_ARGUMENT", "Invalid subscription object");
  }

  const subObj = sub as Record<string, unknown>;
  const endpoint = subObj.endpoint;
  if (typeof endpoint !== "string" || endpoint.length > 4096) {
    throw new NotificationError("INVALID_ARGUMENT", "Invalid subscription endpoint length");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(endpoint);
  } catch {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint must be a valid URL");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint must use HTTPS");
  }

  const isFcm = parsedUrl.hostname.toLowerCase() === "fcm.googleapis.com";
  const isApple = APPLE_PUSH_HOST_REGEX.test(parsedUrl.hostname);
  if (!isFcm && !isApple) {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint host is not supported");
  }

  if (parsedUrl.port !== "" && parsedUrl.port !== "443") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint must use default HTTPS port");
  }

  if (parsedUrl.username !== "" || parsedUrl.password !== "") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint must not contain user credentials");
  }

  if (parsedUrl.hash !== "") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription endpoint must not contain hash fragment");
  }

  const keys = subObj.keys;
  if (!keys || typeof keys !== "object") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription keys missing");
  }
  const keysObj = keys as Record<string, unknown>;
  const p256dh = keysObj.p256dh;
  const auth = keysObj.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") {
    throw new NotificationError("INVALID_ARGUMENT", "Subscription keys must be strings");
  }

  const p256dhBytes = decodeBase64Url(p256dh);
  if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) {
    throw new NotificationError("INVALID_ARGUMENT", "Invalid P-256 public key (must be 65-byte uncompressed point)");
  }

  const authBytes = decodeBase64Url(auth);
  if (authBytes.length !== 16) {
    throw new NotificationError("INVALID_ARGUMENT", "Invalid auth secret (must be exactly 16 bytes)");
  }

  return {
    endpoint,
    p256dh,
    auth,
    label,
  };
}

export class NotificationStore {
  constructor(
    private storage: DurableObjectStorage,
    private env: AppEnv,
    private security: SecurityStore
  ) {
    this.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS web_push_identity (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        public_key TEXT NOT NULL,
        private_key TEXT NOT NULL,
        canonical_origin TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subscription (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        label TEXT NOT NULL,
        owner_credential_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        disabled_at INTEGER,
        disabled_reason TEXT,
        last_test_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS notification_event (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        read_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_notification_event_created ON notification_event(created_at DESC);
      CREATE TABLE IF NOT EXISTS notification_delivery (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES notification_event(id),
        subscription_id TEXT NOT NULL REFERENCES push_subscription(id),
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_status_code INTEGER,
        UNIQUE(event_id, subscription_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notification_delivery_dispatch ON notification_delivery(status, next_attempt_at, lease_until);
      CREATE TABLE IF NOT EXISTS email_delivery (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES notification_event(id),
        reason TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        destination_address TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_email_delivery_dispatch ON email_delivery(status, next_attempt_at, lease_until);
    `);
    const subColumns = new Set(this.storage.sql.exec<{ name: string }>("PRAGMA table_info(push_subscription)").toArray().map(r => r.name));
    if (!subColumns.has("last_test_at")) {
      this.storage.sql.exec("ALTER TABLE push_subscription ADD COLUMN last_test_at INTEGER");
    }
  }

  private getCanonicalOrigin(): string {
    return new URL(this.env.SCHWAB_REDIRECT_URI).origin;
  }

  async ensureVapidIdentity(): Promise<{ publicKey: string }> {
    const canonicalOrigin = this.getCanonicalOrigin();
    const existing = this.storage.sql.exec<{
      public_key: string;
      private_key: string;
      canonical_origin: string;
    }>("SELECT public_key, private_key, canonical_origin FROM web_push_identity WHERE id = 1").toArray()[0];

    if (existing) {
      if (existing.canonical_origin !== canonicalOrigin) {
        throw new NotificationError(
          "SECURITY_POLICY_CHANGED",
          "Canonical origin mismatch; restore configured origin before sending push"
        );
      }
      return { publicKey: existing.public_key };
    }

    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    );

    const jwkPrivate = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
    const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);

    if (!jwkPrivate.d) {
      throw new NotificationError("UPSTREAM_UNAVAILABLE", "Failed to export VAPID private key");
    }

    const privateKey = jwkPrivate.d;
    const publicKey = encodeBase64Url(new Uint8Array(rawPublic));

    this.storage.sql.exec(
      "INSERT OR IGNORE INTO web_push_identity VALUES (1, ?, ?, ?, ?)",
      publicKey,
      privateKey,
      canonicalOrigin,
      Date.now()
    );

    const winner = this.storage.sql.exec<{
      public_key: string;
      canonical_origin: string;
    }>("SELECT public_key, canonical_origin FROM web_push_identity WHERE id = 1").one();

    if (winner.canonical_origin !== canonicalOrigin) {
      throw new NotificationError(
        "SECURITY_POLICY_CHANGED",
        "Canonical origin mismatch; restore configured origin before sending push"
      );
    }

    return { publicKey: winner.public_key };
  }

  getVapidKeysInternal(): { subject: string; publicKey: string; privateKey: string } {
    const canonicalOrigin = this.getCanonicalOrigin();
    const row = this.storage.sql.exec<{
      public_key: string;
      private_key: string;
      canonical_origin: string;
    }>("SELECT public_key, private_key, canonical_origin FROM web_push_identity WHERE id = 1").toArray()[0];

    if (!row) {
      throw new NotificationError("UPSTREAM_UNAVAILABLE", "VAPID identity not initialized");
    }

    if (row.canonical_origin !== canonicalOrigin) {
      throw new NotificationError(
        "SECURITY_POLICY_CHANGED",
        "Canonical origin mismatch; restore configured origin"
      );
    }

    return {
      subject: canonicalOrigin,
      publicKey: row.public_key,
      privateKey: row.private_key,
    };
  }

  subscribe(input: { subscription: unknown; label: unknown }): {
    id: string;
    label: string;
    createdAt: number;
  } {
    const validated = validateSubscriptionInput(input.subscription, input.label);
    const credentialVersion = this.security.version();
    const now = Date.now();

    return this.storage.transactionSync(() => {
      const activeCount = this.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) as count FROM push_subscription WHERE disabled_at IS NULL AND endpoint != ?",
        validated.endpoint
      ).one().count;

      if (activeCount >= 20) {
        throw new NotificationError("INVALID_ARGUMENT", "最多支持 20 个活跃推送设备");
      }

      const existing = this.storage.sql.exec<{ id: string }>(
        "SELECT id FROM push_subscription WHERE endpoint = ?",
        validated.endpoint
      ).toArray()[0];

      if (existing) {
        this.storage.sql.exec(
          `UPDATE push_subscription 
           SET label = ?, p256dh = ?, auth = ?, owner_credential_version = ?, disabled_at = NULL, disabled_reason = NULL 
           WHERE id = ?`,
          validated.label,
          validated.p256dh,
          validated.auth,
          credentialVersion,
          existing.id
        );
        return {
          id: existing.id,
          label: validated.label,
          createdAt: now,
        };
      }

      const id = crypto.randomUUID();
      this.storage.sql.exec(
        `INSERT INTO push_subscription VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        id,
        validated.endpoint,
        validated.p256dh,
        validated.auth,
        validated.label,
        credentialVersion,
        now
      );

      return {
        id,
        label: validated.label,
        createdAt: now,
      };
    });
  }

  unsubscribe(id: string): void {
    if (typeof id !== "string" || !id) {
      throw new NotificationError("INVALID_ARGUMENT", "Invalid subscription ID");
    }

    const now = Date.now();
    this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{ id: string }>(
        "SELECT id FROM push_subscription WHERE id = ? AND disabled_at IS NULL",
        id
      ).toArray()[0];

      if (!existing) {
        throw new NotificationError("INVALID_ARGUMENT", "Subscription not found or already disabled", 404);
      }

      this.storage.sql.exec(
        "UPDATE push_subscription SET disabled_at = ?, disabled_reason = 'USER_UNSUBSCRIBED' WHERE id = ?",
        now,
        id
      );

      this.storage.sql.exec(
        "UPDATE notification_delivery SET status = 'SUPPRESSED' WHERE subscription_id = ? AND status IN ('PENDING', 'SENDING')",
        id
      );
    });
  }

  listSubscriptions(): Array<{
    id: string;
    label: string;
    active: boolean;
    createdAt: number;
    disabledAt: number | null;
  }> {
    const rows = this.storage.sql.exec<{
      id: string;
      label: string;
      created_at: number;
      disabled_at: number | null;
    }>(
      "SELECT id, label, created_at, disabled_at FROM push_subscription ORDER BY created_at DESC"
    ).toArray();

    return rows.map(r => ({
      id: r.id,
      label: r.label,
      active: r.disabled_at === null,
      createdAt: r.created_at,
      disabledAt: r.disabled_at,
    }));
  }

  subscriptionForEndpoint(endpoint: string): { id: string; label: string; active: boolean } | null {
    const row = this.storage.sql.exec<{ id: string; label: string; disabled_at: number | null }>(
      "SELECT id, label, disabled_at FROM push_subscription WHERE endpoint = ?",
      endpoint
    ).toArray()[0];
    return row ? { id: row.id, label: row.label, active: row.disabled_at === null } : null;
  }

  recordEvent(event: {
    dedupeKey: string;
    type: NotificationType;
    entityId: string;
    summary: string;
    expiresAt?: number;
    executionStatus?: "EXECUTION_UNCERTAIN";
  }): NotificationEvent | null {
    const now = Date.now();
    const defaultTtlMs = 24 * 60 * 60 * 1000;
    const expiresAt = event.expiresAt ?? (now + defaultTtlMs);

    return this.storage.transactionSync(() => {
      const existing = this.storage.sql.exec<{
        id: string;
        dedupe_key: string;
        type: string;
        entity_id: string;
        summary: string;
        created_at: number;
        expires_at: number;
        read_at: number | null;
      }>("SELECT * FROM notification_event WHERE dedupe_key = ?", event.dedupeKey).toArray()[0];

      if (existing) {
        return {
          id: existing.id,
          dedupeKey: existing.dedupe_key,
          type: existing.type as NotificationType,
          entityId: existing.entity_id,
          summary: existing.summary,
          createdAt: existing.created_at,
          expiresAt: existing.expires_at,
          readAt: existing.read_at,
        };
      }

      const id = crypto.randomUUID();
      this.storage.sql.exec(
        "INSERT INTO notification_event VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
        id,
        event.dedupeKey,
        event.type,
        event.entityId,
        event.summary,
        now,
        expiresAt
      );

      // Create delivery records for all active subscriptions
      const subscriptions = this.storage.sql.exec<{ id: string }>(
        "SELECT id FROM push_subscription WHERE disabled_at IS NULL"
      ).toArray();

      for (const sub of subscriptions) {
        const deliveryId = crypto.randomUUID();
        this.storage.sql.exec(
          "INSERT INTO notification_delivery VALUES (?, ?, ?, 'PENDING', 0, ?, 0, NULL)",
          deliveryId,
          id,
          sub.id,
          now
        );
      }

      const reason: EmailAlertReason | null = event.type === "SCHWAB_REAUTH_DUE_SOON"
        ? "REAUTH_DUE_SOON"
        : event.type === "SCHWAB_REAUTH_REQUIRED"
          ? "REAUTH_REQUIRED"
          : event.type === "TRADE_RESULT" && event.executionStatus === "EXECUTION_UNCERTAIN"
            ? "EXECUTION_UNCERTAIN"
            : null;
      if (reason) {
        const config = emailAlertConfig(this.env);
        if (config?.enabled) {
          this.insertEmailDelivery(id, reason, config, now);
        }
      }

      this.pruneOldEvents();

      return {
        id,
        dedupeKey: event.dedupeKey,
        type: event.type,
        entityId: event.entityId,
        summary: event.summary,
        createdAt: now,
        expiresAt,
        readAt: null,
      };
    });
  }

  private insertEmailDelivery(
    eventId: string,
    reason: EmailAlertReason,
    config: { sender: string; recipient: string },
    now: number
  ): void {
    this.storage.sql.exec(
      `INSERT INTO email_delivery
       (id, event_id, reason, sender_address, destination_address, status, attempt_count, next_attempt_at, lease_until, last_error_code)
       VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, 0, NULL)`,
      crypto.randomUUID(),
      eventId,
      reason,
      config.sender,
      config.recipient,
      now
    );
  }

  suppressPendingReauthorizationEmails(
    generation: string,
    reasons: readonly ("REAUTH_DUE_SOON" | "REAUTH_REQUIRED")[]
  ): void {
    this.storage.transactionSync(() => {
      for (const reason of reasons) {
        this.storage.sql.exec(
          `UPDATE email_delivery SET status = 'SUPPRESSED', lease_until = 0
           WHERE status IN ('PENDING', 'SENDING') AND reason = ?
             AND event_id IN (SELECT id FROM notification_event WHERE entity_id = ?)`,
          reason,
          generation
        );
      }
    });
  }

  suppressPendingDeliveriesForEntity(entityId: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`
        UPDATE notification_delivery 
        SET status = 'SUPPRESSED' 
        WHERE status IN ('PENDING', 'SENDING') 
          AND event_id IN (SELECT id FROM notification_event WHERE entity_id = ?)
      `, entityId);
    });
  }

  markEventRead(eventId: string): void {
    const now = Date.now();
    this.storage.sql.exec(
      "UPDATE notification_event SET read_at = ? WHERE id = ? AND read_at IS NULL",
      now,
      eventId
    );
  }

  getEvent(eventId: string): NotificationEvent | null {
    const row = this.storage.sql.exec<{
      id: string;
      dedupe_key: string;
      type: string;
      entity_id: string;
      summary: string;
      created_at: number;
      expires_at: number;
      read_at: number | null;
    }>("SELECT * FROM notification_event WHERE id = ?", eventId).toArray()[0];

    if (!row) return null;
    return {
      id: row.id,
      dedupeKey: row.dedupe_key,
      type: row.type as NotificationType,
      entityId: row.entity_id,
      summary: row.summary,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      readAt: row.read_at,
    };
  }

  listEvents(limit = 25, offset = 0): {
    items: NotificationEvent[];
    total: number;
    unreadCount: number;
    limit: number;
    offset: number;
  } {
    const clampedLimit = Math.max(1, Math.min(100, limit));
    const clampedOffset = Math.max(0, Math.min(1000, offset));

    const total = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) as count FROM notification_event"
    ).one().count;

    const unreadCount = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) as count FROM notification_event WHERE read_at IS NULL"
    ).one().count;

    const rows = this.storage.sql.exec<{
      id: string;
      dedupe_key: string;
      type: string;
      entity_id: string;
      summary: string;
      created_at: number;
      expires_at: number;
      read_at: number | null;
    }>(
      "SELECT * FROM notification_event ORDER BY created_at DESC LIMIT ? OFFSET ?",
      clampedLimit,
      clampedOffset
    ).toArray();

    return {
      items: rows.map(r => ({
        id: r.id,
        dedupeKey: r.dedupe_key,
        type: r.type as NotificationType,
        entityId: r.entity_id,
        summary: r.summary,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        readAt: r.read_at,
      })),
      total,
      unreadCount,
      limit: clampedLimit,
      offset: clampedOffset,
    };
  }

  triggerTestPush(subscriptionId: string): NotificationEvent {
    const now = Date.now();
    return this.storage.transactionSync(() => {
      const sub = this.storage.sql.exec<{
        id: string;
        last_test_at: number | null;
        disabled_at: number | null;
      }>("SELECT id, last_test_at, disabled_at FROM push_subscription WHERE id = ?", subscriptionId).toArray()[0];

      if (!sub || sub.disabled_at !== null) {
        throw new NotificationError("INVALID_ARGUMENT", "设备不存在或已禁用", 404);
      }

      if (sub.last_test_at && now - sub.last_test_at < 60_000) {
        throw new NotificationError("RATE_LIMITED", "测试通知过于频繁，请一分钟后重试", 429);
      }

      this.storage.sql.exec("UPDATE push_subscription SET last_test_at = ? WHERE id = ?", now, subscriptionId);

      const eventId = crypto.randomUUID();
      const dedupeKey = "test:" + subscriptionId + ":" + String(now);
      const expiresAt = now + 5 * 60 * 1000;
      const summary = "测试推送通知已成功发起";

      this.storage.sql.exec(
        "INSERT INTO notification_event VALUES (?, ?, 'TEST', ?, ?, ?, ?, NULL)",
        eventId,
        dedupeKey,
        subscriptionId,
        summary,
        now,
        expiresAt
      );

      const deliveryId = crypto.randomUUID();
      this.storage.sql.exec(
        "INSERT INTO notification_delivery VALUES (?, ?, ?, 'PENDING', 0, ?, 0, NULL)",
        deliveryId,
        eventId,
        subscriptionId,
        now
      );

      return {
        id: eventId,
        dedupeKey,
        type: "TEST",
        entityId: subscriptionId,
        summary,
        createdAt: now,
        expiresAt,
        readAt: null,
      };
    });
  }

  triggerTestEmail(): NotificationEvent {
    const now = Date.now();
    return this.storage.transactionSync(() => {
      const config = emailAlertConfig(this.env);
      if (!config) {
        throw new NotificationError("UPSTREAM_UNAVAILABLE", "邮件通知尚未配置", 503);
      }

      const lastTest = this.storage.sql.exec<{ created_at: number }>(
        `SELECT e.created_at FROM notification_event e
         JOIN email_delivery d ON d.event_id = e.id
         WHERE d.reason = 'TEST'
         ORDER BY e.created_at DESC LIMIT 1`
      ).toArray()[0];
      if (lastTest && now - lastTest.created_at < 60_000) {
        throw new NotificationError("RATE_LIMITED", "测试通知过于频繁，请一分钟后重试", 429);
      }

      const id = crypto.randomUUID();
      const dedupeKey = "email-test:" + id;
      const entityId = "owner-email";
      const expiresAt = now + 60 * 60 * 1000;
      const summary = "测试邮件通知已加入发送队列";
      this.storage.sql.exec(
        "INSERT INTO notification_event VALUES (?, ?, 'TEST', ?, ?, ?, ?, NULL)",
        id,
        dedupeKey,
        entityId,
        summary,
        now,
        expiresAt
      );
      this.insertEmailDelivery(id, "TEST", config, now);
      this.pruneOldEvents();

      return {
        id,
        dedupeKey,
        type: "TEST",
        entityId,
        summary,
        createdAt: now,
        expiresAt,
        readAt: null,
      };
    });
  }

  onPasskeyRecovery(): void {
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE push_subscription SET disabled_at = ?, disabled_reason = 'PASSKEY_RECOVERY' WHERE disabled_at IS NULL",
        now
      );
      this.storage.sql.exec(
        "UPDATE notification_delivery SET status = 'SUPPRESSED' WHERE status IN ('PENDING', 'SENDING')"
      );
    });
  }

  private pruneOldEvents(): void {
    const deleteEvents = (events: Array<{ id: string }>): void => {
      if (events.length === 0) return;
      const ids = JSON.stringify(events.map(event => event.id));
      this.storage.sql.exec(
        "DELETE FROM notification_delivery WHERE event_id IN (SELECT value FROM json_each(?))",
        ids
      );
      this.storage.sql.exec(
        "DELETE FROM email_delivery WHERE event_id IN (SELECT value FROM json_each(?))",
        ids
      );
      this.storage.sql.exec(
        "DELETE FROM notification_event WHERE id IN (SELECT value FROM json_each(?))",
        ids
      );
    };

    // Select each set once before deleting either channel's child records.
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const expiredEvents = this.storage.sql.exec<{ id: string }>(`
      SELECT id FROM notification_event
      WHERE created_at < ?
        AND id NOT IN (
          SELECT event_id FROM notification_delivery WHERE status IN ('PENDING', 'SENDING')
          UNION ALL
          SELECT event_id FROM email_delivery WHERE status IN ('PENDING', 'SENDING')
        )
    `, thirtyDaysAgo).toArray();
    deleteEvents(expiredEvents);

    // Keep at most 1,000 events unless outstanding work requires retaining more.
    const count = this.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) as count FROM notification_event"
    ).one().count;

    if (count > 1000) {
      const excessEvents = this.storage.sql.exec<{ id: string }>(`
        SELECT id FROM notification_event
        WHERE id NOT IN (
          SELECT event_id FROM notification_delivery WHERE status IN ('PENDING', 'SENDING')
          UNION ALL
          SELECT event_id FROM email_delivery WHERE status IN ('PENDING', 'SENDING')
        )
        ORDER BY created_at ASC, id ASC
        LIMIT ?
      `, count - 1000).toArray();
      deleteEvents(excessEvents);
    }
  }

  // Delivery drain logic (used by alarm in Phase 3)
  claimDeliveriesForDispatch(maxBatch = 20, leaseDurationMs = 30_000): Array<{
    deliveryId: string;
    eventId: string;
    eventType: NotificationType;
    eventCreatedAt: number;
    eventExpiresAt: number;
    attemptCount: number;
    leaseUntil: number;
    subscription: {
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
      ownerCredentialVersion: number;
    };
  }> {
    const now = Date.now();
    return this.storage.transactionSync(() => {
      // Find candidate deliveries:
      // status = 'PENDING' AND next_attempt_at <= now, OR status = 'SENDING' AND lease_until < now
      const candidates = this.storage.sql.exec<{
        delivery_id: string;
        event_id: string;
        type: string;
        event_created_at: number;
        expires_at: number;
        attempt_count: number;
        sub_id: string;
        endpoint: string;
        p256dh: string;
        auth: string;
        owner_credential_version: number;
        disabled_at: number | null;
      }>(`
        SELECT 
          d.id as delivery_id,
          d.event_id as event_id,
          e.type as type,
          e.created_at as event_created_at,
          e.expires_at as expires_at,
          d.attempt_count as attempt_count,
          s.id as sub_id,
          s.endpoint as endpoint,
          s.p256dh as p256dh,
          s.auth as auth,
          s.owner_credential_version as owner_credential_version,
          s.disabled_at as disabled_at
        FROM notification_delivery d
        JOIN notification_event e ON d.event_id = e.id
        JOIN push_subscription s ON d.subscription_id = s.id
        WHERE (
          (d.status = 'PENDING' AND d.next_attempt_at <= ?)
          OR (d.status = 'SENDING' AND d.lease_until < ?)
        )
        ORDER BY d.next_attempt_at ASC
        LIMIT ?
      `, now, now, maxBatch).toArray();

      const currentCredVersion = this.security.version();
      const claimed: Array<{
        deliveryId: string;
        eventId: string;
        eventType: NotificationType;
        eventCreatedAt: number;
        eventExpiresAt: number;
        attemptCount: number;
        leaseUntil: number;
        subscription: {
          id: string;
          endpoint: string;
          p256dh: string;
          auth: string;
          ownerCredentialVersion: number;
        };
      }> = [];

      for (const row of candidates) {
        // If event expired, or subscription disabled, or credential version mismatch:
        if (row.expires_at <= now || row.disabled_at !== null || row.owner_credential_version !== currentCredVersion) {
          this.storage.sql.exec(
            "UPDATE notification_delivery SET status = 'SUPPRESSED' WHERE id = ?",
            row.delivery_id
          );
          continue;
        }

        // Claim with lease
        this.storage.sql.exec(
          "UPDATE notification_delivery SET status = 'SENDING', lease_until = ? WHERE id = ?",
          now + leaseDurationMs,
          row.delivery_id
        );

        claimed.push({
          deliveryId: row.delivery_id,
          eventId: row.event_id,
          eventType: row.type as NotificationType,
          eventCreatedAt: row.event_created_at,
          eventExpiresAt: row.expires_at,
          attemptCount: row.attempt_count,
          leaseUntil: now + leaseDurationMs,
          subscription: {
            id: row.sub_id,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
            ownerCredentialVersion: row.owner_credential_version,
          },
        });
      }

      return claimed;
    });
  }

  recordDeliveryOutcome(deliveryId: string, subscriptionId: string, result: {
    leaseUntil: number;
    status: "SENT" | "FAILED" | "RETRY";
    statusCode?: number;
    nextAttemptAt?: number;
  } & ({
    disableSubscriptionReason: string;
    subscription: { p256dh: string; auth: string; ownerCredentialVersion: number };
  } | {
    disableSubscriptionReason?: never;
    subscription?: never;
  })): void {
    const now = Date.now();
    this.storage.transactionSync(() => {
      const current = this.storage.sql.exec<{ id: string }>(
        `SELECT id FROM notification_delivery
         WHERE id = ? AND subscription_id = ? AND status = 'SENDING' AND lease_until = ?`,
        deliveryId,
        subscriptionId,
        result.leaseUntil
      ).toArray()[0];
      if (!current) return;

      if (result.disableSubscriptionReason) {
        const disabled = this.storage.sql.exec<{ id: string }>(
          `UPDATE push_subscription SET disabled_at = ?, disabled_reason = ?
           WHERE id = ? AND disabled_at IS NULL AND p256dh = ? AND auth = ?
             AND owner_credential_version = ?
           RETURNING id`,
          now,
          result.disableSubscriptionReason,
          subscriptionId,
          result.subscription.p256dh,
          result.subscription.auth,
          result.subscription.ownerCredentialVersion
        ).toArray()[0];
        if (!disabled) {
          this.storage.sql.exec(
            "UPDATE notification_delivery SET status = 'FAILED', last_status_code = ?, lease_until = 0 WHERE id = ?",
            result.statusCode ?? null,
            deliveryId
          );
          return;
        }
        this.storage.sql.exec(
          "UPDATE notification_delivery SET status = 'SUPPRESSED' WHERE subscription_id = ? AND status IN ('PENDING', 'SENDING')",
          subscriptionId
        );
        return;
      }

      if (result.status === "SENT") {
        this.storage.sql.exec(
          "UPDATE notification_delivery SET status = 'SENT', last_status_code = ?, lease_until = 0 WHERE id = ?",
          result.statusCode ?? 201,
          deliveryId
        );
      } else if (result.status === "RETRY") {
        this.storage.sql.exec(
          `UPDATE notification_delivery 
           SET status = 'PENDING', 
               attempt_count = attempt_count + 1, 
               next_attempt_at = ?, 
               lease_until = 0, 
               last_status_code = ? 
           WHERE id = ?`,
          result.nextAttemptAt ?? (now + 30_000),
          result.statusCode ?? null,
          deliveryId
        );
      } else {
        this.storage.sql.exec(
          "UPDATE notification_delivery SET status = 'FAILED', last_status_code = ?, lease_until = 0 WHERE id = ?",
          result.statusCode ?? null,
          deliveryId
        );
      }
    });
  }

  claimEmailDeliveriesForDispatch(maxBatch = 1, leaseDurationMs = 120_000): ClaimedEmailDelivery[] {
    const now = Date.now();
    return this.storage.transactionSync(() => {
      const candidates = this.storage.sql.exec<{
        delivery_id: string;
        event_id: string;
        entity_id: string;
        reason: EmailAlertReason;
        created_at: number;
        expires_at: number;
        attempt_count: number;
        sender_address: string;
        destination_address: string;
      }>(`
        SELECT d.id AS delivery_id, d.event_id, e.entity_id, d.reason,
               e.created_at, e.expires_at, d.attempt_count,
               d.sender_address, d.destination_address
        FROM email_delivery d
        JOIN notification_event e ON e.id = d.event_id
        WHERE (d.status = 'PENDING' AND d.next_attempt_at <= ?)
           OR (d.status = 'SENDING' AND d.lease_until <= ?)
        ORDER BY d.next_attempt_at ASC, d.id ASC
        LIMIT ?
      `, now, now, maxBatch).toArray();

      if (candidates.length === 0) return [];
      const config = emailAlertConfig(this.env);
      const claimed: ClaimedEmailDelivery[] = [];
      for (const row of candidates) {
        if (row.expires_at <= now || !config
          || (row.reason !== "TEST" && !config.enabled)
          || row.sender_address !== config.sender
          || row.destination_address !== config.recipient) {
          this.storage.sql.exec(
            "UPDATE email_delivery SET status = 'SUPPRESSED', lease_until = 0 WHERE id = ?",
            row.delivery_id
          );
          continue;
        }
        if (row.attempt_count >= 3) {
          this.storage.sql.exec(
            `UPDATE email_delivery SET status = 'FAILED', lease_until = 0,
             last_error_code = COALESCE(last_error_code, 'EMAIL_SEND_FAILED') WHERE id = ?`,
            row.delivery_id
          );
          continue;
        }

        const leaseUntil = now + leaseDurationMs;
        const attemptCount = row.attempt_count + 1;
        this.storage.sql.exec(
          `UPDATE email_delivery SET status = 'SENDING', attempt_count = ?, lease_until = ?
           WHERE id = ?`,
          attemptCount,
          leaseUntil,
          row.delivery_id
        );
        claimed.push({
          deliveryId: row.delivery_id,
          eventId: row.event_id,
          eventEntityId: row.entity_id,
          reason: row.reason,
          eventCreatedAt: row.created_at,
          eventExpiresAt: row.expires_at,
          attemptCount,
          leaseUntil,
          senderAddress: row.sender_address,
          destinationAddress: row.destination_address,
        });
      }
      return claimed;
    });
  }

  recordEmailDeliveryOutcome(deliveryId: string, result: {
    leaseUntil: number;
    status: "SENT" | "FAILED" | "RETRY" | "SUPPRESSED";
    errorCode?: string;
    nextAttemptAt?: number;
  }): void {
    this.storage.transactionSync(() => {
      const current = this.storage.sql.exec<{ attempt_count: number; expires_at: number }>(
        `SELECT d.attempt_count, e.expires_at FROM email_delivery d
         JOIN notification_event e ON e.id = d.event_id
         WHERE d.id = ? AND d.status = 'SENDING' AND d.lease_until = ?`,
        deliveryId,
        result.leaseUntil
      ).toArray()[0];
      if (!current) return;

      const now = Date.now();
      const nextAttemptAt = result.nextAttemptAt ?? (now + 30_000);
      const status = result.status === "RETRY"
        ? current.attempt_count >= 3 || current.expires_at <= Math.max(now, nextAttemptAt)
          ? "FAILED"
          : "PENDING"
        : result.status;
      this.storage.sql.exec(
        `UPDATE email_delivery SET status = ?, lease_until = 0, last_error_code = ?,
         next_attempt_at = CASE WHEN ? = 'PENDING' THEN ? ELSE next_attempt_at END
         WHERE id = ? AND status = 'SENDING' AND lease_until = ?`,
        status,
        result.errorCode ?? null,
        status,
        nextAttemptAt,
        deliveryId,
        result.leaseUntil
      );
    });
  }

  getNextAlarmTime(): number | null {
    const now = Date.now();
    const nextPending = this.storage.sql.exec<{ next_attempt_at: number | null }>(`
      SELECT MIN(next_attempt_at) AS next_attempt_at FROM (
        SELECT next_attempt_at FROM notification_delivery WHERE status = 'PENDING'
        UNION ALL
        SELECT next_attempt_at FROM email_delivery WHERE status = 'PENDING'
      )
    `).toArray()[0]?.next_attempt_at;

    const nextLease = this.storage.sql.exec<{ lease_until: number | null }>(`
      SELECT MIN(lease_until) AS lease_until FROM (
        SELECT lease_until FROM notification_delivery WHERE status = 'SENDING' AND lease_until > 0
        UNION ALL
        SELECT lease_until FROM email_delivery WHERE status = 'SENDING' AND lease_until > 0
      )
    `).toArray()[0]?.lease_until;

    const times = [nextPending, nextLease].filter((t): t is number => typeof t === "number" && t > 0);
    if (times.length === 0) return null;
    return Math.max(now, Math.min(...times));
  }
}

export async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payloadData: { eventId: string; type: NotificationType; createdAt: number },
  vapid: { subject: string; publicKey: string; privateKey: string },
  ttlSeconds: number,
  urgency: "high" | "normal" = "normal"
): Promise<{ status: number; ok: boolean }> {
  const safeTtl = Math.max(1, Math.min(86400, Math.floor(ttlSeconds)));
  const pushPayload = await buildPushPayload(
    {
      data: JSON.stringify(payloadData),
      options: {
        ttl: safeTtl,
        urgency,
      },
    },
    {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    },
    vapid
  );

  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: pushPayload.headers,
    body: pushPayload.body,
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });

  return { status: response.status, ok: response.ok };
}
