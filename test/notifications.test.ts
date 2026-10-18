import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import { vaultStub } from "../src/env";
import { decodeBase64Url, encodeBase64Url, validateSubscriptionInput } from "../src/notifications";

const origin = "https://example.com";

function setup() {
  return { ...env } as unknown as AppEnv;
}

async function dispatch(request: Request, appEnv: AppEnv) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, appEnv, ctx);
  const body = response.body === null ? null : await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function cookie(response: Response, name: string) {
  return response.headers.get("set-cookie")?.match(new RegExp(`${name}=([^;]+)`))?.[0] ?? "";
}

async function login(appEnv: AppEnv, path = "/dashboard") {
  const start = await dispatch(new Request(`${origin}${path}`), appEnv);
  expect(start.status).toBe(302);
  const github = new URL(start.headers.get("location") ?? "");
  const githubFetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: "fake-dashboard-github-token" }))
    .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null }));
  vi.stubGlobal("fetch", githubFetch);
  const callback = await dispatch(new Request(`${origin}/auth/github/callback?state=${github.searchParams.get("state") ?? ""}&code=fake-code`, {
    headers: { Cookie: cookie(start, "__Host-schwab-oauth") },
  }), appEnv);
  vi.unstubAllGlobals();
  expect(callback.status).toBe(302);
  const securityCookie = cookie(callback, "__Host-schwab-security");
  expect(securityCookie).toBeTruthy();

  // Fetch dashboard to get csrf
  const page = await dispatch(new Request(`${origin}/dashboard`, { headers: { Cookie: securityCookie } }), appEnv);
  const text = await page.text();
  const csrf = text.match(/name="csrf" content="([^"]+)"/)?.[1] ?? "";
  expect(csrf).toBeTruthy();

  return { securityCookie, csrf };
}

// Generate valid test keys
async function generateTestKeys(): Promise<{ p256dh: string; auth: string }> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const rawPublic = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const p256dh = encodeBase64Url(new Uint8Array(rawPublic));
  const auth = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  return { p256dh, auth };
}

describe("NotificationStore & Push Endpoints", () => {
  it("validates push subscriptions strictly", async () => {
    const { p256dh, auth } = await generateTestKeys();

    // Valid FCM endpoint
    const validFcm = validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com/fcm/send/device-123",
      keys: { p256dh, auth },
    }, "My Chrome");
    expect(validFcm.endpoint).toBe("https://fcm.googleapis.com/fcm/send/device-123");
    expect(validFcm.label).toBe("My Chrome");

    // Valid Apple endpoint
    const validApple = validateSubscriptionInput({
      endpoint: "https://web.push.apple.com/QIx61abc",
      keys: { p256dh, auth },
    }, "iPhone PWA");
    expect(validApple.endpoint).toBe("https://web.push.apple.com/QIx61abc");

    // Invalid: HTTP protocol
    expect(() => validateSubscriptionInput({
      endpoint: "http://fcm.googleapis.com/fcm/send/123",
      keys: { p256dh, auth },
    }, "Label")).toThrow("HTTPS");

    // Invalid: non-allowed host
    expect(() => validateSubscriptionInput({
      endpoint: "https://evil.example.com/push",
      keys: { p256dh, auth },
    }, "Label")).toThrow("host is not supported");

    // Invalid: custom port
    expect(() => validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com:8443/fcm/send/123",
      keys: { p256dh, auth },
    }, "Label")).toThrow("default HTTPS port");

    // Invalid: userinfo
    expect(() => validateSubscriptionInput({
      endpoint: "https://user:pass@fcm.googleapis.com/fcm/send/123",
      keys: { p256dh, auth },
    }, "Label")).toThrow("user credentials");

    // Invalid: fragment
    expect(() => validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com/fcm/send/123#fragment",
      keys: { p256dh, auth },
    }, "Label")).toThrow("hash fragment");

    // Invalid: invalid p256dh (not 65 bytes)
    expect(() => validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com/fcm/send/123",
      keys: { p256dh: "abcd", auth },
    }, "Label")).toThrow("Invalid P-256 public key");

    // Invalid: invalid auth (not 16 bytes)
    expect(() => validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com/fcm/send/123",
      keys: { p256dh, auth: "abcd" },
    }, "Label")).toThrow("Invalid auth secret");

    // Invalid: empty or oversized label
    expect(() => validateSubscriptionInput({
      endpoint: "https://fcm.googleapis.com/fcm/send/123",
      keys: { p256dh, auth },
    }, "   ")).toThrow("1 to 80 characters");
  });

  it("handles push config and subscription APIs via dashboard", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const { p256dh, auth } = await generateTestKeys();

    // 1. Get VAPID config
    const configRes = await dispatch(new Request(`${origin}/dashboard/api/push/config`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(configRes.status).toBe(200);
    const { publicKey } = await configRes.json<{ publicKey: string }>();
    expect(publicKey).toBeTruthy();
    expect(typeof publicKey).toBe("string");
    // Decode public key and verify 65-byte uncompressed point
    const pkBytes = decodeBase64Url(publicKey);
    expect(pkBytes.length).toBe(65);
    expect(pkBytes[0]).toBe(0x04);

    // 2. Subscribe a new device
    const subRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: {
        Cookie: securityCookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({
        subscription: {
          endpoint: "https://web.push.apple.com/sub-001",
          expirationTime: null,
          keys: { p256dh, auth },
        },
        label: "iPhone 16",
      }),
    }), appEnv);
    expect(subRes.status).toBe(200);
    const sub = await subRes.json<{ id: string; label: string; createdAt: number }>();
    expect(sub.id).toBeTruthy();
    expect(sub.label).toBe("iPhone 16");

    // 3. List subscriptions (verify no private keys or endpoints leaked)
    const listRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscriptions`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ items: Array<{ id: string; label: string; active: boolean }> }>();
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const found = list.items.find(i => i.id === sub.id);
    expect(found).toMatchObject({ id: sub.id, label: "iPhone 16", active: true });
    // Check that endpoint or keys are NOT present in output
    expect(Reflect.has(found ?? {}, "endpoint")).toBe(false);
    expect(Reflect.has(found ?? {}, "p256dh")).toBe(false);
    expect(Reflect.has(found ?? {}, "auth")).toBe(false);

    const lookupRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/sub-001" }),
    }), appEnv);
    expect(lookupRes.status).toBe(200);
    expect(await lookupRes.json()).toEqual({
      subscription: { id: sub.id, label: "iPhone 16", active: true },
    });
    const missingLookup = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/not-saved" }),
    }), appEnv);
    expect(missingLookup.status).toBe(200);
    expect(await missingLookup.json()).toEqual({ subscription: null });

    // 4. Test notification with rate limiting
    const testRes1 = await dispatch(new Request(`${origin}/dashboard/api/push/test`, {
      method: "POST",
      headers: {
        Cookie: securityCookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);
    expect(testRes1.status).toBe(200);
    const testResult = await testRes1.json<{ id: string }>();
    expect(testResult.id).toBeTruthy();

    // Immediate second test notification -> RATE_LIMITED (429)
    const testRes2 = await dispatch(new Request(`${origin}/dashboard/api/push/test`, {
      method: "POST",
      headers: {
        Cookie: securityCookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);
    expect(testRes2.status).toBe(429);
    const err = await testRes2.json<{ error: { code: string; message: string } }>();
    expect(err.error.code).toBe("RATE_LIMITED");

    // 5. Unsubscribe
    const unsubRes = await dispatch(new Request(`${origin}/dashboard/api/push/unsubscribe`, {
      method: "POST",
      headers: {
        Cookie: securityCookie,
        Origin: origin,
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);
    expect(unsubRes.status).toBe(200);
    expect((await unsubRes.json<{ unsubscribed: boolean }>()).unsubscribed).toBe(true);

    // After unsubscribe, list shows active: false
    const listResAfter = await dispatch(new Request(`${origin}/dashboard/api/push/subscriptions`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    const listAfter = await listResAfter.json<{ items: Array<{ id: string; active: boolean }> }>();
    expect(listAfter.items.find(i => i.id === sub.id)?.active).toBe(false);
    const disabledLookup = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/sub-001" }),
    }), appEnv);
    expect(disabledLookup.status).toBe(200);
    expect(await disabledLookup.json()).toEqual({
      subscription: { id: sub.id, label: "iPhone 16", active: false },
    });
  });

  it("enforces authentication and boundaries on push APIs", async () => {
    const appEnv = setup();
    const { p256dh, auth } = await generateTestKeys();

    // Unauthenticated GET
    const unauthGet = await dispatch(new Request(`${origin}/dashboard/api/push/config`), appEnv);
    expect(unauthGet.status).toBe(403);

    // Unauthenticated POST
    const unauthPost = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ subscription: { endpoint: "https://web.push.apple.com/sub", keys: { p256dh, auth } }, label: "Test" }),
    }), appEnv);
    expect(unauthPost.status).toBe(403);
    const unauthLookup = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/sub" }),
    }), appEnv);
    expect(unauthLookup.status).toBe(403);

    // Wrong origin POST
    const { securityCookie, csrf } = await login(appEnv);
    const wrongOrigin = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: "https://evil.example.com", "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ subscription: { endpoint: "https://web.push.apple.com/sub", keys: { p256dh, auth } }, label: "Test" }),
    }), appEnv);
    expect(wrongOrigin.status).toBe(403);
    const missingCsrfLookup = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/sub" }),
    }), appEnv);
    expect(missingCsrfLookup.status).toBe(403);
    const wrongOriginLookup = await dispatch(new Request(`${origin}/dashboard/api/push/subscription`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: "https://evil.example.com", "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ endpoint: "https://web.push.apple.com/sub" }),
    }), appEnv);
    expect(wrongOriginLookup.status).toBe(403);

    // Invalid body size (>64KiB)
    const largeBody = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ subscription: { endpoint: "https://web.push.apple.com/sub", keys: { p256dh, auth } }, label: "Test", padding: "A".repeat(70_000) }),
    }), appEnv);
    expect(largeBody.status).toBe(413);
  });

  it("delivers push notifications during alarm and updates delivery status", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const { p256dh, auth } = await generateTestKeys();

    // Subscribe
    const subRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        subscription: { endpoint: "https://web.push.apple.com/alarm-test-sub", expirationTime: null, keys: { p256dh, auth } },
        label: "Alarm Test Device",
      }),
    }), appEnv);
    expect(subRes.status).toBe(200);
    const sub = await subRes.json<{ id: string }>();

    // Trigger test event
    const testRes = await dispatch(new Request(`${origin}/dashboard/api/push/test`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);
    expect(testRes.status).toBe(200);

    // Mock fetch for push endpoint
    let pushedEndpoint: string | undefined;
    let pushedHeaders: Headers | undefined;
    let pushedBody: Uint8Array | undefined;
    const pushFetch = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://web.push.apple.com/alarm-test-sub") {
        pushedEndpoint = url;
        pushedHeaders = new Headers(init?.headers);
        pushedBody = init?.body as Uint8Array;
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.stubGlobal("fetch", pushFetch);
    const vault = vaultStub(appEnv);
    await runDurableObjectAlarm(vault);
    vi.unstubAllGlobals();

    expect(pushFetch).toHaveBeenCalled();
    expect(pushedEndpoint).toBe("https://web.push.apple.com/alarm-test-sub");
    expect(pushedHeaders?.get("content-encoding")).toBe("aes128gcm");
    expect(pushedHeaders?.get("authorization")).toMatch(/^(vapid|WebPush)\s+/i);
    expect(pushedBody).toBeTruthy();
  });

  it("handles 410 Gone from push service by disabling the subscription", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const { p256dh, auth } = await generateTestKeys();

    const subRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        subscription: { endpoint: "https://web.push.apple.com/gone-sub", expirationTime: null, keys: { p256dh, auth } },
        label: "Gone Device",
      }),
    }), appEnv);
    const sub = await subRes.json<{ id: string }>();

    await dispatch(new Request(`${origin}/dashboard/api/push/test`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);

    // Mock 410 response from push service
    const pushFetch = vi.fn().mockResolvedValue(new Response(null, { status: 410 }));
    vi.stubGlobal("fetch", pushFetch);

    const vault = vaultStub(appEnv);
    await runDurableObjectAlarm(vault);
    vi.unstubAllGlobals();

    // Subscription should now be disabled
    const listRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscriptions`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    const list = await listRes.json<{ items: Array<{ id: string; active: boolean }> }>();
    expect(list.items.find(i => i.id === sub.id)?.active).toBe(false);
  });

  it("generates SCHWAB_REAUTH_DUE_SOON 24 hours before expiration and SCHWAB_REAUTH_REQUIRED on expiration", async () => {
    const appEnv = setup();
    const vault = vaultStub(appEnv);

    const now = Date.now();
    // 1. Initial save token (expires in 7 days)
    await vault.fetch(new Request("https://vault/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 1800 }),
    }));

    // Get initial generation
    const initialToken = await runInDurableObject(vault, (instance, state) => {
      return state.storage.sql.exec<{ authorization_generation: string; reminder_sent: number }>("SELECT authorization_generation, reminder_sent FROM schwab_token WHERE id = 1").one();
    });
    expect(initialToken.authorization_generation).toBeTruthy();
    expect(initialToken.reminder_sent).toBe(0);

    // 2. Adjust refresh_expires_at to 12 hours from now (within 24h window)
    const dueSoonExpiry = now + 12 * 60 * 60 * 1000;
    await runInDurableObject(vault, (instance, state) => {
      state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", dueSoonExpiry);
    });

    // Run alarm
    await runDurableObjectAlarm(vault);

    // Verify SCHWAB_REAUTH_DUE_SOON event created
    const listRes1 = await vault.fetch(new Request("https://vault/notifications/list"));
    const notifs1 = await listRes1.json<{ items: Array<{ type: string; dedupeKey: string }> }>();
    const dueSoon = notifs1.items.find(i => i.type === "SCHWAB_REAUTH_DUE_SOON");
    expect(dueSoon).toBeDefined();
    expect(dueSoon?.dedupeKey).toBe(`schwab_reauth_due_soon:${initialToken.authorization_generation}`);

    // Run alarm again -> reminder_sent is 1, so no duplicate event
    await runDurableObjectAlarm(vault);
    const listRes2 = await vault.fetch(new Request("https://vault/notifications/list"));
    const notifs2 = await listRes2.json<{ items: Array<{ type: string; dedupeKey: string }> }>();
    const dueSoonCount = notifs2.items.filter(i => i.type === "SCHWAB_REAUTH_DUE_SOON").length;
    expect(dueSoonCount).toBe(1);

    // 3. Adjust refresh_expires_at to past (expired)
    await runInDurableObject(vault, (instance, state) => {
      state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", now - 1000);
    });

    // Run alarm
    await runDurableObjectAlarm(vault);

    // Verify SCHWAB_REAUTH_REQUIRED event created
    const listRes3 = await vault.fetch(new Request("https://vault/notifications/list"));
    const notifs3 = await listRes3.json<{ items: Array<{ type: string; dedupeKey: string }> }>();
    const reauthReq = notifs3.items.find(i => i.type === "SCHWAB_REAUTH_REQUIRED");
    expect(reauthReq).toBeDefined();
    expect(reauthReq?.dedupeKey).toBe(`schwab_reauth_required:${initialToken.authorization_generation}`);

    // Token status should be reauthorization_required
    const statusRes = await vault.fetch(new Request("https://vault/status"));
    const statusJson = await statusRes.json<{ status: string; connected: boolean }>();
    expect(statusJson.status).toBe("reauthorization_required");
    expect(statusJson.connected).toBe(false);

    // 4. Re-authorize with new token
    await vault.fetch(new Request("https://vault/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }),
    }));

    const newToken = await runInDurableObject(vault, (instance, state) => {
      return state.storage.sql.exec<{ authorization_generation: string; reminder_sent: number }>("SELECT authorization_generation, reminder_sent FROM schwab_token WHERE id = 1").one();
    });
    expect(newToken.authorization_generation).not.toBe(initialToken.authorization_generation);
    expect(newToken.reminder_sent).toBe(0);
  });

  it("prunes deliveries before events only beyond the 30-day boundary", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance, state) => {
      const now = 2_000_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const sub = instance.notifications.subscribe({
          subscription: { endpoint: "https://web.push.apple.com/retention-age", keys },
          label: "Retention",
        });
        const cutoff = now - 30 * 24 * 60 * 60 * 1000;
        const seed = (id: string, createdAt: number, status: string) => {
          state.storage.sql.exec(
            "INSERT INTO notification_event VALUES (?, ?, 'TEST', ?, 'Retention event', ?, ?, NULL)",
            id, id, id, createdAt, now + 60_000
          );
          state.storage.sql.exec(
            "INSERT INTO notification_delivery VALUES (?, ?, ?, ?, 0, ?, ?, NULL)",
            `${id}-delivery`, id, sub.id, status, now, status === "SENDING" ? now + 30_000 : 0
          );
        };
        for (const status of ["SENT", "FAILED", "SUPPRESSED"]) seed(status, cutoff - 1, status);
        seed("boundary", cutoff, "SENT");
        seed("pending", cutoff - 1, "PENDING");
        seed("sending", cutoff - 1, "SENDING");
        const fresh = instance.notifications.recordEvent({
          dedupeKey: "age-fresh", type: "TEST", entityId: "fresh", summary: "Fresh",
        });
        if (!fresh) throw new Error("Missing fresh notification");
        for (const id of ["SENT", "FAILED", "SUPPRESSED"]) {
          expect(instance.notifications.getEvent(id)).toBeNull();
          expect(state.storage.sql.exec("SELECT id FROM notification_delivery WHERE event_id = ?", id).toArray()).toEqual([]);
        }
        for (const id of ["boundary", "pending", "sending", fresh.id]) {
          expect(instance.notifications.getEvent(id)?.id).toBe(id);
        }
        expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);

        clock.mockReturnValue(now + 1);
        const next = instance.notifications.recordEvent({
          dedupeKey: "age-next", type: "TEST", entityId: "next", summary: "Next",
        });
        expect(next).not.toBeNull();
        expect(instance.notifications.getEvent("boundary")).toBeNull();
        expect(instance.notifications.getEvent("pending")?.id).toBe("pending");
        expect(instance.notifications.getEvent("sending")?.id).toBe("sending");
        expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("accepts new events at the 1,000-event cap while protecting outstanding deliveries", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance, state) => {
      const now = 2_000_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const sub = instance.notifications.subscribe({
          subscription: { endpoint: "https://web.push.apple.com/retention-cap", keys },
          label: "Retention",
        });
        state.storage.transactionSync(() => {
          state.storage.sql.exec(`
            WITH RECURSIVE sequence(n) AS (
              SELECT 0 UNION ALL SELECT n + 1 FROM sequence WHERE n < 998
            )
            INSERT INTO notification_event
            SELECT 'cap-' || n, 'cap-' || n, 'TEST', 'cap-' || n, 'History', ? + n, ?, NULL
            FROM sequence
          `, now - 1000, now + 60_000);
          state.storage.sql.exec(`
            INSERT INTO notification_delivery
            SELECT id || '-delivery', id, ?,
              CASE id WHEN 'cap-0' THEN 'PENDING' WHEN 'cap-1' THEN 'SENDING' ELSE 'SENT' END,
              0, ?, CASE id WHEN 'cap-1' THEN ? ELSE 0 END, NULL
            FROM notification_event
          `, sub.id, now, now + 30_000);
        });
        const atCap = instance.notifications.recordEvent({
          dedupeKey: "at-cap", type: "TEST", entityId: "at-cap", summary: "At cap",
        });
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM notification_event"
        ).one().count).toBe(1000);
        expect(instance.notifications.getEvent("cap-2")?.id).toBe("cap-2");

        clock.mockReturnValue(now + 1);
        const beyondCap = instance.notifications.recordEvent({
          dedupeKey: "beyond-cap", type: "TEST", entityId: "beyond-cap", summary: "Beyond cap",
        });
        if (!atCap || !beyondCap) throw new Error("Missing retention boundary notifications");
        expect(state.storage.sql.exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM notification_event"
        ).one().count).toBe(1000);
        expect(instance.notifications.getEvent("cap-2")).toBeNull();
        expect(state.storage.sql.exec(
          "SELECT id FROM notification_delivery WHERE event_id = 'cap-2'"
        ).toArray()).toEqual([]);
        for (const id of ["cap-0", "cap-1", "cap-3", atCap.id, beyondCap.id]) {
          expect(instance.notifications.getEvent(id)?.id).toBe(id);
        }
        expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });
  });

  it.each(["TRADE_APPROVAL_PENDING", "CLIENT_AUTHORIZATION_PENDING"] as const)(
    "does not retry a resolved %s notification after an in-flight send",
    async type => {
      const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
      const keys = await generateTestKeys();
      await runInDurableObject(vault, instance => {
        const now = 2_000_000_000_000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        try {
          instance.notifications.subscribe({
            subscription: { endpoint: "https://web.push.apple.com/resolved", keys }, label: "Resolved",
          });
          instance.notifications.recordEvent({
            dedupeKey: "approval", type, entityId: "approval-entity", summary: "Approval",
          });
          const [claimed] = instance.notifications.claimDeliveriesForDispatch();
          if (!claimed) throw new Error("Missing pending approval delivery");
          instance.notifications.suppressPendingDeliveriesForEntity("approval-entity");
          instance.notifications.recordDeliveryOutcome(claimed.deliveryId, claimed.subscription.id, {
            leaseUntil: claimed.leaseUntil, status: "RETRY", statusCode: 503, nextAttemptAt: now + 30_000,
          });
          clock.mockReturnValue(now + 60_000);
          expect(instance.notifications.claimDeliveriesForDispatch()).toEqual([]);
          expect(instance.notifications.getNextAlarmTime()).toBeNull();
        } finally {
          clock.mockRestore();
        }
      });
    }
  );

  it.each(["SENT", "FAILED"] as const)("does not overwrite a terminal %s delivery with a retry", async status => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance, state) => {
      instance.notifications.subscribe({
        subscription: { endpoint: "https://web.push.apple.com/terminal", keys }, label: "Terminal",
      });
      instance.notifications.recordEvent({
        dedupeKey: "terminal", type: "TEST", entityId: "terminal", summary: "Terminal",
      });
      const [claimed] = instance.notifications.claimDeliveriesForDispatch();
      if (!claimed) throw new Error("Missing terminal delivery claim");
      instance.notifications.recordDeliveryOutcome(claimed.deliveryId, claimed.subscription.id, {
        leaseUntil: claimed.leaseUntil, status,
      });
      instance.notifications.recordDeliveryOutcome(claimed.deliveryId, claimed.subscription.id, {
        leaseUntil: claimed.leaseUntil, status: "RETRY",
      });
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM notification_delivery WHERE id = ?", claimed.deliveryId
      ).one().status).toBe(status);
      expect(instance.notifications.claimDeliveriesForDispatch()).toEqual([]);
    });
  });

  it("ignores outcomes for an expired lease after the delivery is reclaimed", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance, state) => {
      const now = 2_000_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        instance.notifications.subscribe({
          subscription: { endpoint: "https://web.push.apple.com/stale-lease", keys }, label: "Lease",
        });
        instance.notifications.recordEvent({
          dedupeKey: "lease", type: "TEST", entityId: "lease", summary: "Lease",
        });
        const [oldClaim] = instance.notifications.claimDeliveriesForDispatch();
        if (!oldClaim) throw new Error("Missing original delivery lease");
        clock.mockReturnValue(now + 30_001);
        const [currentClaim] = instance.notifications.claimDeliveriesForDispatch();
        if (!currentClaim) throw new Error("Missing reclaimed delivery lease");
        expect(currentClaim.deliveryId).toBe(oldClaim.deliveryId);
        expect(currentClaim.leaseUntil).not.toBe(oldClaim.leaseUntil);
        instance.notifications.recordDeliveryOutcome(oldClaim.deliveryId, oldClaim.subscription.id, {
          leaseUntil: oldClaim.leaseUntil, status: "RETRY",
        });
        expect(state.storage.sql.exec<{ status: string; lease_until: number }>(
          "SELECT status, lease_until FROM notification_delivery WHERE id = ?", currentClaim.deliveryId
        ).one()).toMatchObject({ status: "SENDING", lease_until: currentClaim.leaseUntil });
        instance.notifications.recordDeliveryOutcome(currentClaim.deliveryId, currentClaim.subscription.id, {
          leaseUntil: currentClaim.leaseUntil, status: "SENT",
        });
        expect(instance.notifications.getNextAlarmTime()).toBeNull();
      } finally {
        clock.mockRestore();
      }
    });
  });

  it("does not disable renewed subscription keys from an old 410 response", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    const replacementKeys = await generateTestKeys();
    await runInDurableObject(vault, instance => {
      const endpoint = "https://web.push.apple.com/renewed";
      const sub = instance.notifications.subscribe({ subscription: { endpoint, keys }, label: "Original" });
      instance.notifications.recordEvent({
        dedupeKey: "old", type: "TEST", entityId: "old", summary: "Old",
      });
      const [claimed] = instance.notifications.claimDeliveriesForDispatch();
      if (!claimed) throw new Error("Missing original subscription delivery");
      instance.notifications.subscribe({ subscription: { endpoint, keys: replacementKeys }, label: "Renewed" });
      instance.notifications.recordDeliveryOutcome(claimed.deliveryId, claimed.subscription.id, {
        leaseUntil: claimed.leaseUntil, status: "FAILED", statusCode: 410,
        disableSubscriptionReason: "EXPIRED_AT_SERVICE", subscription: claimed.subscription,
      });
      expect(instance.notifications.subscriptionForEndpoint(endpoint)).toEqual({ id: sub.id, label: "Renewed", active: true });
      instance.notifications.recordEvent({
        dedupeKey: "new", type: "TEST", entityId: "new", summary: "New",
      });
      const [next] = instance.notifications.claimDeliveriesForDispatch();
      expect(next?.subscription.p256dh).toBe(replacementKeys.p256dh);
      expect(next?.subscription.auth).toBe(replacementKeys.auth);
    });
  });

  it("looks up only the exact saved endpoint without returning its endpoint or keys", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, instance => {
      const endpoint = "https://web.push.apple.com/lookup";
      const sub = instance.notifications.subscribe({ subscription: { endpoint, keys }, label: "Lookup" });
      expect(instance.notifications.subscriptionForEndpoint(endpoint)).toEqual({ id: sub.id, label: "Lookup", active: true });
      expect(instance.notifications.subscriptionForEndpoint(`${endpoint}/other`)).toBeNull();
      expect(instance.notifications.subscriptionForEndpoint("https://web.push.apple.com/LOOKUP")).toBeNull();
      instance.notifications.unsubscribe(sub.id);
      expect(instance.notifications.subscriptionForEndpoint(endpoint)).toEqual({ id: sub.id, label: "Lookup", active: false });
    });
  });

  it("supports dashboard notifications API, pagination, read marking, and pending approvals", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const vault = vaultStub(appEnv);

    // Create a pending proposal in DO
    await runInDurableObject(vault, (instance, state) => {
      const now = Date.now();
      state.storage.sql.exec(
        `INSERT INTO trade_proposal (id, mode, action, account_hash, order_id, order_json, condition_json, valid_until, poll_interval_seconds, replaces_task_id, intent_digest, instruction_digest, token_hash, confirmation_text, status, expires_at, created_at, updated_at, approval_method, client_id, policy_version)
         VALUES ('test-prop-01', 'IMMEDIATE', 'PLACE', 'hash123', NULL, '{}', NULL, NULL, NULL, NULL, 'digest123', 'inst123', 'token123', 'text123', 'PENDING', ?, ?, ?, 'passkey', 'client-01', 1)`,
        now + 300_000, now, now
      );
    });

    // Check GET /dashboard/api/pending-approvals
    const pendingRes = await dispatch(new Request(`${origin}/dashboard/api/pending-approvals`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(pendingRes.status).toBe(200);
    const pendingData = await pendingRes.json<{ items: Array<{ id: string; kind: string; actionPath: string }> }>();
    expect(pendingData.items.some(i => i.id === "test-prop-01" && i.kind === "trade" && i.actionPath === "/security/approvals/test-prop-01")).toBe(true);

    // Query notifications list
    const notifsRes = await dispatch(new Request(`${origin}/dashboard/api/notifications?limit=10&offset=0`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(notifsRes.status).toBe(200);
    const notifsData = await notifsRes.json<{ items: Array<{ id: string; summary: string; readAt: number | null }>; total: number; unreadCount: number }>();
    expect(notifsData.items.length).toBeGreaterThan(0);
    const target = notifsData.items[0];
    expect(target).toBeDefined();
    if (!target) throw new Error("Target notification missing");

    // Query single notification detail
    const singleRes = await dispatch(new Request(`${origin}/dashboard/api/notifications/${target.id}`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(singleRes.status).toBe(200);
    const singleData = await singleRes.json<{ id: string; summary: string }>();
    expect(singleData.id).toBe(target.id);

    // Mark notification as read
    const readRes = await dispatch(new Request(`${origin}/dashboard/api/notifications/read`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id: target.id }),
    }), appEnv);
    expect(readRes.status).toBe(200);
    expect((await readRes.json<{ read: boolean }>()).read).toBe(true);

    // Render dashboard with notification highlight
    const pageRes = await dispatch(new Request(`${origin}/dashboard/notifications/${target.id}`, {
      headers: { Cookie: securityCookie },
    }), appEnv);
    expect(pageRes.status).toBe(200);
    const pageHtml = await pageRes.text();
    expect(pageHtml).toContain(`name="highlight-notification" content="${target.id}"`);
  });
});
