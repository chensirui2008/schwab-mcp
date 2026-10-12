import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import OAuthProvider, { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import type { AuthRequest, OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../src/auth";
import type { AppEnv } from "../src/env";
import worker from "../src/index";
import { AUTHORIZATION_VERSION, READ_SCOPE } from "../src/oauth-access";
import type { AuthorizationProps, PermissionLevel } from "../src/oauth-access";

const origin = "https://example.com";
const redirectUri = "https://client.example/callback";
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

async function authRequest(helpers: AppEnv["OAUTH_PROVIDER"]): Promise<AuthRequest> {
  const client = await helpers.createClient({
    redirectUris: [redirectUri], clientName: "Test client", tokenEndpointAuthMethod: "none",
  });
  return { responseType: "code", clientId: client.clientId, redirectUri, scope: [READ_SCOPE], state: "client-state" };
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
  return { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner", permissionLevel, authorizationVersion: AUTHORIZATION_VERSION };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OAuth permission enforcement", () => {
  it("expires old access tokens, refresh tokens, and outstanding authorization codes on deployment", async () => {
    const { appEnv, helpers } = setup();
    const request = await authRequest(helpers);
    const oldProps = { userId: appEnv.ALLOWED_GITHUB_USER_ID, username: "owner" };
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

describe("browser permission consent", () => {
  async function consent(appEnv: AppEnv, request: AuthRequest) {
    const url = new URL(`${origin}/authorize`);
    url.search = new URLSearchParams({ client_id: request.clientId, redirect_uri: redirectUri, response_type: "code", scope: READ_SCOPE }).toString();
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
    expect(approved.status).toBe(302);
    const githubState = new URL(approved.headers.get("location") ?? "").searchParams.get("state") ?? "";
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
    const request = await authRequest(helpers);
    const callback = await authorize(appEnv, request, permissionLevel);
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const tokens = await exchange(appEnv, request, code);
    const decoded = await helpers.unwrapToken<AuthorizationProps>(tokens.access_token);
    expect(decoded?.grant.props).toMatchObject({ permissionLevel, authorizationVersion: AUTHORIZATION_VERSION });
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
