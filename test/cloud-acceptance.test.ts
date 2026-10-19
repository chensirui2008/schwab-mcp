import { env } from "cloudflare:workers";
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";
import type { AcceptanceVault } from "../src/acceptance";

const host = "https://schwab-mcp.siruichen461.workers.dev";
const gate = "__Host-schwab-acceptance=test-only-key";
function mockLimiter(): RateLimit {
  return {
    limit() {
      return Promise.resolve({ success: true });
    },
  };
}
function config(): AppEnv {
  return {
    ...env,
    ACCEPTANCE_KEY: "test-only-key",
    BROWSER_AUTH_RATE_LIMITER: mockLimiter(),
    ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER: mockLimiter(),
  } as unknown as AppEnv;
}
async function call(path: string, init: RequestInit = {}, appEnv = config()) {
  const headers = new Headers(init.headers);
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", "192.0.2.10");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(host + path, { ...init, headers }), appEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("same-Worker cloud acceptance isolation", () => {
  it("is disabled without the optional secret and gates every main-origin route", async () => {
    const disabled = config(); delete disabled.ACCEPTANCE_KEY;
    expect((await call("/__test/start", {}, disabled)).status).toBe(404);
    expect((await call("/__test/start")).status).toBe(401);
  });
  it("rejects cross-origin unlock, account, trading and direct token routes", async () => {
    expect((await call("/__test/unlock", { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams({ key: "test-only-key" }) })).status).toBe(403);
    for (const path of ["/mcp", "/oauth/token", "/auth/schwab/connect", "/auth/schwab/callback"]) {
      expect((await call("/__test" + path, { headers: { Cookie: gate + "; __Host-schwab-test-run=" + crypto.randomUUID() } })).status).toBe(403);
    }
  });
  it("creates consent in separate storage and rewrites form/cookies without weakening CSP", async () => {
    const start = await call("/__test/start?mode=plain", { headers: { Cookie: gate } });
    expect(start.status).toBe(302);
    const run = start.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    const location = start.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/__test\/authorize\?/);
    const consent = await call(location, { headers: { Cookie: gate + "; " + run + "; __Host-schwab-consent=production-cookie" } });
    expect(consent.status).toBe(200);
    expect(consent.headers.get("Content-Security-Policy")).toContain("form-action 'self'");
    expect(consent.headers.getSetCookie().join()).toContain("__Host-schwab-test-oauth=");
    expect(await consent.text()).toContain('action="/__test/authorize/approve"');
    const regular = await call(location.replace("/__test", ""));
    expect(regular.status).toBeGreaterThanOrEqual(400); // The test client does not exist in production OAuth KV.
  });
  it("completes the gated OAuth flow using only the acceptance limiter and never inherits owner email", async () => {
    const productionLimit = vi.fn<RateLimit["limit"]>(() => Promise.resolve({ success: false }));
    const acceptanceLimit = vi.fn<RateLimit["limit"]>(() => Promise.resolve({ success: true }));
    const send = vi.fn(() => Promise.reject(new Error("Production email must never be called")));
    const appEnv: AppEnv = {
      ...config(),
      BROWSER_AUTH_RATE_LIMITER: { limit: productionLimit },
      ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER: { limit: acceptanceLimit },
      OWNER_ALERT_EMAIL: { send },
      EMAIL_ALERTS_ENABLED: "true",
      ALERT_EMAIL_FROM: "alerts@example.com",
      ALERT_EMAIL_TO: "owner@example.net",
    };
    const upstream = vi.fn(() => Promise.reject(new Error("Acceptance must not make external requests")));
    vi.stubGlobal("fetch", upstream);
    expect((await call("/__test/start?mode=plain", {}, appEnv)).status).toBe(401);
    expect((await call("/__test/authorize?code_challenge=" + "a".repeat(43) + "&code_challenge_method=S256", {}, appEnv)).status).toBe(401);
    expect(productionLimit).not.toHaveBeenCalled();
    expect(acceptanceLimit).not.toHaveBeenCalled();
    const jar = new Map<string, string>([["__Host-schwab-acceptance", "test-only-key"]]);
    const browserCall = async (path: string, init: RequestInit = {}) => {
      const url = new URL(path, host);
      const response = await call(url.pathname + url.search, {
        ...init,
        headers: { Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...Object.fromEntries(new Headers(init.headers)) },
      }, appEnv);
      for (const value of response.headers.getSetCookie()) {
        const pair = value.split(";")[0] ?? "";
        const separator = pair.indexOf("=");
        jar.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
      return response;
    };
    const start = await browserCall("/__test/start?mode=plain");
    expect(start.status).toBe(302);
    const consent = await browserCall(start.headers.get("Location") ?? "");
    expect(consent.status).toBe(200);
    const state = (await consent.text()).match(/name="state" value="([^"]+)"/)?.[1];
    expect(state).toBeTruthy();
    const approved = await browserCall("/__test/authorize/approve", {
      method: "POST", body: new URLSearchParams({ state: state ?? "", permissionLevel: "full_access" }),
    });
    expect(approved.status).toBe(200);
    const provider = (await approved.text()).match(/id="github-continue" href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
    expect(provider).toBeTruthy();
    const mock = await browserCall(provider ?? "");
    expect(mock.status).toBe(302);
    const callback = await browserCall(mock.headers.get("Location") ?? "");
    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toContain("/__test/client/callback?");
    const client = await browserCall(callback.headers.get("Location") ?? "");
    expect(client.status).toBe(303);
    const complete = await browserCall(client.headers.get("Location") ?? "");
    expect(complete.status).toBe(200);
    expect(await complete.text()).toContain('"tokenExchange":200,"mcpStatus":200');
    expect(acceptanceLimit).toHaveBeenCalledTimes(2);
    expect(acceptanceLimit.mock.calls.map(([input]) => input.key)).toEqual([
      "schwab-mcp:browser-auth:192.0.2.10", "schwab-mcp:browser-auth:192.0.2.10",
    ]);
    // Exercise the actual isolated DO's notification creation and dispatcher, not a source assertion.
    const run = jar.get("__Host-schwab-test-run");
    if (!run || !appEnv.ACCEPTANCE_VAULT) throw new Error("Missing acceptance run");
    const stub: DurableObjectStub<AcceptanceVault> = env.ACCEPTANCE_VAULT.get(env.ACCEPTANCE_VAULT.idFromName(run));
    await runInDurableObject(stub, async (instance: AcceptanceVault, state) => {
      instance.notifications.recordEvent({
        dedupeKey: "acceptance-reauth", type: "SCHWAB_REAUTH_REQUIRED", entityId: "acceptance-generation", summary: "需要重新授权",
      });
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT id FROM email_delivery").toArray()).toEqual([]);
    });
    expect((await browserCall("/__test/dashboard/api/email/test", {
      method: "POST", headers: { Origin: host, "Content-Type": "application/json", "X-CSRF-Token": "test" }, body: "{}",
    })).status).toBe(403);
    acceptanceLimit.mockResolvedValue({ success: false });
    const denied = await browserCall("/__test/security/recover");
    // Recovery is deliberately not exposed by the acceptance router.
    expect(denied.status).toBe(403);
    const deniedAuthorization = await browserCall(start.headers.get("Location") ?? "");
    expect(deniedAuthorization.status).toBe(429);
    expect(await deniedAuthorization.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(productionLimit).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it("restricts the mock provider to the gated test origin and callback", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request("https://schwab-mcp.siruichen461.workers.dev/__test/mock/github?redirect_uri=https://evil.example&state=" + "a".repeat(64), { headers: { Cookie: gate } }), config(), ctx);
    expect(response.status).toBe(400);
    await waitOnExecutionContext(ctx);
  });
  it("test Durable Object refuses credentials, accounts and all trading operations", async () => {
    const namespace = config().ACCEPTANCE_VAULT;
    if (!namespace) throw new Error("Missing test binding");
    const stub = namespace.get(namespace.idFromName(crypto.randomUUID()));
    for (const path of ["/token", "/accounts", "/trade/prepare", "/trade/confirm", "/request", "/client/policy"]) {
      expect((await stub.fetch("https://vault" + path, { method: "POST", body: "{}" })).status).toBe(403);
    }
  });
});
