import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../src/auth";
import type { AppEnv } from "../src/env";
import { vaultStub } from "../src/env";
import worker from "../src/index";
import { AUTHORIZATION_VERSION, READ_SCOPE } from "../src/oauth-access";
import type { AuthorizationProps, PermissionLevel } from "../src/oauth-access";

const origin = "https://example.com";
const redirectUri = "https://client.example/callback";
const verifiers = new WeakMap<AuthRequest, string>();
const legacyOptions: OAuthProviderOptions<AppEnv> = {
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler: { fetch: () => Response.json({ legacy: true }) },
  defaultHandler: AuthHandler,
  scopesSupported: [READ_SCOPE],
};

function setup() {
  const appEnv = { ...env } as unknown as AppEnv;
  const helpers = getOAuthApi(legacyOptions, appEnv);
  appEnv.OAUTH_PROVIDER = helpers;
  return { appEnv, helpers };
}

async function dispatch(request: Request, appEnv: AppEnv, provider = worker) {
  const ctx = createExecutionContext();
  const response = await provider.fetch(request, appEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function githubContinueUrl(response: Response): Promise<URL> {
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self';");
  const page = await response.clone().text();
  const target = page.match(/id="github-continue" href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  const url = new URL(target ?? "");
  expect(url.origin).toBe("https://github.com");
  expect(url.pathname).toBe("/login/oauth/authorize");
  return url;
}

async function authRequest(helpers: AppEnv["OAUTH_PROVIDER"], registeredClientId?: string): Promise<AuthRequest> {
  const clientId = registeredClientId ?? (await helpers.createClient({
    redirectUris: [redirectUri], clientName: "Test client", tokenEndpointAuthMethod: "none",
  })).clientId;
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const verifier = encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const request = {
    responseType: "code", clientId, redirectUri, scope: [READ_SCOPE], state: "client-state",
    codeChallenge: challenge, codeChallengeMethod: "S256",
  };
  verifiers.set(request, verifier);
  return request;
}

function authorizationParams(request: AuthRequest): URLSearchParams {
  return new URLSearchParams({
    client_id: request.clientId, redirect_uri: redirectUri, response_type: "code", scope: READ_SCOPE,
    state: request.state, code_challenge: request.codeChallenge ?? "", code_challenge_method: request.codeChallengeMethod ?? "",
  });
}

function tokenRequest(values: Record<string, string>) {
  return new Request(`${origin}/oauth/token`, { method: "POST", body: new URLSearchParams(values) });
}

async function grant(appEnv: AppEnv, request: AuthRequest, props: unknown) {
  const { redirectTo } = await appEnv.OAUTH_PROVIDER.completeAuthorization({
    request, userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE], metadata: {}, props,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  expect(code).toBeTruthy();
  return code ?? "";
}

interface Tokens { access_token: string; refresh_token: string }

async function exchange(appEnv: AppEnv, request: AuthRequest, code: string, provider = worker) {
  const response = await dispatch(tokenRequest({
    grant_type: "authorization_code", client_id: request.clientId, code, redirect_uri: redirectUri,
    ...(request.codeChallenge ? { code_verifier: verifiers.get(request) ?? "" } : {}),
  }), appEnv, provider);
  expect(response.status).toBe(200);
  return response.json<Tokens>();
}

function mcpRequest(accessToken: string, method: string, params: unknown = {}) {
  return new Request(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

function currentProps(appEnv: AppEnv, permissionLevel: PermissionLevel) {
  return { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel, authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256" };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth permission enforcement", () => {
  it.each(["missing", "stale"])("expires access tokens, refresh tokens, and outstanding codes with %s authorization versions", async (version) => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const oldProps = {
      userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner",
      ...(version === "stale" ? { authorizationVersion: "client-permissions-v0", permissionLevel: "read_only", pkceMethod: "S256" } : {}),
    };
    const code = await grant(appEnv, request, oldProps);
    const tokens = await exchange(appEnv, request, code, new OAuthProvider(legacyOptions));
    const access = await dispatch(mcpRequest(tokens.access_token, "tools/list"), appEnv);
    expect(access.status).toBe(401);
    expect(access.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    const refresh = await dispatch(tokenRequest({
      grant_type: "refresh_token", client_id: request.clientId, refresh_token: tokens.refresh_token,
    }), appEnv);
    expect(refresh.status).toBe(400);
    expect(await refresh.json()).toMatchObject({ error: "invalid_grant" });

    const outstanding = await grant(appEnv, request, oldProps);
    const response = await dispatch(tokenRequest({
      grant_type: "authorization_code", client_id: request.clientId, code: outstanding, redirect_uri: redirectUri,
      code_verifier: verifiers.get(request) ?? "",
    }), appEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("keeps client permissions independent and preserves them when refreshing tokens", async () => {
    const { appEnv, helpers } = setup();
    const readRequest = await authRequest(helpers);
    const fullRequest = await authRequest(helpers);
    const read = await exchange(appEnv, readRequest, await grant(appEnv, readRequest, currentProps(appEnv, "read_only")));
    const full = await exchange(appEnv, fullRequest, await grant(appEnv, fullRequest, currentProps(appEnv, "full_access")));
    const readList = await dispatch(mcpRequest(read.access_token, "tools/list"), appEnv);
    const readText = await readList.text();
    expect(readList.status).toBe(200);
    expect(readText).toContain('"name":"get_quotes"');
    expect(readText).toContain('"name":"get_trading_diagnostics"');
    expect(readText).not.toContain('"name":"prepare_trade"');
    expect(readText).not.toContain('"name":"place_order_direct"');
    const fullList = await dispatch(mcpRequest(full.access_token, "tools/list"), appEnv);
    expect(await fullList.text()).toContain('"name":"prepare_trade"');

    const blocked = await dispatch(mcpRequest(read.access_token, "tools/call", { name: "cancel_order", arguments: {} }), appEnv);
    expect(await blocked.text()).toContain("not found");

    for (const [request, tokens, permissionLevel] of [
      [readRequest, read, "read_only"], [fullRequest, full, "full_access"],
    ] as const) {
      const refreshed = await dispatch(tokenRequest({
        grant_type: "refresh_token", client_id: request.clientId, refresh_token: tokens.refresh_token,
      }), appEnv);
      expect(refreshed.status).toBe(200);
      const renewed = await refreshed.json<Tokens>();
      const list = await dispatch(mcpRequest(renewed.access_token, "tools/list"), appEnv);
      const text = await list.text();
      expect(text.includes('"name":"prepare_trade"')).toBe(permissionLevel === "full_access");
    }
  });

  it("revokes full-access tokens when the same client reauthorizes as read-only", async () => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const full = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
    await grant(appEnv, request, currentProps(appEnv, "read_only"));
    expect((await dispatch(mcpRequest(full.access_token, "tools/list"), appEnv)).status).toBe(401);
    expect((await dispatch(tokenRequest({
      grant_type: "refresh_token", client_id: request.clientId, refresh_token: full.refresh_token,
    }), appEnv)).status).toBe(400);
  });
});

describe("S256 PKCE protocol", () => {
  it("advertises only S256", async () => {
    const { appEnv } = setup();
    const response = await dispatch(new Request(`${origin}/.well-known/oauth-authorization-server`), appEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code_challenge_methods_supported: ["S256"] });
  });

  const invalidParameters: [string, string[], string[]][] = [
    ["missing both", [], []],
    ["missing challenge", [], ["S256"]],
    ["missing method", ["a".repeat(43)], []],
    ["empty challenge", [""], ["S256"]],
    ["empty method", ["a".repeat(43)], [""]],
    ["plain", ["a".repeat(43)], ["plain"]],
    ["unknown method", ["a".repeat(43)], ["S512"]],
    ["lowercase method", ["a".repeat(43)], ["s256"]],
    ["method whitespace", ["a".repeat(43)], [" S256"]],
    ["short challenge", ["a".repeat(42)], ["S256"]],
    ["long challenge", ["a".repeat(44)], ["S256"]],
    ["padded challenge", ["a".repeat(42) + "="], ["S256"]],
    ["base64 plus", ["a".repeat(42) + "+"], ["S256"]],
    ["base64 slash", ["a".repeat(42) + "/"], ["S256"]],
    ["challenge whitespace", ["a".repeat(42) + " "], ["S256"]],
    ["challenge newline", ["a".repeat(42) + "\n"], ["S256"]],
    ["trailing newline", ["a".repeat(43) + "\n"], ["S256"]],
    ["duplicate challenge", ["a".repeat(43), "a".repeat(43)], ["S256"]],
    ["duplicate method", ["a".repeat(43)], ["S256", "S256"]],
    ["conflicting methods", ["a".repeat(43)], ["S256", "plain"]],
  ];

  it.each(invalidParameters)("rejects %s before creating an authorization flow", async (_label, challenges, methods) => {
    const { appEnv, helpers } = setup();
    const params = authorizationParams(await authRequest(helpers));
    params.delete("code_challenge");
    params.delete("code_challenge_method");
    for (const value of challenges) params.append("code_challenge", value);
    for (const value of methods) params.append("code_challenge_method", value);
    const parse = vi.spyOn(helpers, "parseAuthRequest");
    const vault = vi.spyOn(appEnv.SCHWAB_VAULT, "get");
    const response = await dispatch(new Request(`${origin}/authorize?${params.toString()}`), appEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(parse).not.toHaveBeenCalled();
    expect(vault).not.toHaveBeenCalled();
  });

  it.each(["missing verifier", "wrong verifier", "other client"])("rejects %s and accepts the correct verifier", async (failure) => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const code = await grant(appEnv, request, currentProps(appEnv, "read_only"));
    const values: Record<string, string> = {
      grant_type: "authorization_code", client_id: request.clientId, code, redirect_uri: redirectUri,
    };
    if (failure === "wrong verifier") values.code_verifier = "wrong".repeat(12);
    if (failure === "other client") {
      values.client_id = (await authRequest(helpers)).clientId;
      values.code_verifier = verifiers.get(request) ?? "";
    }
    const rejected = await dispatch(tokenRequest(values), appEnv);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: failure === "missing verifier" ? "invalid_request" : "invalid_grant" });
    await exchange(appEnv, request, code);
  });

  it.each(["read_only", "full_access"] as const)("preserves existing %s access and refresh tokens without upgrading props", async (permissionLevel) => {
    for (const usePkce of [false, true]) {
      const { appEnv, helpers } = setup();
      const request = await authRequest(helpers);
      if (!usePkce) {
        delete request.codeChallenge;
        delete request.codeChallengeMethod;
      }
      const props = { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel, authorizationVersion: AUTHORIZATION_VERSION };
      const code = await grant(appEnv, request, props);
      const tokens = await exchange(appEnv, request, code, new OAuthProvider(legacyOptions));
      const access = await dispatch(mcpRequest(tokens.access_token, "tools/list"), appEnv);
      expect(access.status).toBe(200);
      expect((await access.text()).includes('"name":"prepare_trade"')).toBe(permissionLevel === "full_access");
      const refreshed = await dispatch(tokenRequest({
        grant_type: "refresh_token", client_id: request.clientId, refresh_token: tokens.refresh_token,
      }), appEnv);
      expect(refreshed.status).toBe(200);
      const renewed = await refreshed.json<Tokens>();
      const decoded = await helpers.unwrapToken<AuthorizationProps>(renewed.access_token);
      expect(decoded?.grant.props).toEqual(props);
      const list = await dispatch(mcpRequest(renewed.access_token, "tools/list"), appEnv);
      expect(list.status).toBe(200);
      expect((await list.text()).includes('"name":"prepare_trade"')).toBe(permissionLevel === "full_access");
    }
  });

  it.each([false, true])("rejects pre-upgrade outstanding codes (PKCE=%s), even with a forged token-request marker", async (usePkce) => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    if (!usePkce) {
      delete request.codeChallenge;
      delete request.codeChallengeMethod;
    }
    const props = { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel: "full_access", authorizationVersion: AUTHORIZATION_VERSION };
    const code = await grant(appEnv, request, props);
    const response = await dispatch(tokenRequest({
      grant_type: "authorization_code", client_id: request.clientId, code, redirect_uri: redirectUri, pkceMethod: "S256",
      ...(usePkce ? { code_verifier: verifiers.get(request) ?? "" } : {}),
    }), appEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant", error_description: "S256 PKCE required; restart authorization" });
  });

  it.each([
    ["consent", "missing"], ["github", "missing"],
    ["consent", "plain"], ["github", "plain"],
    ["consent", "malformed"], ["github", "malformed"],
  ])("rejects pre-upgrade %s state with %s PKCE before revoking existing grants", async (kind, pkce) => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const tokens = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
    if (pkce === "missing") {
      delete request.codeChallenge;
      delete request.codeChallengeMethod;
    } else if (pkce === "plain") {
      request.codeChallengeMethod = "plain";
    } else {
      request.codeChallenge = "invalid-challenge";
    }
    const state = crypto.randomUUID();
    const saved = await vaultStub(appEnv).fetch("https://vault/state", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind, expiresAt: Date.now() + 600_000, payload: {
        action: "mcp_authorize", origin, authRequest: request, authorizationVersion: AUTHORIZATION_VERSION, permissionLevel: "read_only",
      } }),
    });
    expect(saved.ok).toBe(true);
    const list = vi.spyOn(helpers, "listUserGrants");
    const revoke = vi.spyOn(helpers, "revokeGrant");
    const complete = vi.spyOn(helpers, "completeAuthorization");
    const github = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "test-github-token" }))
      .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null }));
    vi.stubGlobal("fetch", github);
    const headers = { Cookie: `__Host-schwab-oauth=${state}` };
    const response = await dispatch(kind === "consent"
      ? new Request(`${origin}/authorize/approve`, { method: "POST", headers, body: new URLSearchParams({ state, permissionLevel: "read_only" }) })
      : new Request(`${origin}/auth/github/callback?state=${state}&code=test-code`, { headers }), appEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    if (kind === "consent") expect(github).not.toHaveBeenCalled();
    expect((await dispatch(mcpRequest(tokens.access_token, "tools/list"), appEnv)).status).toBe(200);
    expect((await dispatch(tokenRequest({
      grant_type: "refresh_token", client_id: request.clientId, refresh_token: tokens.refresh_token,
    }), appEnv)).status).toBe(200);
  });
});

describe("browser permission consent", () => {
  async function consent(appEnv: AppEnv, request: AuthRequest) {
    const url = new URL(`${origin}/authorize`);
    url.search = authorizationParams(request).toString();
    const response = await dispatch(new Request(url), appEnv);
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = cookie.split("=")[1] ?? "";
    return { cookie, state };
  }

  async function authorize(appEnv: AppEnv, request: AuthRequest, permissionLevel: PermissionLevel) {
    const { cookie, state } = await consent(appEnv, request);
    const approved = await dispatch(new Request(`${origin}/authorize/approve`, {
      method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ state, permissionLevel }),
    }), appEnv);
    const githubState = (await githubContinueUrl(approved)).searchParams.get("state") ?? "";
    const githubCookie = approved.headers.get("set-cookie")?.split(";")[0] ?? "";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "test-github-token" }))
      .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null })));
    const callback = await dispatch(new Request(`${origin}/auth/github/callback?state=${githubState}&code=test-code`, {
      headers: { Cookie: githubCookie },
    }), appEnv);
    // State cannot be reused to change the selected permission.
    expect((await dispatch(new Request(`${origin}/authorize/approve`, {
      method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams({ state, permissionLevel: "full_access" }),
    }), appEnv)).status).toBe(400);
    return callback;
  }

  it.each(["read_only", "full_access"] as const)("carries %s through owner verification into the grant", async (permissionLevel) => {
    const { appEnv, helpers } = setup();
    const registration = await dispatch(new Request(`${origin}/oauth/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Protocol test client", token_endpoint_auth_method: "none" }),
    }), appEnv);
    expect(registration.status).toBe(201);
    const { client_id: clientId } = await registration.json<{ client_id: string }>();
    const request = await authRequest(helpers, clientId);
    const callback = await authorize(appEnv, request, permissionLevel);
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = await exchange(appEnv, request, code);
    const decoded = await helpers.unwrapToken<AuthorizationProps>(tokens.access_token);
    expect(decoded?.grant.props).toMatchObject({ permissionLevel, authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256" });
    const refreshed = await dispatch(tokenRequest({
      grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token,
    }), appEnv);
    expect(refreshed.status).toBe(200);
    const renewed = await refreshed.json<Tokens>();
    const list = await dispatch(mcpRequest(renewed.access_token, "tools/list"), appEnv);
    expect(list.status).toBe(200);
    expect((await list.text()).includes('"name":"prepare_trade"')).toBe(permissionLevel === "full_access");
    const call = await dispatch(mcpRequest(renewed.access_token, "tools/call", { name: "get_trading_diagnostics", arguments: {} }), appEnv);
    expect(call.status).toBe(200);
    expect(await call.text()).toContain(permissionLevel);
  });

  it("revokes grants on every page, including unexchanged codes, before issuing a replacement", async () => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const full = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
    const { redirectTo } = await helpers.completeAuthorization({
      request, userId: appEnv.ALLOWED_GITHUB_USER_ID, scope: [READ_SCOPE], metadata: {},
      props: currentProps(appEnv, "full_access"), revokeExistingGrants: false,
    });
    const outstanding = new URL(redirectTo).searchParams.get("code") ?? "";
    const grants = await helpers.listUserGrants(appEnv.ALLOWED_GITHUB_USER_ID);
    expect(grants.items.filter((item) => item.clientId === request.clientId)).toHaveLength(2);
    const list = vi.spyOn(helpers, "listUserGrants")
      .mockResolvedValueOnce({ items: grants.items.slice(0, 1), cursor: "next-page" })
      .mockResolvedValueOnce({ items: grants.items.slice(1) });
    const revoke = vi.spyOn(helpers, "revokeGrant");
    const complete = vi.spyOn(helpers, "completeAuthorization");
    const callback = await authorize(appEnv, request, "read_only");
    expect(callback.status).toBe(302);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(appEnv.ALLOWED_GITHUB_USER_ID, { limit: 50, cursor: "next-page" });
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(Math.max(...revoke.mock.invocationCallOrder)).toBeLessThan(complete.mock.invocationCallOrder[0] ?? 0);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ revokeExistingGrants: false }));
    expect((await dispatch(mcpRequest(full.access_token, "tools/list"), appEnv)).status).toBe(401);
    expect((await dispatch(tokenRequest({
      grant_type: "refresh_token", client_id: request.clientId, refresh_token: full.refresh_token,
    }), appEnv)).status).toBe(400);
    expect((await dispatch(tokenRequest({
      grant_type: "authorization_code", client_id: request.clientId, code: outstanding, redirect_uri: redirectUri,
      code_verifier: verifiers.get(request) ?? "",
    }), appEnv)).status).toBe(400);
  });

  it.each(["token deletion", "grant deletion", "grant listing"] as const)(
    "fails reauthorization closed on %s errors, then revokes old credentials on retry",
    async (failure) => {
      const { appEnv, helpers } = setup();
      const request = await authRequest(helpers);
      const otherRequest = await authRequest(helpers);
      const full = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
      const other = await exchange(appEnv, otherRequest, await grant(appEnv, otherRequest, currentProps(appEnv, "full_access")));
      const kv = appEnv.OAUTH_KV;
      const oldGrantId = full.access_token.split(":")[1] ?? "";
      let failures = 0;
      appEnv.OAUTH_KV = new Proxy(kv, {
        get(target, property) {
          if (property === "delete") return async (key: string) => {
            if ((failure === "token deletion" && key.startsWith(`token:${appEnv.ALLOWED_GITHUB_USER_ID}:${oldGrantId}:`)) ||
                (failure === "grant deletion" && key === `grant:${appEnv.ALLOWED_GITHUB_USER_ID}:${oldGrantId}`)) {
              failures++;
              throw new Error("injected KV deletion failure: sensitive-upstream-detail");
            }
            return target.delete(key);
          };
          if (property === "list" && failure === "grant listing") return () => {
            failures++;
            return Promise.reject(new Error("injected KV listing failure: sensitive-upstream-detail"));
          };
          const value: unknown = Reflect.get(target, property);
          const bound: unknown = typeof value === "function" ? value.bind(target) : value;
          return bound;
        },
      });
      const complete = vi.spyOn(helpers, "completeAuthorization");
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const failed = await authorize(appEnv, request, "read_only");
      expect(failures).toBeGreaterThan(0);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ error: "temporarily_unavailable" });
      expect(failed.headers.get("location")).toBeNull();
      expect(complete).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"mcp_authorization_revocation_failed"'));
      expect(JSON.stringify(log.mock.calls)).not.toContain("sensitive-upstream-detail");
      expect(JSON.stringify(log.mock.calls)).toContain('requestId');

      appEnv.OAUTH_KV = kv;
      const retried = await authorize(appEnv, request, "read_only");
      expect(retried.status).toBe(302);
      const code = new URL(retried.headers.get("location") ?? "").searchParams.get("code") ?? "";
      const read = await exchange(appEnv, request, code);
      const readList = await dispatch(mcpRequest(read.access_token, "tools/list"), appEnv);
      expect(readList.status).toBe(200);
      expect(await readList.text()).not.toContain('"name":"prepare_trade"');
      expect((await dispatch(mcpRequest(full.access_token, "tools/list"), appEnv)).status).toBe(401);
      const refresh = await dispatch(tokenRequest({
        grant_type: "refresh_token", client_id: request.clientId, refresh_token: full.refresh_token,
      }), appEnv);
      expect(refresh.status).toBe(400);
      const otherList = await dispatch(mcpRequest(other.access_token, "tools/list"), appEnv);
      expect(otherList.status).toBe(200);
      expect(await otherList.text()).toContain('"name":"prepare_trade"');
    },
  );

  it("rejects missing or invalid permission choices and mismatched browser cookies", async () => {
    const { appEnv, helpers } = setup();
    const { cookie, state } = await consent(appEnv, await authRequest(helpers));
    for (const values of [{ state }, { state, permissionLevel: "admin" }]) {
      const response = await dispatch(new Request(`${origin}/authorize/approve`, {
        method: "POST", headers: { Cookie: cookie }, body: new URLSearchParams(values),
      }), appEnv);
      expect(response.status).toBe(400);
    }
    expect((await dispatch(new Request(`${origin}/authorize/approve`, {
      method: "POST", body: new URLSearchParams({ state, permissionLevel: "full_access" }),
    }), appEnv)).status).toBe(400);
  });
});

describe("Advanced Security OAuth and browser boundaries", () => {
  it.each([false, true])("ends the consent POST before navigating to GitHub (advanced=%s), and rejects replay", async advancedSecurity => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const page = await dispatch(new Request(`${origin}/authorize?${authorizationParams(request)}`), appEnv);
    const originalCookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const state = originalCookie.split("=")[1] ?? "";
    const form = new URLSearchParams({ state, permissionLevel: "full_access", ...(advancedSecurity ? { advancedSecurity: "on" } : {}) });
    const approved = await dispatch(new Request(`${origin}/authorize/approve`, { method: "POST", headers: { Cookie: originalCookie }, body: form }), appEnv);
    const next = await githubContinueUrl(approved);
    const newCookie = approved.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(next.searchParams.get("state")).toBe(newCookie.split("=")[1]);
    expect(newCookie).not.toBe(originalCookie);
    expect(next.searchParams.get("redirect_uri")).toBe(`${origin}/auth/github/callback`);
    for (const cookie of [originalCookie, newCookie]) {
      const replay = await dispatch(new Request(`${origin}/authorize/approve`, { method: "POST", headers: { Cookie: cookie }, body: form }), appEnv);
      expect(replay.status).toBe(400);
      expect(replay.headers.get("location")).toBeNull();
    }
  });

  it("preserves browser security headers on early error responses", async () => {
    const { appEnv } = setup();
    for (const [path, method] of [["/security/api/options", "POST"], ["/security/api/verify", "POST"], ["/security/api/unknown", "POST"], ["/authorize", "GET"]] as const) {
      const response = await dispatch(new Request(`${origin}${path}`, {
        method, ...(method === "POST" ? { headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" } : {}),
      }), appEnv);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });

  async function resetSecurity(appEnv: AppEnv) {
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(vaultStub(appEnv), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM passkey; DELETE FROM client_security; DELETE FROM oauth_state WHERE kind LIKE 'security_%'; UPDATE owner_security SET version = version + 1;");
    });
  }
  function cookie(response: Response, name: string) {
    return response.headers.get("set-cookie")?.match(new RegExp(`(?:^|, )(${name}=[^;,]+)`))?.[1] ?? "";
  }
  async function begin(appEnv: AppEnv, request: AuthRequest, advanced: boolean, level: PermissionLevel = "full_access") {
    const page = await dispatch(new Request(`${origin}/authorize?${authorizationParams(request).toString()}`), appEnv);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const browserCookie = cookie(page, "__Host-schwab-oauth");
    const state = browserCookie.split("=")[1] ?? "";
    const selected = await dispatch(new Request(`${origin}/authorize/approve`, { method: "POST", headers: { Cookie: browserCookie }, body: new URLSearchParams({ state, permissionLevel: level, ...(advanced ? { advancedSecurity: "on" } : {}) }) }), appEnv);
    return { page, selected };
  }
  async function callback(appEnv: AppEnv, selected: Response) {
    const location = await githubContinueUrl(selected);
    const state = location.searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: "github-security-test" }))
      .mockResolvedValueOnce(Response.json({ id: Number(appEnv.ALLOWED_GITHUB_USER_ID), login: "owner", name: null })));
    return dispatch(new Request(`${origin}/auth/github/callback?state=${state}&code=test-code`, { headers: { Cookie: cookie(selected, "__Host-schwab-oauth") } }), appEnv);
  }
  async function browser(appEnv: AppEnv, securityCookie: string) {
    const page = await dispatch(new Request(`${origin}/security`, { headers: { Cookie: securityCookie } }), appEnv);
    expect(page.status).toBe(200);
    const html = await page.text();
    const csrf = html.match(/name="csrf" content="([^"]+)"/)?.[1] ?? "";
    expect(csrf).toBeTruthy();
    const post = (action: string, body: unknown, overrides: Record<string, string> = {}) => dispatch(new Request(`${origin}/security/api/${action}`, {
      method: "POST", headers: { Cookie: securityCookie, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": csrf, ...overrides }, body: JSON.stringify(body),
    }), appEnv);
    return { post, html, page };
  }
  type Challenge = { challengeId: string; options: { challenge: string } };

  it("registers before granting enhanced access, preserves mode on refresh, and requires Passkey to disable", async () => {
    const { authenticator } = await import("./webauthn-fixture");
    const { appEnv, helpers } = setup(); await resetSecurity(appEnv);
    const request = await authRequest(helpers);
    const { selected } = await begin(appEnv, request, true);
    const complete = vi.spyOn(helpers, "completeAuthorization");
    const github = await callback(appEnv, selected);
    expect(github.headers.get("location")).toBe("/security");
    expect(complete).not.toHaveBeenCalled();
    const ui = await browser(appEnv, cookie(github, "__Host-schwab-security"));
    expect(ui.html).toContain("注册 Passkey 并完成授权");
    expect(ui.page.headers.get("X-Frame-Options")).toBe("DENY");
    const key = await authenticator();
    const options = await (await ui.post("options", { operation: "register" })).json<Challenge>();
    const verified = await ui.post("verify", { challengeId: options.challengeId, response: await key.register(options.options.challenge) });
    expect(verified.status).toBe(200);
    const completed = await verified.json<{ redirectTo: string }>();
    const code = new URL(completed.redirectTo).searchParams.get("code") ?? "";
    const tokens = await exchange(appEnv, request, code);
    const props = (await helpers.unwrapToken<AuthorizationProps>(tokens.access_token))?.grant.props;
    expect(props).toMatchObject({ advancedSecurity: true, clientId: request.clientId, securityPolicyVersion: 1, authorizationVersion: AUTHORIZATION_VERSION });
    const list = await (await dispatch(mcpRequest(tokens.access_token, "tools/list"), appEnv)).text();
    expect(list).toContain('"name":"get_trade_proposal"');
    for (const name of ["confirm_trade", "enable_session_direct_trading", "place_order_direct"]) {
      expect(list).not.toContain(`"name":"${name}"`);
      expect(await (await dispatch(mcpRequest(tokens.access_token, "tools/call", { name, arguments: {} }), appEnv)).text()).toContain("not found");
    }
    const refreshed = await dispatch(tokenRequest({ grant_type: "refresh_token", client_id: request.clientId, refresh_token: tokens.refresh_token }), appEnv);
    expect(refreshed.status).toBe(200);
    const newTokens = await refreshed.json<Tokens>();
    expect((await helpers.unwrapToken<AuthorizationProps>(newTokens.access_token))?.grant.props).toMatchObject({ advancedSecurity: true, securityPolicyVersion: 1 });
    const again = await authRequest(helpers, request.clientId);
    const { selected: off, page } = await begin(appEnv, again, false);
    expect(await page.text()).toMatch(/name="advancedSecurity"[^>]+checked/);
    const disabling = await callback(appEnv, off);
    expect(disabling.headers.get("location")).toBe("/security");
    const disabledUi = await browser(appEnv, cookie(disabling, "__Host-schwab-security"));
    expect(disabledUi.html).toContain("关闭");
    const authOptions = await (await disabledUi.post("options", { operation: "authorize" })).json<Challenge>();
    const offVerified = await disabledUi.post("verify", { challengeId: authOptions.challengeId, response: await key.authenticate(authOptions.options.challenge) });
    expect(offVerified.status).toBe(200);
    expect((await dispatch(mcpRequest(newTokens.access_token, "tools/list"), appEnv)).status).toBe(401);
    const offResult = await offVerified.json<{ redirectTo: string }>();
    const ordinary = await exchange(appEnv, again, new URL(offResult.redirectTo).searchParams.get("code") ?? "");
    expect((await helpers.unwrapToken<AuthorizationProps>(ordinary.access_token))?.grant.props).toMatchObject({ advancedSecurity: false, securityPolicyVersion: 2 });
    expect(await (await dispatch(mcpRequest(ordinary.access_token, "tools/list"), appEnv)).text()).toContain('"name":"confirm_trade"');
  });

  it("rejects read-only selection, forged browser CSRF/origin, MCP bearer approval, and oversized requests", async () => {
    const { appEnv, helpers } = setup(); await resetSecurity(appEnv);
    const read = await begin(appEnv, await authRequest(helpers), true, "read_only");
    expect(read.selected.status).toBe(400);
    const request = await authRequest(helpers);
    const { selected } = await begin(appEnv, request, true);
    const github = await callback(appEnv, selected);
    const ui = await browser(appEnv, cookie(github, "__Host-schwab-security"));
    expect((await ui.post("options", { operation: "register" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await ui.post("options", { operation: "register" }, { "X-CSRF-Token": "forged" })).status).toBe(403);
    expect((await ui.post("options", { operation: "register" }, { Cookie: "" })).status).toBe(403);
    expect((await ui.post("options", { operation: "register", padding: "x".repeat(65536) })).status).toBe(413);
    const token = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
    const bearer = await dispatch(new Request(`${origin}/security/api/options`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", Authorization: `Bearer ${token.access_token}` }, body: JSON.stringify({ operation: "approve" }) }), appEnv);
    expect(bearer.status).toBe(403);
    const recovery = await dispatch(new Request(`${origin}/security/recover`, { headers: { Cookie: cookie(github, "__Host-schwab-security") } }), appEnv);
    expect(recovery.status).toBe(302);
    expect(recovery.headers.get("location")).toContain("https://github.com/login/oauth/authorize");
  });

  it("does not commit enhanced policy if old grant revocation fails", async () => {
    const { authenticator } = await import("./webauthn-fixture");
    const { appEnv, helpers } = setup(); await resetSecurity(appEnv);
    const request = await authRequest(helpers);
    const old = await exchange(appEnv, request, await grant(appEnv, request, currentProps(appEnv, "full_access")));
    const { selected } = await begin(appEnv, request, true);
    const github = await callback(appEnv, selected);
    const ui = await browser(appEnv, cookie(github, "__Host-schwab-security"));
    const key = await authenticator();
    const options = await (await ui.post("options", { operation: "register" })).json<Challenge>();
    vi.spyOn(helpers, "revokeGrant").mockRejectedValueOnce(new Error("test-revoke-failure"));
    const result = await ui.post("verify", { challengeId: options.challengeId, response: await key.register(options.options.challenge) });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: "temporarily_unavailable" });
    const policy = await vaultStub(appEnv).fetch("https://vault/security/policy", { method: "POST", body: JSON.stringify({ clientId: request.clientId }) });
    expect(await policy.json()).toMatchObject({ advancedSecurity: false, version: 0 });
    expect((await dispatch(mcpRequest(old.access_token, "tools/list"), appEnv)).status).toBe(200);
  });
});
