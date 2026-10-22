import { env } from "cloudflare:workers";
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import { vaultStub } from "../src/env";
import { decodeBase64Url, encodeBase64Url, validateSubscriptionInput } from "../src/notifications";

import type { SchwabVault } from "../src/vault";
import type { BrowserSession } from "../src/security-store";
import { authenticator } from "./webauthn-fixture";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { AuthHandler } from "../src/auth";
import { AUTHORIZATION_VERSION, READ_SCOPE } from "../src/oauth-access";
const origin = "https://example.com";

function mockLimiter(): RateLimit {
  return {
    limit() {
      return Promise.resolve({ success: true });
    },
  };
}

function setup() {
  const appEnv = { ...env } as unknown as AppEnv;
  appEnv.BROWSER_AUTH_RATE_LIMITER = mockLimiter();
  appEnv.ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER = mockLimiter();
  return appEnv;
}

async function dispatch(request: Request, appEnv: AppEnv) {
  let req = request;
  if (!req.headers.has("CF-Connecting-IP")) {
    const headers = new Headers(req.headers);
    headers.set("CF-Connecting-IP", "192.0.2.10");
    req = new Request(req, { headers });
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(req, appEnv, ctx);
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

function emailBinding() {
  const send = vi.fn<(message: EmailMessage | EmailMessageBuilder) => Promise<EmailSendResult>>().mockResolvedValue({ messageId: "local-test-message" });
  return { send } satisfies SendEmail;
}

async function withEmailEnv<T>(instance: SchwabVault, binding: SendEmail, work: (runtime: object) => T | Promise<T>, enabled = "true"): Promise<T> {
  const runtime: unknown = Reflect.get(instance, "env");
  if (runtime === null || typeof runtime !== "object") throw new Error("Missing vault environment");
  const values = {
    OWNER_ALERT_EMAIL: binding,
    EMAIL_ALERTS_ENABLED: enabled,
    ALERT_EMAIL_FROM: "alerts@example.com",
    ALERT_EMAIL_TO: "owner@example.net",
  };
  const previous = Object.keys(values).map(key => [key, Reflect.get(runtime, key)] as const);
  for (const [key, value] of Object.entries(values)) Reflect.set(runtime, key, value);
  try {
    return await work(runtime);
  } finally {
    for (const [key, value] of previous) Reflect.set(runtime, key, value);
  }
}

function postNotificationVault(vault: DurableObjectStub, path: string, body: unknown) {
  return vault.fetch(`https://vault${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

async function saveEmailToken(vault: DurableObjectStub) {
  const response = await vault.fetch("https://vault/token", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "email-test-access", refresh_token: "email-test-refresh", expires_in: 1800 }),
  });
  expect(response.status).toBe(204);
}
async function withEmailVault<T>(vault: DurableObjectStub<SchwabVault>, binding: SendEmail, work: () => Promise<T>, enabled = "true"): Promise<T> {
  let previous: Array<readonly [string, unknown]> = [];
  await runInDurableObject(vault, (instance: SchwabVault) => {
    const runtime: unknown = Reflect.get(instance, "env");
    if (runtime === null || typeof runtime !== "object") throw new Error("Missing vault environment");
    const values = {
      OWNER_ALERT_EMAIL: binding, EMAIL_ALERTS_ENABLED: enabled,
      ALERT_EMAIL_FROM: "alerts@example.com", ALERT_EMAIL_TO: "owner@example.net",
    };
    previous = Object.keys(values).map(key => [key, Reflect.get(runtime, key)] as const);
    for (const [key, value] of Object.entries(values)) Reflect.set(runtime, key, value);
  });
  try {
    return await work();
  } finally {
    await runInDurableObject(vault, (instance: SchwabVault) => {
      const runtime: unknown = Reflect.get(instance, "env");
      if (runtime === null || typeof runtime !== "object") throw new Error("Missing vault environment");
      for (const [key, value] of previous) Reflect.set(runtime, key, value);
    });
  }
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

  it("rejects push service redirects and records the delivery as failed", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const { p256dh, auth } = await generateTestKeys();

    const subRes = await dispatch(new Request(`${origin}/dashboard/api/push/subscribe`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({
        subscription: { endpoint: "https://web.push.apple.com/redirect-sub", expirationTime: null, keys: { p256dh, auth } },
        label: "Redirect Device",
      }),
    }), appEnv);
    const sub = await subRes.json<{ id: string }>();

    await dispatch(new Request(`${origin}/dashboard/api/push/test`, {
      method: "POST",
      headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ id: sub.id }),
    }), appEnv);

    // Mock 302 redirect response from push service
    const pushFetch = vi.fn().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { Location: "https://untrusted.invalid/push" },
    }));
    vi.stubGlobal("fetch", pushFetch);

    const vault = vaultStub(appEnv);
    await runDurableObjectAlarm(vault);
    vi.unstubAllGlobals();

    expect(pushFetch).toHaveBeenCalledTimes(1);
    await runInDurableObject(vault, (_instance, state) => {
      const deliveries = state.storage.sql.exec<{ status: string; last_status_code: number }>(
        "SELECT status, last_status_code FROM notification_delivery WHERE subscription_id = ?",
        sub.id
      ).toArray();
      expect(deliveries).toEqual([{ status: "FAILED", last_status_code: 302 }]);
    });
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

describe("Owner email delivery lifecycle", () => {
  it("queues only typed critical events without push subscriptions and never backfills a deduplicated event", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, runtime => {
      for (const [type, reason] of [
        ["SCHWAB_REAUTH_DUE_SOON", "REAUTH_DUE_SOON"],
        ["SCHWAB_REAUTH_REQUIRED", "REAUTH_REQUIRED"],
      ] as const) {
        const input = { type, dedupeKey: type, entityId: "generation", summary: "private summary" };
        const event = instance.notifications.recordEvent(input);
        expect(instance.notifications.recordEvent(input)?.id).toBe(event?.id);
        expect(state.storage.sql.exec("SELECT reason, sender_address, destination_address FROM email_delivery WHERE event_id = ?", event?.id ?? "").toArray())
          .toEqual([{ reason, sender_address: "alerts@example.com", destination_address: "owner@example.net" }]);
      }
      instance.notifications.recordEvent({
        dedupeKey: "uncertain", type: "TRADE_RESULT", entityId: "trade", summary: "Do not parse this",
        executionStatus: "EXECUTION_UNCERTAIN",
      });
      for (const type of ["TRADE_RESULT", "TRADE_APPROVAL_PENDING", "CLIENT_AUTHORIZATION_PENDING", "CLIENT_AUTHORIZED", "TEST"] as const) {
        instance.notifications.recordEvent({
          dedupeKey: `ordinary:${type}`, type, entityId: "ordinary", summary: "EXECUTION_UNCERTAIN 执行结果不确定",
        });
      }
      expect(state.storage.sql.exec("SELECT reason FROM email_delivery ORDER BY reason").toArray()).toEqual([
        { reason: "EXECUTION_UNCERTAIN" }, { reason: "REAUTH_DUE_SOON" }, { reason: "REAUTH_REQUIRED" },
      ]);
      expect(state.storage.sql.exec("SELECT id FROM notification_delivery").toArray()).toEqual([]);
      Reflect.set(runtime, "EMAIL_ALERTS_ENABLED", "false");
      const historical = { dedupeKey: "historical", type: "SCHWAB_REAUTH_REQUIRED" as const, entityId: "old", summary: "Old" };
      const event = instance.notifications.recordEvent(historical);
      Reflect.set(runtime, "EMAIL_ALERTS_ENABLED", "true");
      expect(instance.notifications.recordEvent(historical)?.id).toBe(event?.id);
      expect(state.storage.sql.exec("SELECT id FROM email_delivery WHERE event_id = ?", event?.id ?? "").toArray()).toEqual([]);
      expect(binding.send).not.toHaveBeenCalled();
    }));
  });

  it("fences reclaimed and terminal email outcomes and caps crashed leases at three claims", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, emailBinding(), () => {
      const now = 2_000_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        instance.notifications.recordEvent({ dedupeKey: "lease", type: "TRADE_RESULT", entityId: "trade", summary: "Result", executionStatus: "EXECUTION_UNCERTAIN" });
        const [first] = instance.notifications.claimEmailDeliveriesForDispatch();
        if (!first) throw new Error("Missing initial email claim");
        expect(first).toMatchObject({ attemptCount: 1, leaseUntil: now + 120_000, senderAddress: "alerts@example.com", destinationAddress: "owner@example.net" });
        expect(instance.notifications.getNextAlarmTime()).toBe(now + 120_000);
        clock.mockReturnValue(now + 120_001);
        const [second] = instance.notifications.claimEmailDeliveriesForDispatch();
        if (!second) throw new Error("Missing reclaimed email");
        expect(second.attemptCount).toBe(2);
        instance.notifications.recordEmailDeliveryOutcome(first.deliveryId, { leaseUntil: first.leaseUntil, status: "SENT" });
        expect(state.storage.sql.exec("SELECT status, lease_until FROM email_delivery").toArray()).toEqual([{ status: "SENDING", lease_until: second.leaseUntil }]);
        clock.mockReturnValue(second.leaseUntil + 1);
        const [third] = instance.notifications.claimEmailDeliveriesForDispatch();
        if (!third) throw new Error("Missing third email claim");
        expect(third.attemptCount).toBe(3);
        clock.mockReturnValue(third.leaseUntil + 1);
        expect(instance.notifications.claimEmailDeliveriesForDispatch()).toEqual([]);
        instance.notifications.recordEmailDeliveryOutcome(third.deliveryId, { leaseUntil: third.leaseUntil, status: "RETRY", nextAttemptAt: Date.now() });
        expect(state.storage.sql.exec("SELECT status, attempt_count FROM email_delivery").toArray()).toEqual([{ status: "FAILED", attempt_count: 3 }]);
        expect(instance.notifications.getNextAlarmTime()).toBeNull();
      } finally {
        clock.mockRestore();
      }
    }));
  });

  it.each(["SENT", "FAILED", "SUPPRESSED"] as const)("cannot resurrect an email after %s", async status => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, emailBinding(), () => {
      instance.notifications.triggerTestEmail();
      const [claim] = instance.notifications.claimEmailDeliveriesForDispatch();
      if (!claim) throw new Error("Missing test email claim");
      instance.notifications.recordEmailDeliveryOutcome(claim.deliveryId, { leaseUntil: claim.leaseUntil, status });
      instance.notifications.recordEmailDeliveryOutcome(claim.deliveryId, { leaseUntil: claim.leaseUntil, status: "RETRY", nextAttemptAt: Date.now() });
      expect(state.storage.sql.exec("SELECT status, attempt_count FROM email_delivery").toArray()).toEqual([{ status, attempt_count: 1 }]);
      expect(instance.notifications.claimEmailDeliveriesForDispatch()).toEqual([]);
    }, "false"));
  });

  it.each(["expired", "disabled", "sender", "recipient", "binding"] as const)("suppresses queued business mail when %s changes before claim", async change => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, runtime => {
      instance.notifications.recordEvent({ dedupeKey: "queued", type: "SCHWAB_REAUTH_REQUIRED", entityId: "generation", summary: "Required" });
      if (change === "expired") state.storage.sql.exec("UPDATE notification_event SET expires_at = ?", Date.now() - 1);
      if (change === "disabled") Reflect.set(runtime, "EMAIL_ALERTS_ENABLED", "false");
      if (change === "sender") Reflect.set(runtime, "ALERT_EMAIL_FROM", "changed@example.com");
      if (change === "recipient") Reflect.set(runtime, "ALERT_EMAIL_TO", "changed@example.net");
      if (change === "binding") Reflect.set(runtime, "OWNER_ALERT_EMAIL", undefined);
      expect(instance.notifications.claimEmailDeliveriesForDispatch()).toEqual([]);
      expect(state.storage.sql.exec("SELECT status, attempt_count FROM email_delivery").toArray()).toEqual([{ status: "SUPPRESSED", attempt_count: 0 }]);
      expect(instance.notifications.getNextAlarmTime()).toBeNull();
      expect(binding.send).not.toHaveBeenCalled();
    }));
  });

  it("suppresses only selected generation reasons, including leased mail, without reviving late results", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, emailBinding(), () => {
      for (const entityId of ["old-generation", "new-generation"]) {
        for (const type of ["SCHWAB_REAUTH_DUE_SOON", "SCHWAB_REAUTH_REQUIRED"] as const) {
          instance.notifications.recordEvent({ dedupeKey: `${entityId}:${type}`, type, entityId, summary: "Reminder" });
        }
      }
      const claims = instance.notifications.claimEmailDeliveriesForDispatch(4);
      expect(claims).toHaveLength(4);
      instance.notifications.suppressPendingReauthorizationEmails("old-generation", ["REAUTH_DUE_SOON"]);
      for (const claim of claims) {
        instance.notifications.recordEmailDeliveryOutcome(claim.deliveryId, { leaseUntil: claim.leaseUntil, status: "RETRY", nextAttemptAt: Date.now() + 30_000 });
      }
      expect(state.storage.sql.exec(`
        SELECT e.entity_id, d.reason, d.status FROM email_delivery d JOIN notification_event e ON e.id = d.event_id
        ORDER BY e.entity_id, d.reason
      `).toArray()).toEqual([
        { entity_id: "new-generation", reason: "REAUTH_DUE_SOON", status: "PENDING" },
        { entity_id: "new-generation", reason: "REAUTH_REQUIRED", status: "PENDING" },
        { entity_id: "old-generation", reason: "REAUTH_DUE_SOON", status: "SUPPRESSED" },
        { entity_id: "old-generation", reason: "REAUTH_REQUIRED", status: "PENDING" },
      ]);
    }));
  });

  it.each(["age", "capacity"] as const)("retains email-only active parents during %s pruning and deletes both child tables for completed candidates", async mode => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, emailBinding(), () => {
      const now = 2_000_000_000_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const sub = instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/email-prune", keys }, label: "Prune" });
        const count = mode === "capacity" ? 999 : 4;
        const createdAt = mode === "capacity" ? now - 1000 : now - 31 * 86_400_000;
        state.storage.transactionSync(() => {
          for (let n = 0; n < count; n++) {
            const id = `email-cap-${String(n)}`;
            state.storage.sql.exec("INSERT INTO notification_event VALUES (?, ?, 'TEST', ?, 'History', ?, ?, NULL)", id, id, id, createdAt + n, now + 60_000);
            state.storage.sql.exec("INSERT INTO notification_delivery VALUES (?, ?, ?, 'SENT', 0, ?, 0, NULL)", `${id}-push`, id, sub.id, now);
            state.storage.sql.exec(`
              INSERT INTO email_delivery (id, event_id, reason, sender_address, destination_address, status, attempt_count, next_attempt_at, lease_until)
              VALUES (?, ?, 'TEST', 'alerts@example.com', 'owner@example.net', ?, 0, ?, ?)
            `, `${id}-email`, id, n === 0 ? "PENDING" : n === 1 ? "SENDING" : "SENT", now, n === 1 ? now + 120_000 : 0);
          }
        });
        const fresh = () => instance.notifications.recordEvent({ dedupeKey: crypto.randomUUID(), type: "CLIENT_AUTHORIZED", entityId: "fresh", summary: "Fresh" });
        fresh();
        if (mode === "capacity") fresh();
        for (const n of [0, 1]) expect(instance.notifications.getEvent(`email-cap-${String(n)}`)).not.toBeNull();
        expect(instance.notifications.getEvent("email-cap-2")).toBeNull();
        expect(state.storage.sql.exec("SELECT id FROM email_delivery WHERE event_id = 'email-cap-2'").toArray()).toEqual([]);
        expect(state.storage.sql.exec("SELECT id FROM notification_delivery WHERE event_id = 'email-cap-2'").toArray()).toEqual([]);
        if (mode === "capacity") {
          expect(instance.notifications.getEvent("email-cap-3")).not.toBeNull();
          expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM notification_event").one().count).toBe(1000);
        }
        state.storage.sql.exec("UPDATE email_delivery SET status = 'SENT', lease_until = 0 WHERE event_id IN ('email-cap-0', 'email-cap-1')");
        fresh();
        expect(instance.notifications.getEvent("email-cap-0")).toBeNull();
        if (mode === "age") expect(instance.notifications.getEvent("email-cap-1")).toBeNull();
        expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    }));
  });
});

describe("Owner email alarm dispatch", () => {
  it("sends one fixed-template test email per alarm while business alerts are disabled", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const first = instance.notifications.triggerTestEmail();
      instance.notifications.recordEvent({ dedupeKey: "off", type: "SCHWAB_REAUTH_REQUIRED", entityId: "generation", summary: "private-account-order-token" });
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
      const message = binding.send.mock.calls[0]?.[0];
      expect(message).toMatchObject({ from: "alerts@example.com", to: "owner@example.net", subject: "[Schwab MCP] 邮件通知测试" });
      if (!message || !("text" in message) || !("html" in message)) throw new Error("Missing multipart template");
      for (const body of [message.text, message.html]) {
        expect(body).toContain(first.id);
        expect(body).toContain(new Date(first.createdAt).toISOString());
        expect(body).toContain(`${origin}/dashboard/notifications/${first.id}`);
        expect(body).not.toContain("private-account-order-token");
        expect(body).not.toContain("/security/approvals");
      }
      expect(state.storage.sql.exec("SELECT status, attempt_count FROM email_delivery").toArray()).toEqual([{ status: "SENT", attempt_count: 1 }]);
      expect(state.storage.sql.exec("SELECT id FROM web_push_identity").toArray()).toEqual([]);
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
    }, "false"));
  });

  it("bounds transient email retries to 30s/120s and three total attempts without persisting raw errors", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    binding.send.mockRejectedValue(new Error("private-upstream-error owner@example.net token=secret"));
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        instance.notifications.triggerTestEmail();
        await instance.alarm();
        expect(binding.send).toHaveBeenCalledTimes(1);
        expect(state.storage.sql.exec("SELECT status, attempt_count, next_attempt_at, last_error_code FROM email_delivery").toArray())
          .toEqual([{ status: "PENDING", attempt_count: 1, next_attempt_at: now + 30_000, last_error_code: "EMAIL_SEND_FAILED" }]);
        await instance.alarm();
        expect(binding.send).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(now + 30_000);
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT status, attempt_count, next_attempt_at FROM email_delivery").toArray())
          .toEqual([{ status: "PENDING", attempt_count: 2, next_attempt_at: now + 150_000 }]);
        clock.mockReturnValue(now + 150_000);
        await instance.alarm();
        await instance.alarm();
        expect(binding.send).toHaveBeenCalledTimes(3);
        expect(state.storage.sql.exec("SELECT status, attempt_count, last_error_code FROM email_delivery").toArray())
          .toEqual([{ status: "FAILED", attempt_count: 3, last_error_code: "EMAIL_SEND_FAILED" }]);
        const deliveryLogs = logs.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>)
          .filter(value => value.event === "email_alert_delivery");
        expect(deliveryLogs).toHaveLength(3);
        for (const entry of deliveryLogs) {
          expect(Object.keys(entry).sort()).toEqual(["attemptCount", "deliveryId", "errorCode", "event", "eventId", "reason", "requestId", "status"].sort());
          expect(entry.requestId).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-upstream-error|owner@example.net|token=secret/);
      } finally {
        clock.mockRestore();
        logs.mockRestore();
      }
    }));
  });

  it.each([
    "E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_SENDER_NOT_VERIFIED", "E_RECIPIENT_NOT_ALLOWED",
    "E_RECIPIENT_SUPPRESSED", "E_SENDER_DOMAIN_NOT_AVAILABLE", "E_CONTENT_TOO_LARGE", "E_DELIVERY_FAILED",
  ])("does not retry permanent native email error %s", async code => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    binding.send.mockRejectedValue({ code, message: "must-not-persist" });
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      instance.notifications.triggerTestEmail();
      await instance.alarm();
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec("SELECT status, attempt_count, last_error_code FROM email_delivery").toArray())
        .toEqual([{ status: "FAILED", attempt_count: 1, last_error_code: code }]);
    }));
  });

  it("does not schedule a retry beyond event expiry", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    binding.send.mockRejectedValue(new Error("temporary"));
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        instance.notifications.triggerTestEmail();
        state.storage.sql.exec("UPDATE notification_event SET expires_at = ?", now + 29_999);
        await instance.alarm();
        expect(state.storage.sql.exec("SELECT status, attempt_count FROM email_delivery").toArray()).toEqual([{ status: "FAILED", attempt_count: 1 }]);
        expect(instance.notifications.getNextAlarmTime()).toBeNull();
      } finally {
        clock.mockRestore();
      }
    }));
  });

  it.each(["accepted", "rejected"] as const)("keeps Web Push independent when the email service is %s", async outcome => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    if (outcome === "rejected") binding.send.mockRejectedValue({ code: "E_RECIPIENT_NOT_ALLOWED" });
    const keys = await generateTestKeys();
    const push = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", push);
    try {
      await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
        instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/independent-email", keys }, label: "Independent" });
        instance.notifications.recordEvent({ dedupeKey: "independent", type: "TRADE_RESULT", entityId: "secret-order-account-identity", summary: "private-order-quantity-price-token", executionStatus: "EXECUTION_UNCERTAIN" });
        await instance.alarm();
        expect(push).toHaveBeenCalledTimes(1);
        expect(binding.send).toHaveBeenCalledTimes(1);
        const message = binding.send.mock.calls[0]?.[0];
        expect(message).toMatchObject({ subject: "[Schwab MCP] 执行结果不确定" });
        expect(JSON.stringify(message)).not.toMatch(/secret-order-account-identity|private-order-quantity-price-token/);
        expect(state.storage.sql.exec("SELECT status FROM notification_delivery").toArray()).toEqual([{ status: "SENT" }]);
        expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: outcome === "accepted" ? "SENT" : "FAILED" }]);
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("discards stale generation and out-of-window reminder emails before native send", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await saveEmailToken(vault);
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const token = state.storage.sql.exec<{ authorization_generation: string }>("SELECT authorization_generation FROM schwab_token").one();
      instance.notifications.recordEvent({ dedupeKey: "stale", type: "SCHWAB_REAUTH_REQUIRED", entityId: "wrong-generation", summary: "Required" });
      await instance.alarm();
      instance.notifications.recordEvent({ dedupeKey: "too-early", type: "SCHWAB_REAUTH_DUE_SOON", entityId: token.authorization_generation, summary: "Due soon" });
      await instance.alarm();
      instance.notifications.recordEvent({ dedupeKey: "not-required", type: "SCHWAB_REAUTH_REQUIRED", entityId: token.authorization_generation, summary: "Required" });
      await instance.alarm();
      expect(binding.send).not.toHaveBeenCalled();
      expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([
        { status: "SUPPRESSED" }, { status: "SUPPRESSED" }, { status: "SUPPRESSED" },
      ]);
    }));
  });

  it("replaces token generations and suppresses leased old reminders before late send completion", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await saveEmailToken(vault);
    const binding = emailBinding();
    await withEmailVault(vault, binding, async () => {
      const claims = await runInDurableObject(vault, (instance: SchwabVault, state) => {
        const token = state.storage.sql.exec<{ authorization_generation: string }>("SELECT authorization_generation FROM schwab_token").one();
        for (const type of ["SCHWAB_REAUTH_DUE_SOON", "SCHWAB_REAUTH_REQUIRED"] as const) {
          instance.notifications.recordEvent({ dedupeKey: type, type, entityId: token.authorization_generation, summary: "Old reminder" });
        }
        return instance.notifications.claimEmailDeliveriesForDispatch(2);
      });
      expect(claims).toHaveLength(2);
      await saveEmailToken(vault);
      await runInDurableObject(vault, async (instance: SchwabVault, state) => {
        for (const claim of claims) instance.notifications.recordEmailDeliveryOutcome(claim.deliveryId, { leaseUntil: claim.leaseUntil, status: "SENT" });
        expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: "SUPPRESSED" }, { status: "SUPPRESSED" }]);
        await instance.alarm();
      });
      expect(binding.send).not.toHaveBeenCalled();
    });
  });
});

describe("Protected owner email test endpoint", () => {
  it("requires an owner dashboard session and rejects malformed input before queuing", async () => {
    const appEnv = setup();
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.idFromName("owner"));
    const binding = emailBinding();
    const { securityCookie, csrf } = await login(appEnv);
    await withEmailVault(vault, binding, async () => {
      const headers = { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf };
      for (const override of [
        { Cookie: "" }, { "X-CSRF-Token": "" }, { "X-CSRF-Token": "wrong" },
        { Origin: "https://evil.example" }, { "Content-Type": "text/plain" },
      ]) {
        const response = await dispatch(new Request(`${origin}/dashboard/api/email/test`, {
          method: "POST", headers: { ...headers, ...override }, body: "{}",
        }), appEnv);
        expect(response.status).toBe(403);
      }
      for (const body of ["null", "[]", "{", '{"to":"attacker@example.net"}', '{"from":"attacker@example.net"}']) {
        expect((await dispatch(new Request(`${origin}/dashboard/api/email/test`, { method: "POST", headers, body }), appEnv)).status).toBe(400);
      }
      const bytes = new TextEncoder().encode(`{"padding":"${"界".repeat(22_000)}"}`);
      expect(bytes.byteLength).toBeGreaterThan(65_536);
      const oversized = await dispatch(new Request(`${origin}/dashboard/api/email/test`, {
        method: "POST", headers: { ...headers, "Content-Length": "2" },
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      }), appEnv);
      expect(oversized.status).toBe(413);
      for (const input of [{ recovery: true }, { pendingAuthorizationId: "pending-client" }]) {
        const created = await (await postNotificationVault(vault, "/security/session/create", input)).json<{ sessionId: string; session: BrowserSession }>();
        expect((await dispatch(new Request(`${origin}/dashboard/api/email/test`, {
          method: "POST", headers: { ...headers, Cookie: `__Host-schwab-security=${created.sessionId}`, "X-CSRF-Token": created.session.csrf }, body: "{}",
        }), appEnv)).status).toBe(403);
      }
      expect(await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec("SELECT id FROM email_delivery").toArray())).toEqual([]);
      expect(binding.send).not.toHaveBeenCalled();
    }, "false");
  });

  it("does not grant dashboard email authority to a valid MCP bearer", async () => {
    const appEnv = setup();
    appEnv.OAUTH_PROVIDER = getOAuthApi({
      authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
      apiRoute: "/mcp", apiHandler: { fetch: () => Response.json({}) }, defaultHandler: AuthHandler, scopesSupported: [READ_SCOPE],
    }, appEnv);
    const redirectUri = "https://email-test-client.example/callback";
    const client = await appEnv.OAUTH_PROVIDER.createClient({ redirectUris: [redirectUri], clientName: "Email test", tokenEndpointAuthMethod: "none" });
    const verifier = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    const authorization = await appEnv.OAUTH_PROVIDER.completeAuthorization({
      request: { responseType: "code", clientId: client.clientId, redirectUri, scope: [READ_SCOPE], state: "test", codeChallenge: challenge, codeChallengeMethod: "S256" },
      userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE], metadata: { permissionLevel: "read_only", advancedSecurity: false, allowedAccountHashes: [], authorizationVersion: AUTHORIZATION_VERSION },
      props: { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel: "read_only", allowedAccountHashes: [], authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256" },
    });
    const tokenResponse = await dispatch(new Request(`${origin}/oauth/token`, {
      method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.clientId, code: new URL(authorization.redirectTo).searchParams.get("code") ?? "", redirect_uri: redirectUri, code_verifier: verifier }),
    }), appEnv);
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json<{ access_token: string }>();
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.idFromName("owner"));
    await withEmailVault(vault, emailBinding(), async () => {
      const response = await dispatch(new Request(`${origin}/dashboard/api/email/test`, {
        method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, Origin: origin, "Content-Type": "application/json" }, body: "{}",
      }), appEnv);
      expect(response.status).toBe(403);
      expect(await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec("SELECT id FROM email_delivery").toArray())).toEqual([]);
    });
  });

  it("queues TEST with business alerts off, creates no push fanout, and enforces a 60-second cooldown", async () => {
    const appEnv = setup();
    const { securityCookie, csrf } = await login(appEnv);
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.idFromName("owner"));
    const binding = emailBinding();
    const keys = await generateTestKeys();
    await withEmailVault(vault, binding, async () => {
      await runInDurableObject(vault, (instance: SchwabVault) => {
        instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/email-test-no-fanout", keys }, label: "No fanout" });
      });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const push = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 201 })));
      try {
        const request = () => dispatch(new Request(`${origin}/dashboard/api/email/test`, {
          method: "POST", headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}",
        }), appEnv);
        const response = await request();
        expect(response.status).toBe(200);
        const event = await response.json<{ id: string }>();
        expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(binding.send).not.toHaveBeenCalled();
        expect((await request()).status).toBe(429);
        await runInDurableObject(vault, (instance: SchwabVault, state) => {
          expect(instance.notifications.getEvent(event.id)).toMatchObject({ type: "TEST", createdAt: now, expiresAt: now + 3_600_000 });
          expect(state.storage.sql.exec("SELECT reason, status FROM email_delivery WHERE event_id = ?", event.id).toArray()).toEqual([{ reason: "TEST", status: "PENDING" }]);
          expect(state.storage.sql.exec("SELECT id FROM notification_delivery WHERE event_id = ?", event.id).toArray()).toEqual([]);
        });
        expect(await runInDurableObject(vault, (_instance, state) => state.storage.getAlarm())).not.toBeNull();
        await runDurableObjectAlarm(vault);
        expect(binding.send).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(now + 60_000);
        expect((await request()).status).toBe(200);
      } finally {
        push.mockRestore();
        clock.mockRestore();
      }
    }, "false");
  });

  it("rechecks strict envelope, actual byte size, session kind and CSRF at the vault boundary", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const browser = await (await postNotificationVault(vault, "/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
    const envelope = { sessionId: browser.sessionId, csrf: browser.session.csrf, input: {} };
    await withEmailVault(vault, emailBinding(), async () => {
      expect((await vault.fetch("https://vault/notifications/email-test")).status).toBe(400);
      expect((await vault.fetch("https://vault/notifications/email-test", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status).toBe(400);
      for (const input of [
        {}, { ...envelope, to: "attacker@example.net" }, { ...envelope, input: { to: "attacker@example.net" } },
        { ...envelope, input: { from: "attacker@example.net" } }, { ...envelope, input: null },
      ]) expect((await postNotificationVault(vault, "/notifications/email-test", input)).status).toBe(400);
      for (const input of [{ ...envelope, csrf: "wrong" }, { ...envelope, sessionId: "missing" }]) {
        expect((await postNotificationVault(vault, "/notifications/email-test", input)).status).toBe(403);
      }
      const bytes = new TextEncoder().encode(JSON.stringify({ ...envelope, padding: "界".repeat(22_000) }));
      expect((await vault.fetch("https://vault/notifications/email-test", {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "2" },
        body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      })).status).toBe(413);
      for (const input of [{ recovery: true }, { pendingAuthorizationId: "pending-client" }]) {
        const session = await (await postNotificationVault(vault, "/security/session/create", input)).json<{ sessionId: string; session: BrowserSession }>();
        expect((await postNotificationVault(vault, "/notifications/email-test", { sessionId: session.sessionId, csrf: session.session.csrf, input: {} })).status).toBe(403);
      }
      expect(await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec("SELECT id FROM email_delivery").toArray())).toEqual([]);
    }, "false");
  });

  it.each([undefined, "", "not-an-email", "alerts@example.com\r\nBcc: attacker@example.net"])("rejects invalid fixed mail configuration without queuing (%s)", async sender => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, runtime => {
      Reflect.set(runtime, "ALERT_EMAIL_FROM", sender);
      expect(() => instance.notifications.triggerTestEmail()).toThrow(expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }));
      expect(state.storage.sql.exec("SELECT id FROM email_delivery").toArray()).toEqual([]);
      expect(state.storage.sql.exec("SELECT id FROM notification_event").toArray()).toEqual([]);
      expect(binding.send).not.toHaveBeenCalled();
    }, "false"));
  });
});

describe("Owner email business producers", () => {
  it("sends due-soon and required reminders for the current token without subscriptions or duplicates", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await saveEmailToken(vault);
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const now = Date.now();
      state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", now + 12 * 3_600_000);
      await instance.alarm();
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
      expect(binding.send.mock.calls[0]?.[0]).toMatchObject({ subject: "[Schwab MCP] 授权即将到期" });
      state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", now - 1);
      await instance.alarm();
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(2);
      expect(binding.send.mock.calls[1]?.[0]).toMatchObject({ subject: "[Schwab MCP] 需要重新授权" });
      expect(state.storage.sql.exec("SELECT reason, status FROM email_delivery ORDER BY reason").toArray())
        .toEqual([{ reason: "REAUTH_DUE_SOON", status: "SENT" }, { reason: "REAUTH_REQUIRED", status: "SENT" }]);
    }));
  });

  it("suppresses an in-flight due-soon reminder when the same generation requires reauthorization", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    await saveEmailToken(vault);
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      const token = state.storage.sql.exec<{ authorization_generation: string }>("SELECT authorization_generation FROM schwab_token").one();
      instance.notifications.recordEvent({ dedupeKey: "pending-due", type: "SCHWAB_REAUTH_DUE_SOON", entityId: token.authorization_generation, summary: "Pending" });
      const [claim] = instance.notifications.claimEmailDeliveriesForDispatch();
      if (!claim) throw new Error("Missing due-soon claim");
      state.storage.sql.exec("UPDATE schwab_token SET refresh_expires_at = ?", Date.now() - 1);
      expect((await instance.fetch(new Request("https://vault/status"))).status).toBe(200);
      instance.notifications.recordEmailDeliveryOutcome(claim.deliveryId, { leaseUntil: claim.leaseUntil, status: "RETRY", nextAttemptAt: Date.now() });
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec("SELECT reason, status FROM email_delivery ORDER BY reason").toArray())
        .toEqual([{ reason: "REAUTH_DUE_SOON", status: "SUPPRESSED" }, { reason: "REAUTH_REQUIRED", status: "SENT" }]);
    }));
  });

  it.each(["direct", "confirmed", "cancel", "delayed"] as const)("creates an independent email for the real %s uncertain terminal path without retrying the mutation", async path => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const identity = { clientId: "email-trade-client", advancedSecurity: false, securityPolicyVersion: 0 };
    expect((await vault.fetch("https://vault/client/policy?clientId=email-trade-client&ensure=true&permissionLevel=full_access&advancedSecurity=false&version=0")).status).toBe(200);
    await runInDurableObject(vault, (_instance, state) => { state.storage.sql.exec("INSERT OR REPLACE INTO client_accounts (client_id, hashes) VALUES (?, ?)", "email-trade-client", JSON.stringify(["a".repeat(32)])); });
    await saveEmailToken(vault);
    const binding = emailBinding();
    binding.send.mockRejectedValue({ code: "E_RECIPIENT_NOT_ALLOWED", message: "service refusal" });
    const upstream = vi.fn(() => Response.json({ error: "temporary" }, { status: 503 }));
    vi.stubGlobal("fetch", upstream);
    try {
      await withEmailVault(vault, binding, async () => {
        const input = {
          accountHash: "a".repeat(32), action: "PLACE", executionMode: "IMMEDIATE",
          orderPayload: {
            orderType: "LIMIT", session: "NORMAL", duration: "DAY", price: "100.00", orderStrategyType: "SINGLE",
            orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }],
          },
          userInstruction: "Buy one AAPL share",
        };
        let response: Response;
        if (path === "cancel") {
          response = await postNotificationVault(vault, "/trade/cancel-order", { identity, requestId: crypto.randomUUID(), input: { accountHash: input.accountHash, orderId: 42, userInstruction: "Cancel order 42" } });
        } else if (path === "direct") {
          const enabled = await postNotificationVault(vault, "/trade/session/enable", { identity, requestId: crypto.randomUUID(), input: { userInstruction: "Enable direct placement for this agent session" } });
          expect(enabled.status).toBe(200);
          const session = await enabled.json<{ result: { sessionCapability: string } }>();
          response = await postNotificationVault(vault, "/trade/place-direct", { identity, requestId: crypto.randomUUID(), input: { sessionCapability: session.result.sessionCapability, executionKey: crypto.randomUUID(), accountHash: input.accountHash, orderPayload: input.orderPayload, userInstruction: input.userInstruction } });
        } else {
          const prepared = await postNotificationVault(vault, "/trade/prepare", {
            identity, requestId: crypto.randomUUID(), input: {
              ...input,
              ...(path === "delayed" ? {
                executionMode: "DELAYED", condition: { type: "TIME", operator: "AT_OR_BEFORE", at: new Date(Date.now() + 60_000).toISOString() },
                validUntil: new Date(Date.now() + 120_000).toISOString(), pollIntervalSeconds: 15,
              } : {}),
            },
          });
          expect(prepared.status).toBe(200);
          const proposal = await prepared.json<{ result: { proposalId: string; confirmationToken: string; confirmationText: string } }>();
          response = await postNotificationVault(vault, "/trade/confirm", { identity, requestId: crypto.randomUUID(), input: proposal.result });
        }
        if (path === "delayed") {
          expect(response.status).toBe(200);
          expect(upstream).not.toHaveBeenCalled();
        } else {
          expect(response.status).toBe(502);
          expect(await response.json()).toMatchObject({ error: { code: "EXECUTION_UNCERTAIN", attempts: 1 } });
        }
        expect(await runDurableObjectAlarm(vault)).toBe(true);
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(binding.send).toHaveBeenCalledTimes(1);
        await runInDurableObject(vault, async (instance: SchwabVault, state) => {
          expect(state.storage.sql.exec(`
            SELECT e.type, d.reason, d.status FROM notification_event e JOIN email_delivery d ON d.event_id = e.id
          `).toArray()).toEqual([{ type: "TRADE_RESULT", reason: "EXECUTION_UNCERTAIN", status: "FAILED" }]);
          if (path === "direct") expect(state.storage.sql.exec("SELECT status FROM direct_trade_execution").toArray()).toEqual([{ status: "EXECUTION_UNCERTAIN" }]);
          if (path === "confirmed") expect(state.storage.sql.exec("SELECT status FROM trade_proposal").toArray()).toEqual([{ status: "EXECUTION_UNCERTAIN" }]);
          if (path === "delayed") expect(state.storage.sql.exec("SELECT status FROM delayed_trade").toArray()).toEqual([{ status: "EXECUTION_UNCERTAIN" }]);
          await instance.alarm();
        });
        expect(upstream).toHaveBeenCalledTimes(1);
        expect(binding.send).toHaveBeenCalledTimes(1);
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports stale EXECUTING tasks once and schedules their deadline even when trading is disabled", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    const upstream = vi.fn(() => { throw new Error("A stale execution must never be retried"); });
    vi.stubGlobal("fetch", upstream);
    try {
      await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async runtime => {
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        const enabled: unknown = Reflect.get(runtime, "ENABLE_TRADING");
        Reflect.set(runtime, "ENABLE_TRADING", "false");
        try {
          state.storage.sql.exec(`
            INSERT INTO delayed_trade (id, version, action, account_hash, order_json, condition_json, valid_until,
              poll_interval_seconds, intent_digest, instruction_digest, status, next_check_at, created_at, updated_at)
            VALUES ('stale-email-task', 3, 'PLACE', ?, '{}', ?, ?, 15, 'intent', 'instruction', 'EXECUTING', ?, ?, ?)
          `, "a".repeat(32), JSON.stringify({ type: "TIME", operator: "AFTER", at: new Date(now).toISOString() }), now + 600_000, now, now, now);
          await instance.alarm();
          expect(await state.storage.getAlarm()).toBe(now + 300_001);
          expect(binding.send).not.toHaveBeenCalled();
          clock.mockReturnValue(now + 300_001);
          await instance.alarm();
          await instance.alarm();
          expect(upstream).not.toHaveBeenCalled();
          expect(binding.send).toHaveBeenCalledTimes(1);
          expect(state.storage.sql.exec("SELECT status FROM delayed_trade").toArray()).toEqual([{ status: "EXECUTION_UNCERTAIN" }]);
          expect(state.storage.sql.exec(`
            SELECT e.dedupe_key, d.reason, d.status FROM notification_event e JOIN email_delivery d ON d.event_id = e.id
          `).toArray()).toEqual([{ dedupe_key: "delayed_trade:stale-email-task:3:EXECUTION_UNCERTAIN", reason: "EXECUTION_UNCERTAIN", status: "SENT" }]);
        } finally {
          Reflect.set(runtime, "ENABLE_TRADING", enabled);
          clock.mockRestore();
        }
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves fixed owner mail while real Passkey recovery revokes pending and future push delivery", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    const keys = await generateTestKeys();
    const oldKey = await authenticator();
    const replacement = await authenticator();
    type Challenge = { challengeId: string; options: { challenge: string } };
    const browser = await (await postNotificationVault(vault, "/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
    const registered = await (await postNotificationVault(vault, "/security/options", { sessionId: browser.sessionId, csrf: browser.session.csrf, operation: "register" })).json<Challenge>();
    expect((await postNotificationVault(vault, "/security/verify", { sessionId: browser.sessionId, csrf: browser.session.csrf, challengeId: registered.challengeId, response: await oldKey.register(registered.options.challenge) })).status).toBe(200);
    const upstream = vi.fn(() => { throw new Error("Recovered push credentials must not be used"); });
    vi.stubGlobal("fetch", upstream);
    try {
      await withEmailVault(vault, binding, async () => {
        await runInDurableObject(vault, (instance: SchwabVault) => {
          instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/recovered-email", keys }, label: "Old device" });
          instance.notifications.recordEvent({ dedupeKey: "before-recovery", type: "TRADE_RESULT", entityId: "trade-before", summary: "Private", executionStatus: "EXECUTION_UNCERTAIN" });
          expect(instance.notifications.claimDeliveriesForDispatch()).toHaveLength(1);
        });
        const recovery = await (await postNotificationVault(vault, "/security/session/create", { recovery: true })).json<{ sessionId: string; session: BrowserSession }>();
        const args = { sessionId: recovery.sessionId, csrf: recovery.session.csrf };
        const challenge = await (await postNotificationVault(vault, "/security/options", { ...args, operation: "recover", resetConfirmation: "重置全部 Passkey" })).json<Challenge>();
        expect((await postNotificationVault(vault, "/security/verify", { ...args, challengeId: challenge.challengeId, response: await replacement.register(challenge.options.challenge) })).status).toBe(200);
        await runInDurableObject(vault, async (instance: SchwabVault, state) => {
          expect(instance.notifications.listSubscriptions()).toMatchObject([{ active: false }]);
          expect(state.storage.sql.exec("SELECT status FROM notification_delivery").toArray()).toEqual([{ status: "SUPPRESSED" }]);
          expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: "PENDING" }]);
          await instance.alarm();
          instance.notifications.recordEvent({ dedupeKey: "after-recovery", type: "TRADE_RESULT", entityId: "trade-after", summary: "Private", executionStatus: "EXECUTION_UNCERTAIN" });
          await instance.alarm();
          expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: "SENT" }, { status: "SENT" }]);
          expect(state.storage.sql.exec("SELECT status FROM notification_delivery").toArray()).toEqual([{ status: "SUPPRESSED" }]);
        });
        expect(binding.send).toHaveBeenCalledTimes(2);
        expect(upstream).not.toHaveBeenCalled();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("Owner email dispatch bounds", () => {
  it("sends at most one queued email in each alarm and keeps the remaining job scheduled", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async () => {
      for (const id of ["first", "second"]) {
        instance.notifications.recordEvent({ dedupeKey: id, type: "TRADE_RESULT", entityId: id, summary: "Result", executionStatus: "EXECUTION_UNCERTAIN" });
      }
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec("SELECT status FROM email_delivery ORDER BY status").toArray()).toEqual([{ status: "PENDING" }, { status: "SENT" }]);
      expect(await state.storage.getAlarm()).not.toBeNull();
      await instance.alarm();
      expect(binding.send).toHaveBeenCalledTimes(2);
      expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: "SENT" }, { status: "SENT" }]);
    }));
  });

  it("starts push while the independent native email send is still pending", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    let finishEmail: ((result: EmailSendResult) => void) | undefined;
    const pendingEmail = new Promise<EmailSendResult>(resolve => { finishEmail = resolve; });
    binding.send.mockImplementation(() => pendingEmail);
    const keys = await generateTestKeys();
    const push = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", push);
    try {
      await runInDurableObject(vault, (instance: SchwabVault) => withEmailEnv(instance, binding, async () => {
        instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/pending-email", keys }, label: "Independent" });
        instance.notifications.recordEvent({ dedupeKey: "pending-email", type: "TRADE_RESULT", entityId: "trade", summary: "Result", executionStatus: "EXECUTION_UNCERTAIN" });
        const alarm = instance.alarm();
        try {
          await vi.waitFor(() => { expect(push).toHaveBeenCalledTimes(1); });
          expect(binding.send).toHaveBeenCalledTimes(1);
        } finally {
          finishEmail?.({ messageId: "local-test-message" });
          await alarm;
        }
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the single earliest push/email deadline for pending attempts and leased sends", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const keys = await generateTestKeys();
    await runInDurableObject(vault, (instance: SchwabVault) => withEmailEnv(instance, emailBinding(), () => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        instance.notifications.subscribe({ subscription: { endpoint: "https://web.push.apple.com/shared-alarm", keys }, label: "Shared alarm" });
        instance.notifications.recordEvent({ dedupeKey: "shared-alarm", type: "TRADE_RESULT", entityId: "trade", summary: "Result", executionStatus: "EXECUTION_UNCERTAIN" });
        const [push] = instance.notifications.claimDeliveriesForDispatch(1, 60_000);
        const [email] = instance.notifications.claimEmailDeliveriesForDispatch();
        if (!push || !email) throw new Error("Missing independent delivery claims");
        expect(instance.notifications.getNextAlarmTime()).toBe(now + 60_000);
        instance.notifications.recordDeliveryOutcome(push.deliveryId, push.subscription.id, { leaseUntil: push.leaseUntil, status: "RETRY", nextAttemptAt: now + 150_000 });
        expect(instance.notifications.getNextAlarmTime()).toBe(now + 120_000);
        instance.notifications.recordEmailDeliveryOutcome(email.deliveryId, { leaseUntil: email.leaseUntil, status: "RETRY", nextAttemptAt: now + 30_000 });
        expect(instance.notifications.getNextAlarmTime()).toBe(now + 30_000);
      } finally {
        clock.mockRestore();
      }
    }));
  });
});

describe("Owner email configuration failure isolation", () => {
  it("suppresses an existing task with invalid deployment configuration and logs no addresses or raw error", async () => {
    const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
    const binding = emailBinding();
    await runInDurableObject(vault, (instance: SchwabVault, state) => withEmailEnv(instance, binding, async runtime => {
      instance.notifications.triggerTestEmail();
      Reflect.set(runtime, "ALERT_EMAIL_TO", "invalid-address-private-sentinel");
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        await instance.alarm();
        expect(binding.send).not.toHaveBeenCalled();
        expect(state.storage.sql.exec("SELECT status FROM email_delivery").toArray()).toEqual([{ status: "SUPPRESSED" }]);
        const entries = logs.mock.calls.map(([value]) => JSON.parse(String(value)) as Record<string, unknown>);
        const configuration = entries.filter(value => value.event === "email_alert_configuration_invalid");
        expect(configuration).toHaveLength(1);
        expect(configuration[0]).toEqual({ event: "email_alert_configuration_invalid", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown });
        expect(JSON.stringify(entries)).not.toMatch(/invalid-address-private-sentinel|alerts@example.com|owner@example.net/);
      } finally {
        logs.mockRestore();
      }
    }));
  });
});
