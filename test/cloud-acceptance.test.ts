import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/env";

const host = "https://schwab-mcp.siruichen461.workers.dev";
const gate = "__Host-schwab-acceptance=test-only-key";
function config(): AppEnv { return { ...env, ACCEPTANCE_KEY: "test-only-key" } as unknown as AppEnv; }
async function call(path: string, init: RequestInit = {}, appEnv = config()) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(host + path, init), appEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
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
    for (const path of ["/token", "/accounts", "/trade/prepare", "/trade/confirm", "/request"]) {
      expect((await stub.fetch("https://vault" + path, { method: "POST", body: "{}" })).status).toBe(403);
    }
  });
});
