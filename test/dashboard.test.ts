import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../src/auth";
import type { AppEnv } from "../src/env";
import { vaultStub } from "../src/env";
import worker from "../src/index";
import { AUTHORIZATION_VERSION, READ_SCOPE } from "../src/oauth-access";
import type { PermissionLevel } from "../src/oauth-access";
import { SecurityStore } from "../src/security-store";
import type { BrowserSession } from "../src/security-store";
import { authenticator } from "./webauthn-fixture";

const origin = "https://example.com";
const redirectUri = "https://dashboard-client.example/callback";
const providerOptions: OAuthProviderOptions<AppEnv> = {
  authorizeEndpoint: "/authorize", tokenEndpoint: "/oauth/token", clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp", apiHandler: { fetch: () => Response.json({}) }, defaultHandler: AuthHandler, scopesSupported: [READ_SCOPE],
};
interface Tokens { access_token: string; refresh_token: string }
interface Challenge { challengeId: string; options: { challenge: string }; registration: boolean }
interface Client {
  clientId: string; clientName: string; redirectUris: string[]; createdAt: number; lastInvocationAt: number | null;
  permissionLevel: PermissionLevel; advancedSecurity: boolean; version: number; revoked: boolean;
}
interface AuditItem {
  id: string; clientId: string; toolName: string; requestId: string; status: "SUCCESS" | "ERROR";
  parametersSummary: string | null; errorCode: string | null; errorMessage: string | null; durationMs: number; createdAt: number;
}
interface AuditPage { items: AuditItem[]; total: number; successCount: number; errorCount: number; active24h: number; limit: number; offset: number }
interface DashboardBrowser {
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  raw(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  security(action: string, body: unknown): Promise<Response>;
  securityCookie: string;
  csrf: string;
}

function setup() {
  const appEnv = { ...env } as unknown as AppEnv;
  appEnv.OAUTH_PROVIDER = getOAuthApi(providerOptions, appEnv);
  return appEnv;
}
async function dispatch(request: Request, appEnv: AppEnv) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, appEnv, ctx);
  // Streamable HTTP can finish its tool handler after response headers arrive.
  // Consume the finite response before draining audits registered by that send.
  const body = response.body === null ? null : await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
function cookie(response: Response, name: string) {
  return response.headers.get("set-cookie")?.match(new RegExp(`${name}=([^;]+)`))?.[0] ?? "";
}
function tokenRequest(body: Record<string, string>) {
  return new Request(`${origin}/oauth/token`, { method: "POST", body: new URLSearchParams(body) });
}
async function authorize(appEnv: AppEnv, permissionLevel: PermissionLevel = "full_access", clientName = "Dashboard client", existingClientId?: string) {
  const clientId = existingClientId ?? (await appEnv.OAUTH_PROVIDER.createClient({ redirectUris: [redirectUri], clientName, tokenEndpointAuthMethod: "none" })).clientId;
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const { redirectTo } = await appEnv.OAUTH_PROVIDER.completeAuthorization({
    request: { responseType: "code", clientId, redirectUri, scope: [READ_SCOPE], state: "dashboard-test", codeChallenge, codeChallengeMethod: "S256" },
    userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE], metadata: { permissionLevel, advancedSecurity: false, authorizationVersion: AUTHORIZATION_VERSION }, revokeExistingGrants: false,
    props: { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel, authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256" },
  });
  const response = await dispatch(tokenRequest({ grant_type: "authorization_code", client_id: clientId, code: new URL(redirectTo).searchParams.get("code") ?? "", redirect_uri: redirectUri, code_verifier: verifier }), appEnv);
  expect(response.status).toBe(200);
  return { clientId, tokens: await response.json<Tokens>() };
}
function mcp(accessToken: string, method: string, params: unknown = {}) {
  return new Request(`${origin}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
async function tool(appEnv: AppEnv, tokens: Tokens, name: string, args: unknown = {}) {
  return dispatch(mcp(tokens.access_token, "tools/call", { name, arguments: args }), appEnv);
}
async function beginLogin(appEnv: AppEnv, path = "/dashboard", owner = true) {
  const start = await dispatch(new Request(`${origin}${path}`), appEnv);
  expect(start.status).toBe(302);
  const github = new URL(start.headers.get("location") ?? "");
  expect(github.origin).toBe("https://github.com");
  const githubFetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ access_token: "fake-dashboard-github-token" }))
    .mockResolvedValueOnce(Response.json({ id: owner ? Number(appEnv.ALLOWED_GITHUB_USER_ID) : 999999, login: "owner", name: null }));
  vi.stubGlobal("fetch", githubFetch);
  const callback = await dispatch(new Request(`${origin}/auth/github/callback?state=${github.searchParams.get("state") ?? ""}&code=fake-code`, { headers: { Cookie: cookie(start, "__Host-schwab-oauth") } }), appEnv);
  vi.unstubAllGlobals();
  expect(githubFetch).toHaveBeenCalledTimes(2);
  return callback;
}
function browser(appEnv: AppEnv, securityCookie: string, csrf: string): DashboardBrowser {
  const get = (path: string) => dispatch(new Request(`${origin}/dashboard/api/${path}`, { headers: { Cookie: securityCookie } }), appEnv);
  const raw = (path: string, body: string, headers: Record<string, string> = {}) => dispatch(new Request(`${origin}${path}`, {
    method: "POST", headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...headers }, body,
  }), appEnv);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => raw(`/dashboard/api/${path}`, JSON.stringify(body), headers);
  const security = (action: string, body: unknown) => raw(`/security/api/${action}`, JSON.stringify(body));
  return { get, post, raw, security, securityCookie, csrf };
}
async function login(appEnv: AppEnv) {
  const callback = await beginLogin(appEnv);
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/dashboard");
  const securityCookie = cookie(callback, "__Host-schwab-security");
  expect(securityCookie).toBeTruthy();
  const page = await dispatch(new Request(`${origin}/dashboard`, { headers: { Cookie: securityCookie } }), appEnv);
  expect(page.status).toBe(200);
  expect(page.headers.get("Cache-Control")).toBe("no-store");
  expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  expect(page.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(page.headers.get("Referrer-Policy")).toBe("no-referrer");
  const html = await page.text();
  expect(html).toContain('name="session-expires" content="');
  const csrf = html.match(/name="csrf" content="([^"]+)"/)?.[1] ?? "";
  expect(csrf).toBeTruthy();
  return browser(appEnv, securityCookie, csrf);
}
async function postVault(appEnv: AppEnv, path: string, data: unknown) {
  return vaultStub(appEnv).fetch(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
}
async function connectSchwab(appEnv: AppEnv) {
  const response = await vaultStub(appEnv).fetch("https://vault/token", { method: "PUT", body: JSON.stringify({ access_token: "fake-access-secret", refresh_token: "fake-refresh-secret", expires_in: 1800 }) });
  expect(response.status).toBe(204);
}
async function clients(ui: DashboardBrowser) {
  const response = await ui.get("clients");
  expect(response.status).toBe(200);
  return (await response.json<{ clients: Client[] }>()).clients;
}
async function clientRow(ui: DashboardBrowser, clientId: string) {
  const row = (await clients(ui)).find(row => row.clientId === clientId);
  if (!row) throw new Error(`Expected dashboard client ${clientId}`);
  return row;
}
async function audit(ui: DashboardBrowser, query = "") {
  const response = await ui.get(`audit${query}`);
  expect(response.status).toBe(200);
  return response.json<AuditPage>();
}
async function activate(ui: DashboardBrowser, clientId: string) {
  const key = await authenticator();
  const response = await ui.post("clients/advanced-security", { clientId, advancedSecurity: true });
  expect(response.status).toBe(200);
  const challenge = await response.json<Challenge>();
  expect(challenge.registration).toBe(true);
  const verified = await ui.post("clients/advanced-security", { clientId, advancedSecurity: true, challengeId: challenge.challengeId, response: await key.register(challenge.options.challenge) });
  expect(verified.status).toBe(200);
  return key;
}

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Dashboard owner authentication and browser boundaries", () => {
  it("requires numeric GitHub owner OAuth, preserves returnTo, and never exposes session secrets", async () => {
    const appEnv = setup();
    for (const path of ["overview", "clients", "audit", "session"]) {
      expect((await dispatch(new Request(`${origin}/dashboard/api/${path}`), appEnv)).status).toBe(403);
    }
    const forbidden = await beginLogin(appEnv, "/dashboard", false);
    expect(forbidden.status).toBe(403);
    expect(cookie(forbidden, "__Host-schwab-security")).toBe("");
    const ui = await login(appEnv);
    const response = await ui.get("session");
    expect(await response.json()).toEqual({ credentials: [] });
    expect((await ui.get("overview")).headers.get("Cache-Control")).toBe("no-store");
    const bearer = await authorize(appEnv);
    expect((await dispatch(new Request(`${origin}/dashboard/api/session`, { headers: { Authorization: `Bearer ${bearer.tokens.access_token}` } }), appEnv)).status).toBe(403);
  });

  it.each(["recovery", "pending"] as const)("does not treat a %s ceremony session as a dashboard login", async kind => {
    const appEnv = setup();
    const created = await postVault(appEnv, "/security/session/create", kind === "recovery" ? { recovery: true } : {
      pending: { authRequest: { clientId: "restricted", redirectUri, responseType: "code", scope: [READ_SCOPE], state: "test", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }, permissionLevel: "full_access", advancedSecurity: true, username: "owner", policyVersion: 0 },
    });
    const state = await created.json<{ sessionId: string; session: BrowserSession }>();
    const ui = browser(appEnv, `__Host-schwab-security=${state.sessionId}`, state.session.csrf);
    for (const path of ["session", "overview", "clients", "audit"]) expect((await ui.get(path)).status).toBe(403);
    expect((await ui.post("clients/permission", { clientId: "restricted", permissionLevel: "full_access" })).status).toBe(403);
    const page = await dispatch(new Request(`${origin}/dashboard`, { headers: { Cookie: ui.securityCookie } }), appEnv);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
  });

  it("rejects missing or wrong CSRF, cross-origin and non-JSON writes without changing policy", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv);
    for (const path of ["clients/permission", "clients/revoke", "clients/advanced-security"]) {
      const body = { clientId: client.clientId, permissionLevel: "read_only", advancedSecurity: true };
      for (const headers of [{ "X-CSRF-Token": "" }, { "X-CSRF-Token": "wrong" }, { Origin: "https://evil.example" }, { "Content-Type": "text/plain" }]) {
        expect((await ui.post(path, body, headers)).status).toBe(403);
      }
    }
    expect((await clients(ui))[0]).toMatchObject({ permissionLevel: "full_access", advancedSecurity: false, revoked: false });
  });

  it("bounds actual UTF-8 body bytes and rejects malformed JSON, arrays and null", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv);
    for (const path of ["clients/permission", "clients/revoke", "clients/advanced-security"]) {
      for (const body of ["null", "[]", "{", "42", JSON.stringify({ clientId: "", permissionLevel: "root", advancedSecurity: "yes" })]) {
        expect((await ui.raw(`/dashboard/api/${path}`, body)).status).toBe(400);
      }
      const body = JSON.stringify({ clientId: client.clientId, permissionLevel: "read_only", advancedSecurity: true, padding: "界".repeat(22_000) });
      expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(65_536);
      expect((await ui.raw(`/dashboard/api/${path}`, body)).status).toBe(413);
    }
    expect((await clients(ui))[0]).toMatchObject({ permissionLevel: "full_access", advancedSecurity: false, revoked: false });
  });

  it("expires the dashboard owner session after fifteen minutes", async () => {
    const appEnv = setup(); const ui = await login(appEnv);
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 900_001);
    expect((await ui.get("session")).status).toBe(403);
    expect((await ui.post("clients/revoke", { clientId: "any" })).status).toBe(403);
  });
});

describe("Dashboard client policies and live OAuth enforcement", () => {
  it.each([undefined, "previous-policy"])("reports legacy grants (%s) without breaking current clients or initializing legacy policies", async authorizationVersion => {
    const appEnv = setup();
    const current = await authorize(appEnv);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1000);
    const legacyClient = await appEnv.OAUTH_PROVIDER.createClient({ redirectUris: [redirectUri], clientName: "Legacy client", tokenEndpointAuthMethod: "none" });
    const legacyTokens: string[] = [];
    for (const clientId of [legacyClient.clientId, current.clientId]) {
      const { redirectTo } = await appEnv.OAUTH_PROVIDER.completeAuthorization({
        request: { responseType: "token", clientId, redirectUri, scope: [READ_SCOPE], state: "legacy" },
        userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE],
        metadata: { label: "Personal Schwab MCP", ...(authorizationVersion ? { authorizationVersion } : {}) }, props: { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner" },
        revokeExistingGrants: false,
      });
      legacyTokens.push(new URLSearchParams(new URL(redirectTo).hash.slice(1)).get("access_token") ?? "");
    }
    const ui = await login(appEnv);
    const overview = await ui.get("overview");
    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ clientCount: 1, legacyGrantCount: 2 });
    expect(await clients(ui)).toEqual([expect.objectContaining({ clientId: current.clientId, permissionLevel: "full_access", revoked: false })]);
    const policies = await runInDurableObject(vaultStub(appEnv), (_instance, state) => state.storage.sql.exec<{ client_id: string }>("SELECT client_id FROM client_security").toArray());
    expect(policies).not.toContainEqual({ client_id: legacyClient.clientId });
    for (const token of legacyTokens) expect((await dispatch(mcp(token, "tools/list"), appEnv)).status).toBe(401);
    expect((await ui.post("clients/permission", { clientId: legacyClient.clientId, permissionLevel: "full_access" })).status).toBe(400);
    expect((await ui.post("clients/revoke", { clientId: current.clientId })).status).toBe(200);
    const remaining = await appEnv.OAUTH_PROVIDER.listUserGrants(appEnv.ALLOWED_GITHUB_USER_ID);
    expect(remaining.items.every(grant => grant.clientId !== current.clientId)).toBe(true);
  });

  it("still rejects malformed permission metadata on a current grant", async () => {
    const appEnv = setup(); await authorize(appEnv); const ui = await login(appEnv);
    const page = await appEnv.OAUTH_PROVIDER.listUserGrants(appEnv.ALLOWED_GITHUB_USER_ID);
    vi.spyOn(appEnv.OAUTH_PROVIDER, "listUserGrants").mockResolvedValue({ items: page.items.map(grant => ({ ...grant, metadata: { authorizationVersion: AUTHORIZATION_VERSION } })) });
    for (const path of ["overview", "clients"]) {
      const response = await ui.get(path);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
    }
  });

  it("lists authorized clients, counts distinct clients across grant pages, and reports token health without credentials", async () => {
    const appEnv = setup(); const first = await authorize(appEnv, "full_access", "Trading desktop");
    const second = await authorize(appEnv, "read_only", "Research desktop");
    await connectSchwab(appEnv); const ui = await login(appEnv);
    const rows = await clients(ui);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ clientId: first.clientId, clientName: "Trading desktop", redirectUris: [redirectUri], permissionLevel: "full_access", revoked: false }),
      expect.objectContaining({ clientId: second.clientId, clientName: "Research desktop", permissionLevel: "read_only", advancedSecurity: false }),
    ]));
    for (const row of rows) { expect(row.createdAt).toBeGreaterThan(1_000_000_000_000); expect(row.lastInvocationAt).toBeNull(); }
    const all = await appEnv.OAUTH_PROVIDER.listUserGrants(appEnv.ALLOWED_GITHUB_USER_ID);
    vi.spyOn(appEnv.OAUTH_PROVIDER, "listUserGrants")
      .mockResolvedValueOnce({ items: all.items.slice(0, 1), cursor: "dashboard-next" })
      .mockResolvedValueOnce({ items: [...all.items.slice(0, 1), ...all.items.slice(1)] });
    const overview = await ui.get("overview");
    const health = await overview.clone().json<{ schwabStatus: { accessExpiresAt: number; refreshExpiresAt: number } }>();
    const text = await overview.text();
    expect(JSON.parse(text)).toMatchObject({ schwabConnected: true, tradingEnabled: true, clientCount: 2, toolCallsCount: 0, passkeyCount: 0 });
    expect(Number.isFinite(health.schwabStatus.accessExpiresAt)).toBe(true);
    expect(Number.isFinite(health.schwabStatus.refreshExpiresAt)).toBe(true);
    expect(text).not.toContain("fake-access-secret"); expect(text).not.toContain("fake-refresh-secret");
  });

  it("immediately downgrades an existing full-access token, synchronizes refresh, and isolates another client", async () => {
    const appEnv = setup(); const first = await authorize(appEnv); const second = await authorize(appEnv); const ui = await login(appEnv);
    expect(await (await dispatch(mcp(first.tokens.access_token, "tools/list"), appEnv)).text()).toContain('"name":"prepare_trade"');
    expect((await ui.post("clients/permission", { clientId: first.clientId, permissionLevel: "read_only" })).status).toBe(200);
    const rejected = await tool(appEnv, first.tokens, "prepare_trade", {});
    expect(await rejected.text()).toContain("not found");
    expect(await (await dispatch(mcp(second.tokens.access_token, "tools/list"), appEnv)).text()).toContain('"name":"prepare_trade"');
    const renewed = await dispatch(tokenRequest({ grant_type: "refresh_token", client_id: first.clientId, refresh_token: first.tokens.refresh_token }), appEnv);
    expect(renewed.status).toBe(200);
    const tokens = await renewed.json<Tokens>();
    expect(await (await dispatch(mcp(tokens.access_token, "tools/list"), appEnv)).text()).not.toContain('"name":"prepare_trade"');
    const row = (await clients(ui)).find(row => row.clientId === first.clientId);
    expect(row).toMatchObject({ permissionLevel: "read_only", revoked: false });
  });

  it("revokes every client grant and rejects existing access and refresh tokens", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const other = await authorize(appEnv); const ui = await login(appEnv);
    const additional = await authorize(appEnv, "full_access", "Dashboard client", client.clientId);
    expect((await dispatch(mcp(additional.tokens.access_token, "tools/list"), appEnv)).status).toBe(200);
    expect((await ui.post("clients/revoke", { clientId: client.clientId })).status).toBe(200);
    const denied = await dispatch(mcp(client.tokens.access_token, "tools/list"), appEnv);
    expect(denied.status).toBe(401); expect(denied.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    const refresh = await dispatch(tokenRequest({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: client.tokens.refresh_token }), appEnv);
    expect(refresh.status).toBe(400); expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });
    expect((await dispatch(mcp(additional.tokens.access_token, "tools/list"), appEnv)).status).toBe(401);
    const additionalRefresh = await dispatch(tokenRequest({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: additional.tokens.refresh_token }), appEnv);
    expect(additionalRefresh.status).toBe(400); expect(await additionalRefresh.json()).toMatchObject({ error: "invalid_grant" });
    expect((await dispatch(mcp(other.tokens.access_token, "tools/list"), appEnv)).status).toBe(200);
    expect((await clients(ui)).find(row => row.clientId === client.clientId)).toMatchObject({ revoked: true });
  });

  it.each(["read_only", "full_access"] as const)("migrates a legacy security row repeatedly while preserving the existing %s token permission and Schwab credentials", async permissionLevel => {
    const appEnv = setup(); const client = await authorize(appEnv, permissionLevel); await connectSchwab(appEnv);
    await runInDurableObject(vaultStub(appEnv), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM client_security");
      for (const column of ["permission_level", "permission_initialized", "revoked", "updated_at"]) state.storage.sql.exec(`ALTER TABLE client_security DROP COLUMN ${column}`);
      state.storage.sql.exec("INSERT INTO client_security (client_id, advanced, version) VALUES (?, 0, 7)", client.clientId);
      new SecurityStore(state.storage, appEnv); new SecurityStore(state.storage, appEnv);
      expect(state.storage.sql.exec("SELECT advanced, version FROM client_security WHERE client_id = ?", client.clientId).one()).toMatchObject({ advanced: 0, version: 7 });
      expect(state.storage.sql.exec("SELECT access_token FROM schwab_token").one().access_token).toBe("fake-access-secret");
    });
    const list = await dispatch(mcp(client.tokens.access_token, "tools/list"), appEnv);
    expect(list.status).toBe(200); expect((await list.text()).includes('"name":"prepare_trade"')).toBe(permissionLevel === "full_access");
    const ui = await login(appEnv);
    expect((await clients(ui)).find(row => row.clientId === client.clientId)).toMatchObject({ permissionLevel, version: 7 });
    const updated = await runInDurableObject(vaultStub(appEnv), (_instance, state) => state.storage.sql.exec<{ updated_at: number }>("SELECT updated_at FROM client_security WHERE client_id = ?", client.clientId).one().updated_at);
    expect(updated).toBeGreaterThan(0);
  });

  it.each(["throw", "http", "malformed"] as const)("fails MCP and refresh closed on a %s authoritative policy outage", async failure => {
    const appEnv = setup(); const client = await authorize(appEnv); const namespace = appEnv.SCHWAB_VAULT;
    appEnv.SCHWAB_VAULT = new Proxy(namespace, {
      get(target, property) {
        if (property === "get") return (id: DurableObjectId) => {
          const stub = target.get(id);
          return new Proxy(stub, { get(target, property) {
            if (property === "fetch") return async (input: RequestInfo | URL, init?: RequestInit) => {
              const request = new Request(input, init);
              if (new URL(request.url).pathname === "/client/policy") {
                if (failure === "throw") throw new Error("private-policy-outage-detail");
                return failure === "http" ? new Response("private-policy-outage-detail", { status: 503 }) : Response.json({});
              }
              return target.fetch(request);
            };
            const value: unknown = Reflect.get(target, property);
            const bound: unknown = typeof value === "function" ? value.bind(target) : value;
            return bound;
          } });
        };
        const value: unknown = Reflect.get(target, property);
        const bound: unknown = typeof value === "function" ? value.bind(target) : value;
        return bound;
      },
    });
    const response = await dispatch(mcp(client.tokens.access_token, "tools/list"), appEnv);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("private-policy-outage-detail");
    const refresh = await dispatch(tokenRequest({ grant_type: "refresh_token", client_id: client.clientId, refresh_token: client.tokens.refresh_token }), appEnv);
    expect(refresh.status).toBe(503); expect(await refresh.text()).not.toContain("private-policy-outage-detail");
  });
});

describe("Dashboard Passkey policy ceremonies", () => {
  it("registers and adds Passkeys without a target while preserving the client policy", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv);
    const before = await clientRow(ui, client.clientId);
    const key = await authenticator();
    const options = await ui.security("options", { operation: "register", name: "Desktop" });
    expect(options.status).toBe(200);
    const registration = await options.json<Challenge>();
    expect((await ui.security("verify", { challengeId: registration.challengeId, response: await key.register(registration.options.challenge) })).status).toBe(200);
    const add = await ui.security("options", { operation: "add", name: "Phone" });
    expect(add.status).toBe(200);
    const challenge = await add.json<Challenge>();
    const proof = await (await ui.security("verify", { challengeId: challenge.challengeId, response: await key.authenticate(challenge.options.challenge) })).json<{ registrationTicket: string }>();
    const phone = await authenticator();
    const next = await (await ui.security("add-options", { ticket: proof.registrationTicket, name: "Phone" })).json<Challenge>();
    expect((await ui.security("add-verify", { challengeId: next.challengeId, response: await phone.register(next.options.challenge) })).status).toBe(200);
    const saved = await (await ui.get("session")).json<{ credentials: { id: string; name: string }[] }>();
    expect(saved.credentials).toHaveLength(2);
    expect(saved.credentials).toContainEqual({ id: key.id, name: "Desktop" });
    expect(saved.credentials).toContainEqual({ id: phone.id, name: "Phone" });
    expect(await clientRow(ui, client.clientId)).toEqual(before);
  });

  it("registers the first credential, enables and disables with real signatures, increments policy versions and rejects replay", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv);
    const before = await clientRow(ui, client.clientId);
    const key = await activate(ui, client.clientId);
    const enabled = await clientRow(ui, client.clientId);
    expect(enabled).toMatchObject({ advancedSecurity: true, version: before.version + 1 });
    const session = await (await ui.get("session")).json<{ credentials: { id: string; name: string }[] }>();
    expect(session.credentials).toEqual([expect.objectContaining({ id: key.id })]);
    expect(await (await ui.get("overview")).json()).toMatchObject({ passkeyCount: 1 });
    const options = await (await ui.post("clients/advanced-security", { clientId: client.clientId, advancedSecurity: false })).json<Challenge>();
    expect(options.registration).toBe(false);
    const body = { clientId: client.clientId, advancedSecurity: false, challengeId: options.challengeId, response: await key.authenticate(options.options.challenge) };
    expect((await ui.post("clients/advanced-security", body)).status).toBe(200);
    expect((await clients(ui)).find(row => row.clientId === client.clientId)).toMatchObject({ advancedSecurity: false, version: enabled.version + 1 });
    expect((await ui.post("clients/advanced-security", body)).status).toBe(403);
  });

  it("authenticates with an existing credential when enabling Advanced Security on another client", async () => {
    const appEnv = setup(); const first = await authorize(appEnv); const second = await authorize(appEnv); const ui = await login(appEnv);
    const key = await activate(ui, first.clientId);
    expect((await clientRow(ui, first.clientId)).advancedSecurity).toBe(true);
    const response = await ui.post("clients/advanced-security", { clientId: second.clientId, advancedSecurity: true });
    expect(response.status).toBe(200);
    const challenge = await response.json<Challenge>();
    expect(challenge.registration).toBe(false);
    const verified = await ui.post("clients/advanced-security", {
      clientId: second.clientId,
      advancedSecurity: true,
      challengeId: challenge.challengeId,
      response: await key.authenticate(challenge.options.challenge),
    });
    expect(verified.status).toBe(200);
    expect((await clientRow(ui, second.clientId)).advancedSecurity).toBe(true);
  });

  it("rejects enabling Advanced Security on read_only clients", async () => {
    const appEnv = setup(); const readOnlyClient = await authorize(appEnv, "read_only"); const ui = await login(appEnv);
    const response = await ui.post("clients/advanced-security", { clientId: readOnlyClient.clientId, advancedSecurity: true });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "SECURITY_POLICY_CHANGED" } });
  });

  it.each(["client", "mode", "session", "version", "signature"] as const)("binds a real signature to its %s and does not mutate a mismatched policy", async failure => {
    const appEnv = setup(); const client = await authorize(appEnv); const other = await authorize(appEnv); const ui = await login(appEnv);
    const key = await activate(ui, client.clientId);
    const response = await ui.post("clients/advanced-security", { clientId: client.clientId, advancedSecurity: false });
    expect(response.status).toBe(200); const challenge = await response.json<Challenge>();
    const before = await clientRow(ui, client.clientId);
    if (failure === "version") expect((await ui.post("clients/permission", { clientId: client.clientId, permissionLevel: "read_only" })).status).toBe(200);
    const another = failure === "session" ? await login(appEnv) : ui;
    const denied = await another.post("clients/advanced-security", {
      clientId: failure === "client" ? other.clientId : client.clientId, advancedSecurity: failure === "mode",
      challengeId: challenge.challengeId, response: await key.authenticate(challenge.options.challenge, { badSignature: failure === "signature" }),
    });
    expect(denied.status).toBe(403);
    const rows = await clients(ui);
    expect(rows.find(row => row.clientId === client.clientId)).toMatchObject({ advancedSecurity: true, version: before.version + (failure === "version" ? 1 : 0) });
    expect(rows.find(row => row.clientId === other.clientId)).toMatchObject({ advancedSecurity: false });
  });

  it("expires policy challenges without disabling Advanced Security", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv);
    const key = await activate(ui, client.clientId);
    const before = await clientRow(ui, client.clientId);
    const challenge = await (await ui.post("clients/advanced-security", { clientId: client.clientId, advancedSecurity: false })).json<Challenge>();
    const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 120_001);
    expect((await ui.post("clients/advanced-security", { clientId: client.clientId, advancedSecurity: false, challengeId: challenge.challengeId, response: await key.authenticate(challenge.options.challenge) })).status).toBe(403);
    expect(await clientRow(ui, client.clientId)).toMatchObject({ advancedSecurity: true, version: before.version });
  });

  it("reuses the existing two-stage add, rename and delete flows and cannot delete the last credential", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv); const key = await activate(ui, client.clientId);
    const add = await (await ui.security("options", { operation: "add" })).json<Challenge>();
    const proof = await (await ui.security("verify", { challengeId: add.challengeId, response: await key.authenticate(add.options.challenge) })).json<{ registrationTicket: string }>();
    expect(proof.registrationTicket).toBeTruthy();
    const registration = await ui.security("add-options", { ticket: proof.registrationTicket, name: "Phone" });
    expect(registration.status).toBe(200); const options = await registration.json<Challenge>(); const phone = await authenticator();
    expect((await ui.security("add-verify", { challengeId: options.challengeId, response: await phone.register(options.options.challenge) })).status).toBe(200);
    expect((await ui.security("add-options", { ticket: proof.registrationTicket })).status).toBe(403);
    const rename = await (await ui.security("options", { operation: "rename", target: phone.id, name: "New phone" })).json<Challenge>();
    expect((await ui.security("verify", { challengeId: rename.challengeId, response: await key.authenticate(rename.options.challenge) })).status).toBe(200);
    const renamed = await (await ui.get("session")).json<{ credentials: { id: string; name: string }[] }>();
    expect(renamed.credentials).toContainEqual({ id: phone.id, name: "New phone" });
    const remove = await (await ui.security("options", { operation: "delete", target: phone.id })).json<Challenge>();
    expect((await ui.security("verify", { challengeId: remove.challengeId, response: await key.authenticate(remove.options.challenge) })).status).toBe(200);
    expect((await ui.security("options", { operation: "delete", target: key.id })).status).toBe(403);
  });
});

describe("Dashboard persisted tool invocation audit", () => {
  it("audits real get_quotes and list_accounts executions with mocked Schwab, safe parameters, counts and last invocation", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv); await connectSchwab(appEnv);
    const upstream = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/quotes")) return Response.json({ AAPL: { quote: { lastPrice: 123 } } });
      if (url.pathname.endsWith("/accounts/accountNumbers")) return Response.json([{ accountNumber: "123456789", hashValue: "a".repeat(32) }]);
      throw new Error(`Unexpected mocked upstream ${url.pathname}`);
    });
    vi.stubGlobal("fetch", upstream);
    for (const [name, args] of [["get_quotes", { symbols: ["AAPL"] }], ["list_accounts", {}]] as const) {
      const response = await tool(appEnv, client.tokens, name, args); expect(response.status).toBe(200);
      const text = await response.text(); expect(text).not.toContain('"isError":true'); expect(text).not.toContain("123456789");
    }
    expect(upstream).toHaveBeenCalledTimes(2);
    const page = await audit(ui);
    expect(page).toMatchObject({ total: 2, successCount: 2, errorCount: 0, active24h: 2 });
    expect(page.items.map(row => row.toolName).sort()).toEqual(["get_quotes", "list_accounts"]);
    for (const row of page.items) {
      expect(row.clientId).toBe(client.clientId); expect(row.status).toBe("SUCCESS"); expect(row.requestId).toBeTruthy();
      expect(row.durationMs).toBeGreaterThanOrEqual(0); expect(Number.isFinite(row.durationMs)).toBe(true);
      expect(new TextEncoder().encode(row.parametersSummary ?? "").byteLength).toBeLessThanOrEqual(512);
    }
    expect((await clients(ui)).find(row => row.clientId === client.clientId)?.lastInvocationAt).toBe(Math.max(...page.items.map(row => row.createdAt)));
    expect(await (await ui.get("overview")).json()).toMatchObject({ toolCallsCount: 2 });
  });

  it("records invalid-input and upstream errors without leaking arbitrary trade content, secrets or account identifiers", async () => {
    const appEnv = setup(); const client = await authorize(appEnv); const ui = await login(appEnv); await connectSchwab(appEnv);
    const upstream = vi.fn(() => Response.json({ message: "account 123456789 secret-value" }, { status: 403 })); vi.stubGlobal("fetch", upstream);
    const invalid = await tool(appEnv, client.tokens, "get_quotes", { symbols: [], access_token: "secret-value", accountNumber: "123456789" });
    expect(await invalid.text()).toContain("error");
    const failed = await tool(appEnv, client.tokens, "get_quotes", { symbols: ["AAPL"] }); expect(await failed.text()).toContain('"isError":true');
    const prepared = await tool(appEnv, client.tokens, "prepare_trade", {
      accountHash: "account-hash-private-123456789", action: "PLACE", executionMode: "IMMEDIATE",
      orderPayload: { orderStrategyType: "SINGLE", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }], arbitrary: "界".repeat(1000) + " embedded-private-trade 123456789 secret-value" },
      userInstruction: "Buy one AAPL share; embedded-private-instruction 123456789 secret-value",
    });
    expect(prepared.status).toBe(200);
    const page = await audit(ui);
    expect(page.total).toBe(3); expect(page.errorCount).toBeGreaterThanOrEqual(2);
    const invalidRow = page.items.find(row => row.toolName === "get_quotes" && row.errorCode === "INVALID_ARGUMENT");
    expect(invalidRow).toBeDefined(); expect(page.items.filter(row => row.status === "ERROR").every(row => Boolean(row.errorCode))).toBe(true);
    const serialized = JSON.stringify(page);
    for (const secret of ["secret-value", "123456789", "account-hash-private", "embedded-private-trade", "embedded-private-instruction", "fake-access-secret", "fake-refresh-secret"]) expect(serialized).not.toContain(secret);
    for (const row of page.items) expect(new TextEncoder().encode(row.parametersSummary ?? "").byteLength).toBeLessThanOrEqual(512);
  });

  it("enforces the UTF-8 summary limit at the SQLite persistence boundary", async () => {
    const appEnv = setup(); const ui = await login(appEnv);
    const summary = "界é".repeat(300);
    expect(new TextEncoder().encode(summary).byteLength).toBeGreaterThan(512);
    expect((await postVault(appEnv, "/audit/tool", { clientId: "utf8", toolName: "get_quotes", requestId: crypto.randomUUID(), status: "SUCCESS", durationMs: 1, parametersSummary: summary })).status).toBe(200);
    const page = await audit(ui, "?clientId=utf8");
    expect(page.items).toHaveLength(1);
    const persisted = page.items[0]?.parametersSummary ?? "";
    expect(new TextEncoder().encode(persisted).byteLength).toBeLessThanOrEqual(512);
    expect(persisted).not.toContain("\ufffd");
  });

  it("filters and pages persisted audit rows with statistics over the full filtered result", async () => {
    const appEnv = setup(); const a = await authorize(appEnv); const b = await authorize(appEnv); const ui = await login(appEnv); const now = Date.now();
    const rows = [
      { clientId: a.clientId, toolName: "get_quotes", status: "SUCCESS", createdAt: now - 1000 },
      { clientId: a.clientId, toolName: "get_quotes", status: "ERROR", createdAt: now - 2000 },
      { clientId: a.clientId, toolName: "list_accounts", status: "SUCCESS", createdAt: now - 25 * 60 * 60 * 1000 },
      { clientId: b.clientId, toolName: "get_quotes", status: "SUCCESS", createdAt: now - 3000 },
    ];
    for (const row of rows) expect((await postVault(appEnv, "/audit/tool", { ...row, requestId: crypto.randomUUID(), durationMs: 5 })).status).toBe(200);
    const first = await audit(ui, `?clientId=${a.clientId}&limit=1&offset=0`);
    expect(first).toMatchObject({ total: 3, successCount: 2, errorCount: 1, active24h: 2, limit: 1, offset: 0 });
    expect(first.items).toHaveLength(1); expect(first.items[0]).toMatchObject({ clientId: a.clientId, createdAt: now - 1000 });
    const second = await audit(ui, `?clientId=${a.clientId}&limit=1&offset=1`);
    expect(second.items[0]).toMatchObject({ clientId: a.clientId, status: "ERROR" }); expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    const errors = await audit(ui, `?clientId=${a.clientId}&toolName=get_quotes&status=ERROR`);
    expect(errors).toMatchObject({ total: 1, successCount: 0, errorCount: 1, active24h: 1 });
    expect(errors.items).toHaveLength(1);
    expect((await audit(ui, "?limit=100")).limit).toBe(100);
    for (const query of ["?limit=1000", "?limit=0", "?limit=NaN", "?offset=-1", "?offset=5001", "?limit=1&limit=2"]) {
      expect((await ui.get(`audit${query}`)).status).toBe(400);
    }
  });

  it("retains only the newest 5000 rows and prunes the thirty-day boundary on append", async () => {
    const appEnv = setup(); const ui = await login(appEnv); const now = Date.now();
    await runInDurableObject(vaultStub(appEnv), (_instance, state) => {
      state.storage.sql.exec(`
        WITH RECURSIVE cnt(i) AS (
          SELECT 0
          UNION ALL
          SELECT i + 1 FROM cnt WHERE i < 5001
        )
        INSERT INTO tool_invocation_audit (id, client_id, tool_name, request_id, status, duration_ms, created_at)
        SELECT 'seed-' || i, 'retention', 'get_quotes', 'request-' || i, 'SUCCESS', 1, ? - i FROM cnt;
      `, now);
      state.storage.sql.exec("INSERT INTO tool_invocation_audit (id, client_id, tool_name, request_id, status, duration_ms, created_at) VALUES ('expired', 'retention', 'get_quotes', 'expired-request', 'SUCCESS', 1, ?)", now - 30 * 24 * 60 * 60 * 1000);
    });
    expect((await postVault(appEnv, "/audit/tool", { id: "newest", clientId: "retention", toolName: "get_quotes", requestId: "latest-request", status: "SUCCESS", durationMs: 1, createdAt: now + 1 })).status).toBe(200);
    const page = await audit(ui, "?clientId=retention&limit=1");
    expect(page.total).toBe(5000); expect(page.items[0]?.id).toBe("newest");
    const saved = await runInDurableObject(vaultStub(appEnv), (_instance, state) => state.storage.sql.exec<{ id: string }>("SELECT id FROM tool_invocation_audit WHERE id IN ('expired', 'seed-5001', 'seed-5000', 'seed-4999')").toArray());
    expect(saved).toEqual([]);
    expect((await audit(ui, "?clientId=retention&limit=1&offset=4999")).items[0]?.id).toBe("seed-4998");
  });
});
