import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../src/auth";
import { vaultStub, type AppEnv } from "../src/env";
import worker from "../src/index";
import { AUTHORIZATION_VERSION, READ_SCOPE } from "../src/oauth-access";

const origin = "https://example.com";
const redirectUri = "https://rate-limit-client.example/callback";
const ip = "192.0.2.10";
const options: OAuthProviderOptions<AppEnv> = {
  authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp", apiHandler: { fetch: () => Response.json({}) }, defaultHandler: AuthHandler, scopesSupported: [READ_SCOPE],
};

function limiter(success = true) {
  return { limit: vi.fn<RateLimit["limit"]>(() => Promise.resolve({ success })) };
}
function setup() {
  const admission = limiter();
  const appEnv = { ...env, BROWSER_AUTH_RATE_LIMITER: admission, ENABLE_TRADING: "false" } as unknown as AppEnv;
  appEnv.OAUTH_PROVIDER = getOAuthApi(options, appEnv);
  return { appEnv, admission };
}
// Deliberately do not fill CF-Connecting-IP here: missing-header cases must reach production unchanged.
async function call(appEnv: AppEnv, path: string, init: RequestInit = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(new URL(path, origin), init), appEnv, ctx);
  const body = response.body === null ? null : await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function cookie(response: Response, name = "__Host-schwab-oauth") {
  return response.headers.getSetCookie().find(value => value.startsWith(name + "="))?.split(";")[0] ?? "";
}
async function authorization(appEnv: AppEnv) {
  const client = await appEnv.OAUTH_PROVIDER.createClient({ redirectUris: [redirectUri], clientName: "Admission test", tokenEndpointAuthMethod: "none" });
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const request = { responseType: "code", clientId: client.clientId, redirectUri, scope: [READ_SCOPE], state: "client-state", codeChallenge: challenge, codeChallengeMethod: "S256" };
  const params = new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, response_type: "code", scope: READ_SCOPE, state: request.state, code_challenge: challenge, code_challenge_method: "S256" });
  return { request, verifier, path: `/authorize?${params}` };
}
async function consent(appEnv: AppEnv) {
  const auth = await authorization(appEnv);
  const response = await call(appEnv, auth.path, { headers: { "CF-Connecting-IP": ip } });
  expect(response.status).toBe(200);
  const state = (await response.text()).match(/name="state" value="([^"]+)"/)?.[1];
  if (!state) throw new Error("Missing consent state");
  return { ...auth, state, flowCookie: cookie(response) };
}
async function states(appEnv: AppEnv) {
  return runInDurableObject(vaultStub(appEnv), (_instance, state) => state.storage.sql.exec(
    "SELECT state, kind, payload, expires_at FROM oauth_state ORDER BY state",
  ).toArray());
}
async function admissionError(response: Response, status: 429 | 503) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("Retry-After")).toBe(status === 429 ? "60" : null);
  expect(response.headers.get("Location")).toBeNull();
  const body = await response.json<{ error: { code: string; message: string; requestId: string } }>();
  expect(body).toEqual({ error: {
    code: status === 429 ? "RATE_LIMITED" : "UPSTREAM_UNAVAILABLE",
    message: status === 429 ? "Too many authorization attempts; retry later" : "Authorization admission is unavailable; retry later",
    requestId: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/) as unknown,
  } });
}
const entries = ["authorize", "approve", "connect", "dashboard-login", "recover", "dashboard", "security", "approval", "authorization", "notification"] as const;
type Entry = typeof entries[number];
interface ConsentFlow {
  path: string;
  state: string;
  flowCookie: string;
}
function entry(entrypoint: Entry, flow: ConsentFlow) {
  switch (entrypoint) {
    case "authorize": return { path: flow.path + "&lang=en-US", init: {} };
    case "approve": return { path: "/authorize/approve", init: { method: "POST", body: new URLSearchParams({ state: flow.state, permissionLevel: "read_only" }) } };
    case "connect": return { path: "/auth/schwab/connect", init: {} };
    case "dashboard-login": return { path: "/dashboard/login", init: {} };
    case "recover": return { path: "/security/recover", init: {} };
    case "dashboard": return { path: "/dashboard", init: {} };
    case "security": return { path: "/security", init: {} };
    case "approval": return { path: "/security/approvals/test-proposal", init: {} };
    case "authorization": return { path: "/security/authorizations/test-authorization", init: {} };
    case "notification": return { path: "/dashboard/notifications/" + "12345678-1234-4234-8234-123456789abc", init: {} };
  }
}

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("browser authorization admission", () => {
  it.each(entries)("denies %s without creating/consuming state, replacing cookies or requesting an upstream", async entrypoint => {
    const { appEnv, admission } = setup();
    const flow = await consent(appEnv);
    const before = await states(appEnv);
    admission.limit.mockClear();
    admission.limit.mockResolvedValue({ success: false });
    const upstream = vi.fn(() => Promise.reject(new Error("Unexpected upstream request")));
    vi.stubGlobal("fetch", upstream);
    const target = entry(entrypoint, flow);
    const response = await call(appEnv, target.path, { ...target.init, headers: { "CF-Connecting-IP": ip, Cookie: flow.flowCookie + "; __Host-schwab-security=stale-session" } });
    await admissionError(response, 429);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await states(appEnv)).toEqual(before);
    expect(admission.limit).toHaveBeenCalledExactlyOnceWith({ key: `schwab-mcp:browser-auth:${ip}` });
    expect(upstream).not.toHaveBeenCalled();
    // The denied approval cannot burn consent: the same browser can approve after admission resumes.
    admission.limit.mockResolvedValue({ success: true });
    const approved = await call(appEnv, "/authorize/approve", { method: "POST", headers: { "CF-Connecting-IP": ip, Cookie: flow.flowCookie }, body: new URLSearchParams({ state: flow.state, permissionLevel: "read_only" }) });
    expect(approved.status).toBe(200);
    expect(await approved.text()).toContain('id="github-continue"');
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["missing-ip", "empty-ip", "missing-binding", "rejected-binding"] as const)("fails closed for %s on every explicit entry and implicit login", async failure => {
    const { appEnv, admission } = setup();
    const flow = await consent(appEnv);
    const before = await states(appEnv);
    admission.limit.mockClear();
    if (failure === "missing-binding") delete appEnv.BROWSER_AUTH_RATE_LIMITER;
    if (failure === "rejected-binding") admission.limit.mockRejectedValue(new Error("sensitive upstream diagnostic"));
    const upstream = vi.fn(() => Promise.reject(new Error("Unexpected upstream request")));
    vi.stubGlobal("fetch", upstream);
    for (const entrypoint of entries) {
      const target = entry(entrypoint, flow);
      const headers = new Headers({ Cookie: flow.flowCookie, "X-Forwarded-For": ip });
      if (failure !== "missing-ip") headers.set("CF-Connecting-IP", failure === "empty-ip" ? "   " : ip);
      const response = await call(appEnv, target.path, { ...target.init, headers });
      await admissionError(response, 503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await states(appEnv)).toEqual(before);
    }
    expect(admission.limit).toHaveBeenCalledTimes(failure === "rejected-binding" ? entries.length : 0);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("uses only the normalized connecting IP, independent of client, query, cookies and entrypoint", async () => {
    const { appEnv } = setup();
    const first = await authorization(appEnv);
    const second = await authorization(appEnv);
    const buckets = new Set<string>();
    const limit = vi.fn(({ key }: { key: string }) => {
      const success = !buckets.has(key);
      buckets.add(key);
      return Promise.resolve({ success });
    });
    appEnv.BROWSER_AUTH_RATE_LIMITER = { limit };
    expect((await call(appEnv, first.path, { headers: { "CF-Connecting-IP": `  ${ip}  ` } })).status).toBe(200);
    await admissionError(await call(appEnv, second.path + "&lang=en-US", { headers: { "CF-Connecting-IP": ip, Cookie: "clientId=different; schwab_lang=en-US", "X-Forwarded-For": "192.0.2.99" } }), 429);
    await admissionError(await call(appEnv, "/auth/schwab/connect?clientId=third", { headers: { "CF-Connecting-IP": ip } }), 429);
    expect((await call(appEnv, second.path, { headers: { "CF-Connecting-IP": "192.0.2.11", "X-Forwarded-For": ip } })).status).toBe(200);
    expect(limit.mock.calls.map(([value]) => value.key)).toEqual([
      `schwab-mcp:browser-auth:${ip}`, `schwab-mcp:browser-auth:${ip}`, `schwab-mcp:browser-auth:${ip}`, "schwab-mcp:browser-auth:192.0.2.11",
    ]);
  });

  it.each(["/dashboard", "/security", "/security/approvals/test", "/security/authorizations/test", "/dashboard/notifications/12345678-1234-4234-8234-123456789abc"])("counts %s implicit login exactly once", async path => {
    const { appEnv, admission } = setup();
    const response = await call(appEnv, path, { headers: { "CF-Connecting-IP": ip } });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location") ?? "").origin).toBe("https://github.com");
    expect(cookie(response)).toBeTruthy();
    expect(admission.limit).toHaveBeenCalledExactlyOnceWith({ key: `schwab-mcp:browser-auth:${ip}` });
    const rows = await states(appEnv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "github" });
  });

  it("keeps PKCE and origin checks ahead of admission", async () => {
    const { appEnv, admission } = setup();
    admission.limit.mockResolvedValue({ success: false });
    expect((await call(appEnv, "/authorize?code_challenge=bad&code_challenge_method=plain")).status).toBe(400);
    expect((await call(appEnv, "https://evil.example/dashboard/login", { headers: { "CF-Connecting-IP": ip } })).status).toBe(403);
    expect((await call(appEnv, "https://evil.example/security/recover", { headers: { "CF-Connecting-IP": ip } })).status).toBe(403);
    expect(admission.limit).not.toHaveBeenCalled();
  });

  it("finishes already-admitted GitHub and Schwab callbacks even when admission subsequently denies", async () => {
    const { appEnv, admission } = setup();
    const start = await call(appEnv, "/auth/schwab/connect", { headers: { "CF-Connecting-IP": ip } });
    expect(start.status).toBe(302);
    admission.limit.mockClear();
    admission.limit.mockResolvedValue({ success: false });
    const upstream = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "fake-github-token" }))
      .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null }))
      .mockResolvedValueOnce(Response.json({ access_token: "fake-schwab-token", refresh_token: "fake-schwab-refresh", expires_in: 1800 }));
    vi.stubGlobal("fetch", upstream);
    const githubState = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    const github = await call(appEnv, `/auth/github/callback?state=${githubState}&code=fake-code`, { headers: { Cookie: cookie(start) } });
    expect(github.status).toBe(302);
    const schwabState = new URL(github.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    const schwab = await call(appEnv, `/auth/schwab/callback?state=${schwabState}&code=fake-code`, { headers: { Cookie: cookie(github) } });
    expect(schwab.status).toBe(303);
    expect(new URL(schwab.headers.get("Location") ?? "", origin).pathname).toBe("/auth/schwab/complete");
    const status = await vaultStub(appEnv).fetch("https://vault/status");
    expect(await status.json()).toMatchObject({ connected: true });
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(admission.limit).not.toHaveBeenCalled();
    expect(await states(appEnv)).toEqual([]);
  });

  it("does not charge existing browser sessions, polling or dashboard/security APIs", async () => {
    const { appEnv, admission } = setup();
    const start = await call(appEnv, "/dashboard", { headers: { "CF-Connecting-IP": ip } });
    const state = new URL(start.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "fake-owner-token" }))
      .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null })));
    admission.limit.mockClear();
    admission.limit.mockResolvedValue({ success: false });
    const loggedIn = await call(appEnv, `/auth/github/callback?state=${state}&code=fake-code`, { headers: { Cookie: cookie(start) } });
    expect(loggedIn.status).toBe(302);
    const securityCookie = cookie(loggedIn, "__Host-schwab-security");
    expect(securityCookie).toBeTruthy();
    for (const path of ["/dashboard", "/security", "/dashboard/api/session", "/dashboard/api/overview", "/dashboard/api/notifications", "/dashboard/api/pending-approvals"]) {
      expect((await call(appEnv, path, { headers: { Cookie: securityCookie } })).status).toBe(200);
    }
    for (let poll = 0; poll < 2; poll++) {
      const response = await call(appEnv, "/security/api/authorization-status/not-present", { headers: { Cookie: securityCookie } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ authorizationId: "not-present", status: "EXPIRED" });
    }
    expect((await call(appEnv, "/dashboard/api/session")).status).toBe(403);
    expect((await call(appEnv, "/security/api/options", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
    expect(admission.limit).not.toHaveBeenCalled();
    // Explicit renewal remains an admission point, even for a valid session.
    await admissionError(await call(appEnv, "/dashboard/login", { headers: { Cookie: securityCookie, "CF-Connecting-IP": ip } }), 429);
    expect(admission.limit).toHaveBeenCalledTimes(1);
  });

  it("leaves discovery, registration, token exchange/refresh, OPTIONS and MCP outside the browser limiter", async () => {
    const { appEnv, admission } = setup();
    const flow = await authorization(appEnv);
    const granted = await appEnv.OAUTH_PROVIDER.completeAuthorization({
      request: flow.request, userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE], metadata: {},
      props: { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel: "read_only", authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256" },
    });
    admission.limit.mockResolvedValue({ success: false });
    const upstream = vi.fn(() => Promise.reject(new Error("Unexpected upstream request")));
    vi.stubGlobal("fetch", upstream);
    for (const path of ["/", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      expect((await call(appEnv, path)).status).toBe(200);
    }
    const registration = await call(appEnv, "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Excluded registration", token_endpoint_auth_method: "none" }) });
    expect(registration.status).toBe(201);
    const exchanged = await call(appEnv, "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: flow.request.clientId, redirect_uri: redirectUri, code: new URL(granted.redirectTo).searchParams.get("code") ?? "", code_verifier: flow.verifier }) });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json<{ access_token: string; refresh_token: string }>();
    const refreshed = await call(appEnv, "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", client_id: flow.request.clientId, refresh_token: tokens.refresh_token }) });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json<{ access_token: string }>();
    expect((await call(appEnv, "/mcp", { method: "OPTIONS", headers: { Origin: "https://client.example", "Access-Control-Request-Method": "POST" } })).status).toBe(204);
    expect((await call(appEnv, "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(401);
    const mcp = await call(appEnv, "/mcp", { method: "POST", headers: { Authorization: `Bearer ${next.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(mcp.status).toBe(200);
    expect(await mcp.text()).toContain('"tools"');
    expect(admission.limit).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
});
