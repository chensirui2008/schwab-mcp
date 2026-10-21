import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeBase64Url } from "../src/notifications";
import type { BrowserSession } from "../src/security-store";
import type { SchwabVault } from "../src/vault";

function stub(): DurableObjectStub<SchwabVault> {
  return env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
}

function post(vault: DurableObjectStub, path: string, input: unknown): Promise<Response> {
  return vault.fetch(`https://vault${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

async function saveToken(vault: DurableObjectStub): Promise<void> {
  const response = await vault.fetch("https://vault/token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 1800 }),
  });
  expect(response.status).toBe(204);
}

function scheduledNow(): number {
  const now = Date.now() + 86_400_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  return now;
}

async function subscribe(vault: DurableObjectStub<SchwabVault>) {
  const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const p256dh = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)));
  const auth = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`;
  const sub = await runInDurableObject(vault, (instance: SchwabVault) => instance.notifications.subscribe({
    subscription: { endpoint, keys: { p256dh, auth } },
    label: "Current browser",
  }));
  return { ...sub, endpoint };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SchwabVault OAuth state", () => {
  it("consumes state exactly once", async () => {
    const vault = stub();
    const state = crypto.randomUUID();
    const saved = await vault.fetch("https://vault/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test", payload: { value: 42 }, expiresAt: Date.now() + 60_000 }),
    });
    expect(saved.status).toBe(204);

    const first = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ payload: { value: 42 } });

    const second = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test" }),
    });
    expect(second.status).toBe(400);
  });

  it("rejects expired and mismatched state", async () => {
    const vault = stub();
    const state = crypto.randomUUID();
    await vault.fetch("https://vault/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "expected", payload: {}, expiresAt: Date.now() - 1 }),
    });
    const response = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "wrong" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("SchwabVault token status", () => {
  it("stores token data without returning credentials from status", async () => {
    const vault = stub();
    const saved = await vault.fetch("https://vault/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 1800 }),
    });
    expect(saved.status).toBe(204);
    const response = await vault.fetch("https://vault/status");
    const text = await response.text();
    expect(text).toContain('"connected":true');
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain("refresh-secret");
  });
});

describe("SchwabVault application telemetry privacy", () => {
  it("reports refresh network failures with the caller request ID but no exception or credentials", async () => {
    const vault = stub();
    await saveToken(vault);
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec("UPDATE schwab_token SET access_expires_at = ?", Date.now() - 1);
    });
    const output: unknown[][] = [];
    const capture = (...args: unknown[]) => { output.push(args); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const requestId = crypto.randomUUID();
    const upstream = vi.fn().mockRejectedValue(new Error(
      "private-refresh-network-sentinel https://upstream.example/token?code=private-refresh-query-sentinel refresh-secret",
    ));
    vi.stubGlobal("fetch", upstream);
    const response = await post(vault, "/request", {
      base: "market", path: "/quotes", query: { symbols: "private-refresh-parameter-sentinel" }, requestId, tool: "get_quotes",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "UPSTREAM_UNAVAILABLE", message: "Unable to refresh Schwab authorization", requestId, attempts: 1 },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.schwabapi.com/v1/oauth/token");
    const events = output.flat().filter((line): line is string => typeof line === "string")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([{
      event: "schwab_token_refresh", requestId, status: "network_error", durationMs: expect.any(Number) as unknown,
    }]);
    expect(Number(events[0]?.durationMs)).toBeGreaterThanOrEqual(0);
    expect(await (await vault.fetch("https://vault/status")).json()).toMatchObject({ connected: true });
    const serialized = JSON.stringify(output);
    for (const sensitive of [
      "private-refresh-network-sentinel", "private-refresh-query-sentinel", "private-refresh-parameter-sentinel",
      "access-secret", "refresh-secret", "https://", "errorType", "message",
    ]) expect(serialized).not.toContain(sensitive);
  });

  it("keeps native invalid-JSON exception text and request URLs private without retrying or changing the error outcome", async () => {
    const vault = stub();
    await saveToken(vault);
    const output: unknown[][] = [];
    const capture = (...args: unknown[]) => { output.push(args); };
    vi.spyOn(console, "log").mockImplementation(capture);
    vi.spyOn(console, "warn").mockImplementation(capture);
    vi.spyOn(console, "error").mockImplementation(capture);
    const requestId = crypto.randomUUID();
    // A short invalid body appears verbatim in the native JSON parser's exception.
    const invalidBody = "JSECRET";
    const invalidResponse = new Response(invalidBody, { headers: { "Content-Type": "application/json" } });
    await expect(invalidResponse.clone().json()).rejects.toThrow(invalidBody);
    const upstream = vi.fn().mockResolvedValue(invalidResponse);
    vi.stubGlobal("fetch", upstream);
    const response = await post(vault, "/request", {
      base: "market", path: "/quotes", query: { symbols: "private-invalid-json-parameter-sentinel" }, requestId, tool: "get_quotes",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "UPSTREAM_UNAVAILABLE", message: "Schwab returned an invalid response", requestId, attempts: 1 },
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    const requestedUrl = String(upstream.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain("private-invalid-json-parameter-sentinel");
    const events = output.flat().filter((line): line is string => typeof line === "string")
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      { event: "schwab_api_request", requestId, tool: "get_quotes", method: "GET", status: 200, attempts: 1, durationMs: expect.any(Number) as unknown },
      { event: "schwab_response_invalid", requestId, tool: "get_quotes" },
    ]);
    expect(Number(events[0]?.durationMs)).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(output);
    for (const sensitive of [invalidBody, "private-invalid-json-parameter-sentinel", requestedUrl, "access-secret", "refresh-secret", "https://", "message"]) {
      expect(serialized).not.toContain(sensitive);
    }
  });
});

describe("SchwabVault unified alarm recovery", () => {
  it("migrates a connected pre-upgrade token and schedules its reminder without a trade", async () => {
    const vault = stub();
    const now = scheduledNow();
    const expiry = now + 7 * 86_400_000;
    await runInDurableObject(vault, async (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE schwab_token DROP COLUMN authorization_generation");
      state.storage.sql.exec("ALTER TABLE schwab_token DROP COLUMN reminder_sent");
      state.storage.sql.exec(
        "INSERT INTO schwab_token (id, access_token, refresh_token, access_expires_at, refresh_expires_at, status, updated_at) VALUES (1, ?, ?, ?, ?, 'connected', ?)",
        "legacy-access", "legacy-refresh", now + 1_800_000, expiry, now,
      );
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(vault);

    expect(await (await vault.fetch("https://vault/status")).json()).toMatchObject({ connected: true });
    await runInDurableObject(vault, async (_instance, state) => {
      const token = state.storage.sql.exec<{ authorization_generation: string; reminder_sent: number }>("SELECT authorization_generation, reminder_sent FROM schwab_token").one();
      expect(token.authorization_generation).toBeTruthy();
      expect(token.reminder_sent).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM delayed_trade").one().count).toBe(0);
      expect(await state.storage.getAlarm()).toBe(expiry - 86_400_000);
    });
  });

  it("preserves an earlier pending alarm across re-instantiation", async () => {
    const vault = stub();
    const earlier = scheduledNow() + 60_000;
    await saveToken(vault);
    await runInDurableObject(vault, (_instance, state) => state.storage.setAlarm(earlier));
    await evictDurableObject(vault);

    expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).toBe(earlier);
  });

  it("recovers the earliest delayed-trade deadline instead of postponing it to the token reminder", async () => {
    const vault = stub();
    const now = scheduledNow();
    await saveToken(vault);
    await runInDurableObject(vault, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO delayed_trade
         (id, version, action, account_hash, order_json, condition_json, valid_until, poll_interval_seconds,
          intent_digest, instruction_digest, status, next_check_at, created_at, updated_at)
         VALUES ('recover-task', 1, 'PLACE', ?, '{}', ?, ?, 15, 'intent', 'instruction', 'ACTIVE', ?, ?, ?)`,
        "a".repeat(32), JSON.stringify({ type: "TIME", operator: "AFTER", at: new Date(now + 120_000).toISOString() }),
        now + 30_000, now + 60_000, now, now,
      );
      state.storage.sql.exec("UPDATE delayed_trade SET client_id = 'recovery-client' WHERE id = 'recover-task'");
      state.storage.sql.exec("INSERT INTO client_accounts (client_id, hashes) VALUES (?, ?)", "recovery-client", JSON.stringify(["a".repeat(32)]));
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(vault);

    expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).toBe(now + 30_000);
  });

  it("continues expiry and push maintenance while trading is disabled", async () => {
    const vault = stub();
    const now = scheduledNow();
    await saveToken(vault);
    await subscribe(vault);
    const push = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", push);
    await runInDurableObject(vault, async (instance: SchwabVault, state) => {
      const runtimeEnv: unknown = Reflect.get(instance, "env");
      if (runtimeEnv === null || typeof runtimeEnv !== "object") throw new Error("Missing runtime environment");
      const enabled: unknown = Reflect.get(runtimeEnv, "ENABLE_TRADING");
      Reflect.set(runtimeEnv, "ENABLE_TRADING", "false");
      try {
        state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", now - 1);
        for (const [id, validUntil] of [["disabled-active", now + 60_000], ["disabled-expired", now - 1]] as const) {
          state.storage.sql.exec(
            `INSERT INTO delayed_trade
             (id, version, action, account_hash, order_json, condition_json, valid_until, poll_interval_seconds,
              intent_digest, instruction_digest, status, next_check_at, created_at, updated_at)
             VALUES (?, 1, 'PLACE', ?, '{}', ?, ?, 15, 'intent', 'instruction', 'ACTIVE', ?, ?, ?)`,
            id, "a".repeat(32), JSON.stringify({ type: "TIME", operator: "AFTER", at: new Date(now - 1).toISOString() }),
            validUntil, now - 1, now, now,
          );
        }
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT id, status FROM delayed_trade ORDER BY id").toArray()).toEqual([
          { id: "disabled-active", status: "ACTIVE" }, { id: "disabled-expired", status: "EXPIRED" },
        ]);
        expect(state.storage.sql.exec("SELECT e.type, d.status FROM notification_event e JOIN notification_delivery d ON d.event_id = e.id").toArray()).toEqual([
          { type: "SCHWAB_REAUTH_REQUIRED", status: "SENT" },
        ]);
        expect(await state.storage.getAlarm()).toBe(now + 15 * 60_000);
      } finally {
        Reflect.set(runtimeEnv, "ENABLE_TRADING", enabled);
      }
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("restores the dispatch lease alarm without resetting an in-flight delivery", async () => {
    const vault = stub();
    scheduledNow();
    await subscribe(vault);
    const claim = await runInDurableObject(vault, async (instance: SchwabVault, state) => {
      instance.notifications.recordEvent({ dedupeKey: "lease-recovery", type: "CLIENT_AUTHORIZED", entityId: "client", summary: "Authorized" });
      const [claimed] = instance.notifications.claimDeliveriesForDispatch(1, 60_000);
      expect(claimed).toBeDefined();
      await state.storage.deleteAlarm();
      return claimed;
    });
    if (!claim) throw new Error("Missing dispatch claim");
    await evictDurableObject(vault);

    await runInDurableObject(vault, async (_instance, state) => {
      const delivery = state.storage.sql.exec<{ status: string; lease_until: number }>("SELECT status, lease_until FROM notification_delivery WHERE id = ?", claim.deliveryId).one();
      expect(delivery).toEqual({ status: "SENDING", lease_until: claim.leaseUntil });
      expect(await state.storage.getAlarm()).toBe(claim.leaseUntil);
    });
  });
});

describe("SchwabVault notification producers", () => {
  it("schedules and delivers CLIENT_AUTHORIZED when finalization starts with no alarm", async () => {
    const vault = stub();
    const now = scheduledNow();
    await subscribe(vault);
    const intent = {
      authRequest: { clientId: "authorized-client", redirectUri: "https://client.example/callback", responseType: "code", scope: ["schwab.read"], state: "test", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" },
      permissionLevel: "read_only", advancedSecurity: false, username: "owner", policyVersion: 0,
    };
    const begun = await (await post(vault, "/security/authorization/begin", { intent, clientName: "Client", currentAdvanced: false })).json<{ authorizationId: string; sessionId: string }>();
    const { session } = await (await post(vault, "/security/session", { sessionId: begun.sessionId })).json<{ session: BrowserSession }>();
    const claim = await (await post(vault, "/security/authorization/claim", { authorizationId: begun.authorizationId, sessionId: begun.sessionId, csrf: session.csrf })).json<{ commitTicket: string; finishingId: string }>();
    expect((await post(vault, "/security/commit-policy", { clientId: intent.authRequest.clientId, permissionLevel: "read_only", advancedSecurity: false, expected: 0, ticket: claim.commitTicket })).status).toBe(200);
    expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).toBeNull();

    const finalized = await post(vault, "/security/authorization/finalize", {
      authorizationId: begun.authorizationId, finishingId: claim.finishingId,
      originalSessionId: begun.sessionId, authorizationEventId: crypto.randomUUID(),
    });
    expect(finalized.status).toBe(200);
    expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).toBe(now + 250);
    const push = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", push);
    expect(await runDurableObjectAlarm(vault)).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec(
      "SELECT e.type, d.status FROM notification_event e JOIN notification_delivery d ON d.event_id = e.id",
    ).toArray())).toEqual([{ type: "CLIENT_AUTHORIZED", status: "SENT" }]);
  });

  it.each(["status", "expired-request", "invalid-grant"])("schedules SCHWAB_REAUTH_REQUIRED from %s with no prior alarm", async trigger => {
    const vault = stub();
    const now = scheduledNow();
    await saveToken(vault);
    await subscribe(vault);
    await runInDurableObject(vault, async (_instance, state) => {
      state.storage.sql.exec("UPDATE schwab_token SET access_expires_at = ?, refresh_expires_at = ?", now - 1, trigger === "invalid-grant" ? now + 7 * 86_400_000 : now - 1);
      await state.storage.deleteAlarm();
    });
    const refresh = vi.fn(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    vi.stubGlobal("fetch", refresh);
    const response = trigger === "status"
      ? await vault.fetch("https://vault/status")
      : await post(vault, "/request", { base: "market", path: "/quotes", query: { symbols: "AAPL" }, requestId: crypto.randomUUID(), tool: "get_quotes" });
    expect(response.status).toBe(trigger === "status" ? 200 : 401);
    expect(refresh).toHaveBeenCalledTimes(trigger === "invalid-grant" ? 1 : 0);
    expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).toBe(now + 250);

    const push = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", push);
    expect(await runDurableObjectAlarm(vault)).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec(
      "SELECT e.type, d.status FROM notification_event e JOIN notification_delivery d ON d.event_id = e.id",
    ).toArray())).toEqual([{ type: "SCHWAB_REAUTH_REQUIRED", status: "SENT" }]);
  });
});

describe("SchwabVault current-browser subscription lookup", () => {
  it("requires a dashboard session and CSRF and returns only matching public subscription metadata", async () => {
    const vault = stub();
    const sub = await subscribe(vault);
    const browser = await (await post(vault, "/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
    const lookup = (input: unknown, overrides: Record<string, unknown> = {}) => post(vault, "/notifications/subscription", {
      sessionId: browser.sessionId, csrf: browser.session.csrf, input, ...overrides,
    });
    expect(await (await lookup({ endpoint: sub.endpoint })).json()).toEqual({
      subscription: { id: sub.id, label: "Current browser", active: true },
    });
    expect(await (await lookup({ endpoint: `${sub.endpoint}-unknown` })).json()).toEqual({ subscription: null });
    expect((await lookup({ endpoint: sub.endpoint }, { csrf: "wrong" })).status).toBe(403);
    expect((await lookup({ endpoint: sub.endpoint }, { sessionId: "missing" })).status).toBe(403);
    expect((await post(vault, "/notifications/subscription", { sessionId: browser.sessionId, input: { endpoint: sub.endpoint } })).status).toBe(400);
    expect((await vault.fetch("https://vault/notifications/subscription")).status).toBe(400);
    const recovery = await (await post(vault, "/security/session/create", { recovery: true })).json<{ sessionId: string; session: BrowserSession }>();
    expect((await lookup({ endpoint: sub.endpoint }, { sessionId: recovery.sessionId, csrf: recovery.session.csrf })).status).toBe(403);
    const pending = await (await post(vault, "/security/session/create", { pendingAuthorizationId: "pending-client" })).json<{ sessionId: string; session: BrowserSession }>();
    expect((await lookup({ endpoint: sub.endpoint }, { sessionId: pending.sessionId, csrf: pending.session.csrf })).status).toBe(403);
    expect((await post(vault, "/notifications/unsubscribe", { sessionId: browser.sessionId, csrf: browser.session.csrf, input: { id: sub.id } })).status).toBe(200);
    expect(await (await lookup({ endpoint: sub.endpoint })).json()).toEqual({
      subscription: { id: sub.id, label: "Current browser", active: false },
    });
  });
});
