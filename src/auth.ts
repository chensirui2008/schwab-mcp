import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { renderSecurityPage } from "./security-ui";
import type { BrowserSession, ClientPolicy, PendingAuthorization } from "./security-store";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { renderAuthorizePage, renderSchwabConnectedPage } from "./auth-ui";
import type { ErrorCode, PublicError } from "./types";
import type { AppEnv } from "./env";
import { vaultStub } from "./env";
import { AUTHORIZATION_VERSION, isPermissionLevel, READ_SCOPE } from "./oauth-access";
import type { AuthorizationProps, PermissionLevel } from "./oauth-access";

const SECURITY_COOKIE = "__Host-schwab-security";
const STATE_TTL_MS = 10 * 60 * 1000;
const FLOW_COOKIE = "__Host-schwab-oauth";
const FLOW_COOKIE_OPTIONS = { secure: true, httpOnly: true, sameSite: "Lax" as const, path: "/", maxAge: STATE_TTL_MS / 1000 };

class InvalidOAuthStateError extends Error {}

function hasS256Pkce(request: { codeChallenge?: unknown; codeChallengeMethod?: unknown } | undefined): boolean {
  return request?.codeChallengeMethod === "S256" &&
    typeof request.codeChallenge === "string" && request.codeChallenge.length === 43 && /^[A-Za-z0-9_-]{43}$/.test(request.codeChallenge);
}

function invalidPkceResponse(): Response {
  return Response.json({ error: "invalid_request", error_description: "A single S256 code_challenge and code_challenge_method are required; restart authorization" }, { status: 400 });
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null | undefined;
}

interface GitHubStatePayload {
  action: "mcp_authorize" | "schwab_connect" | "security_login" | "security_recover";
  returnTo?: string;
  advancedSecurity?: boolean;
  origin: string;
  authRequest?: AuthRequest;
  permissionLevel?: PermissionLevel;
  authorizationVersion?: string;
}

export function isAllowedGitHubUser(userId: number, allowedUserId: string): boolean {
  return String(userId) === allowedUserId;
}

async function revokeClientGrants(provider: OAuthHelpers, userId: string, clientId: string): Promise<void> {
  const grantIds: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await provider.listUserGrants(userId, { limit: 50, ...(cursor ? { cursor } : {}) });
    for (const grant of page.items) {
      if (grant.clientId === clientId) grantIds.push(grant.id);
    }
    cursor = page.cursor;
  } while (cursor);
  // CompleteAuthorization's automatic revocation ignores failures. Revoke first
  // and issue the replacement only after every previous grant is revoked.
  for (const grantId of grantIds) await provider.revokeGrant(grantId, userId);
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function saveState(env: AppEnv, kind: string, payload: unknown): Promise<string> {
  const state = randomState();
  const response = await vaultStub(env).fetch("https://vault/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, kind, payload, expiresAt: Date.now() + STATE_TTL_MS }),
  });
  if (!response.ok) throw new Error("Unable to persist OAuth state");
  return state;
}

async function consumeState<T>(env: AppEnv, state: string, kind: string): Promise<T> {
  const response = await vaultStub(env).fetch("https://vault/state/consume", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, kind }),
  });
  if (response.status === 400) throw new InvalidOAuthStateError("Invalid or expired OAuth state");
  if (!response.ok) throw new Error("Unable to consume OAuth state");
  const envelope: unknown = await response.json();
  if (envelope === null || typeof envelope !== "object" || !("payload" in envelope)) {
    throw new Error("Invalid OAuth state payload");
  }
  return envelope.payload as T;
}

function githubAuthorizationUrl(env: AppEnv, origin: string, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/auth/github/callback`);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeGitHubCode(env: AppEnv, origin: string, code: string): Promise<GitHubUser> {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${origin}/auth/github/callback`,
    }),
  });
  const tokenBody: unknown = await tokenResponse.json();
  const accessToken = tokenBody !== null && typeof tokenBody === "object" ? Reflect.get(tokenBody, "access_token") as unknown : undefined;
  if (!tokenResponse.ok || typeof accessToken !== "string") throw new Error("GitHub token exchange failed");
  const profileResponse = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "schwab-mcp-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const profile: unknown = await profileResponse.json();
  const id = profile !== null && typeof profile === "object" ? Reflect.get(profile, "id") as unknown : undefined;
  const login = profile !== null && typeof profile === "object" ? Reflect.get(profile, "login") as unknown : undefined;
  const name = profile !== null && typeof profile === "object" ? Reflect.get(profile, "name") as unknown : undefined;
  if (!profileResponse.ok || typeof id !== "number" || typeof login !== "string" || (name !== null && name !== undefined && typeof name !== "string")) {
    throw new Error("GitHub profile lookup failed");
  }
  return { id, login, name };
}

async function beginSchwabAuthorization(env: AppEnv, origin: string): Promise<{ url: string; state: string }> {
  const state = await saveState(env, "schwab", { origin });
  const url = new URL("https://api.schwabapi.com/v1/oauth/authorize");
  url.searchParams.set("client_id", env.SCHWAB_CLIENT_ID);
  url.searchParams.set("redirect_uri", env.SCHWAB_REDIRECT_URI);
  url.searchParams.set("state", state);
  return { url: url.toString(), state };
}

class SecurityCallError extends Error {
  constructor(public error: PublicError) { super(error.message); }
}
function browserError(code: ErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status });
}

async function securityCall<T>(env: AppEnv, path: string, input: unknown): Promise<T> {
  const response = await vaultStub(env).fetch(`https://vault/security${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) {
    const envelope = await response.json<{ error: PublicError }>();
    throw new SecurityCallError(envelope.error);
  }
  return response.json<T>();
}

async function finishAuthorization(env: AppEnv, pending: PendingAuthorization, ticket?: string): Promise<{ redirectTo: string } | Response> {
  if (!hasS256Pkce(pending.authRequest) || (pending.advancedSecurity && pending.permissionLevel !== "full_access")) return invalidPkceResponse();
  try {
    await revokeClientGrants(env.OAUTH_PROVIDER, env.ALLOWED_GITHUB_USER_ID, pending.authRequest.clientId);
  } catch {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "mcp_authorization_revocation_failed", requestId }));
    return Response.json({ error: "temporarily_unavailable", error_description: "Unable to revoke previous client authorizations; restart authorization", requestId }, { status: 503 });
  }
  const policy = await securityCall<ClientPolicy>(env, "/commit-policy", { clientId: pending.authRequest.clientId, advancedSecurity: pending.advancedSecurity, expected: pending.policyVersion, ticket });
  return env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.authRequest, userId: env.ALLOWED_GITHUB_USER_ID, revokeExistingGrants: false,
    metadata: { label: "Personal Schwab MCP", permissionLevel: pending.permissionLevel, authorizationVersion: AUTHORIZATION_VERSION, advancedSecurity: pending.advancedSecurity },
    scope: [READ_SCOPE], props: {
      userId: env.ALLOWED_GITHUB_USER_ID, username: pending.username, permissionLevel: pending.permissionLevel,
      authorizationVersion: AUTHORIZATION_VERSION, pkceMethod: "S256", clientId: pending.authRequest.clientId,
      advancedSecurity: policy.advancedSecurity, securityPolicyVersion: policy.version,
    } satisfies AuthorizationProps,
  });
}

const app = new Hono<{ Bindings: AppEnv }>();

app.use("*", async (c, next) => {
  if (c.req.path.startsWith("/security") || c.req.path.startsWith("/authorize")) {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  }
  await next();
});

async function beginSecurityLogin(c: Context<{ Bindings: AppEnv }>, recovery: boolean, returnTo = "/security") {
  const origin = new URL(c.env.SCHWAB_REDIRECT_URI).origin;
  const state = await saveState(c.env, "github", { action: recovery ? "security_recover" : "security_login", origin, returnTo } satisfies GitHubStatePayload);
  setCookie(c, FLOW_COOKIE, state, FLOW_COOKIE_OPTIONS);
  deleteCookie(c, SECURITY_COOKIE, { path: "/", secure: true });
  return c.redirect(githubAuthorizationUrl(c.env, origin, state));
}
app.get("/security/recover", c => beginSecurityLogin(c, true));
app.get("/security", renderSecurity);
app.get("/security/approvals/:proposalId", renderSecurity);
async function renderSecurity(c: Context<{ Bindings: AppEnv }>) {
  if (new URL(c.req.url).origin !== new URL(c.env.SCHWAB_REDIRECT_URI).origin) return c.text("Invalid origin", 400);
  const sessionId = getCookie(c, SECURITY_COOKIE);
  let state: { session: BrowserSession; credentials: { id: string; name: string }[] };
  try {
    if (!sessionId) throw new Error("No session");
    state = await securityCall(c.env, "/session", { sessionId });
  } catch { return beginSecurityLogin(c, false, c.req.path); }
  const proposalId = c.req.param("proposalId");
  if (proposalId) {
    try {
      const proposal = await securityCall<Parameters<typeof renderSecurityPage>[2]>(c.env, "/proposal", { sessionId, proposalId });
      return await c.html(renderSecurityPage(state.session, state.credentials, proposal));
    } catch { return c.text("提案不可用，请返回客户端查询状态。", 403); }
  }
  return c.html(renderSecurityPage(state.session, state.credentials));
}
app.post("/security/api/:action", async c => {
  const action = c.req.param("action");
  if (!["options", "verify", "add-options", "add-verify"].includes(action)) return browserError("INVALID_ARGUMENT", "Unknown operation", 404);
  if (c.req.header("Origin") !== new URL(c.env.SCHWAB_REDIRECT_URI).origin || !c.req.header("Content-Type")?.startsWith("application/json")) return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin or content type", 403);
  const sessionId = getCookie(c, SECURITY_COOKIE);
  const csrf = c.req.header("X-CSRF-Token");
  if (!sessionId || !csrf) return browserError("BROWSER_AUTH_REQUIRED", "Browser authentication required", 403);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return browserError("INVALID_ARGUMENT", "Invalid request", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); return browserError("INVALID_ARGUMENT", "Request too large", 413); }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(await new Blob(chunks.map(chunk => new Uint8Array(chunk))).arrayBuffer()));
    if (!body || typeof body !== "object" || Array.isArray(body)) return browserError("INVALID_ARGUMENT", "Invalid request", 400);
    // Browser-supplied identity, CSRF and session fields can never override trusted values.
    const result = await securityCall<Record<string, unknown>>(c.env, `/${action}`, { ...body, sessionId, csrf });
    if (typeof result.authorizationTicket === "string") {
      const proof = await securityCall<{ pending: PendingAuthorization; ticket: string }>(c.env, "/authorization", { ticket: result.authorizationTicket });
      const completed = await finishAuthorization(c.env, proof.pending, proof.ticket);
      if (completed instanceof Response) return completed;
      deleteCookie(c, SECURITY_COOKIE, { path: "/", secure: true });
      return c.json({ redirectTo: completed.redirectTo });
    }
    return c.json(result);
  } catch (error) {
    if (error instanceof SecurityCallError) return c.json({ error: error.error }, 403);
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "browser_security_failed", requestId }));
    return c.json({ error: { code: "SECURITY_VERIFICATION_FAILED", message: "验证失败或状态已过期，请刷新页面重试。", requestId } }, 403);
  }
});

app.get("/health", (c) => c.json({ status: "ok", version: c.env.APP_VERSION }));

app.get("/", (c) =>
  c.json({
    name: "schwab-mcp",
    version: c.env.APP_VERSION,
    transport: "streamable-http",
    endpoint: "/mcp",
    readonly: false,
    oauthScopes: {
      access: READ_SCOPE,
    },
  }),
);

app.get("/authorize", async (c) => {
  const params = new URL(c.req.url).searchParams;
  if (params.getAll("code_challenge").length !== 1 || params.getAll("code_challenge_method").length !== 1 ||
      !hasS256Pkce({ codeChallenge: params.get("code_challenge") ?? undefined, codeChallengeMethod: params.get("code_challenge_method") ?? undefined })) {
    return invalidPkceResponse();
  }
  const authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return c.text("Invalid OAuth client", 400);
  const origin = new URL(c.env.SCHWAB_REDIRECT_URI).origin;
  const state = await saveState(c.env, "consent", {
    action: "mcp_authorize", origin, authRequest, authorizationVersion: AUTHORIZATION_VERSION,
  } satisfies GitHubStatePayload);
  setCookie(c, FLOW_COOKIE, state, FLOW_COOKIE_OPTIONS);
  const clientName = client.clientName ?? client.clientId;
  const policy = await securityCall<ClientPolicy>(c.env, "/policy", { clientId: authRequest.clientId });
  return c.html(renderAuthorizePage({ clientName, redirectUri: authRequest.redirectUri, state, advancedSecurity: policy.advancedSecurity }));
});

app.post("/authorize/approve", async (c) => {
  const form = await c.req.parseBody();
  const state = form.state;
  if (typeof state !== "string" || getCookie(c, FLOW_COOKIE) !== state) return c.text("Invalid consent state", 400);
  const permissionLevel = form.permissionLevel;
  if (!isPermissionLevel(permissionLevel)) return c.text("Invalid permission level", 400);
  let payload: GitHubStatePayload;
  try {
    payload = await consumeState<GitHubStatePayload>(c.env, state, "consent");
  } catch (error) {
    if (!(error instanceof InvalidOAuthStateError)) throw error;
    return c.text("Invalid or expired consent state", 400);
  }
  if (payload.action !== "mcp_authorize" || payload.authorizationVersion !== AUTHORIZATION_VERSION) {
    return c.text("Authorization expired; restart authorization", 400);
  }
  if (!hasS256Pkce(payload.authRequest)) return invalidPkceResponse();
  if (form.advancedSecurity !== undefined && form.advancedSecurity !== "on") return c.text("Invalid advanced security selection", 400);
  const advancedSecurity = form.advancedSecurity === "on";
  if (advancedSecurity && permissionLevel !== "full_access") return c.text("Advanced Security requires full access", 400);
  const githubState = await saveState(c.env, "github", { ...payload, permissionLevel, advancedSecurity });
  setCookie(c, FLOW_COOKIE, githubState, FLOW_COOKIE_OPTIONS);
  return c.redirect(githubAuthorizationUrl(c.env, payload.origin, githubState));
});

app.get("/auth/schwab/connect", async (c) => {
  const origin = new URL(c.env.SCHWAB_REDIRECT_URI).origin;
  const state = await saveState(c.env, "github", { action: "schwab_connect", origin } satisfies GitHubStatePayload);
  setCookie(c, FLOW_COOKIE, state, FLOW_COOKIE_OPTIONS);
  return c.redirect(githubAuthorizationUrl(c.env, origin, state));
});

app.get("/auth/github/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || !code) return c.text("Missing GitHub OAuth callback parameters", 400);
  if (getCookie(c, FLOW_COOKIE) !== state) return c.text("Invalid browser OAuth state", 400);
  try {
    const payload = await consumeState<GitHubStatePayload>(c.env, state, "github");
    const user = await exchangeGitHubCode(c.env, payload.origin, code);
    if (!isAllowedGitHubUser(user.id, c.env.ALLOWED_GITHUB_USER_ID)) return c.text("Forbidden", 403);

    if (payload.action === "security_login" || payload.action === "security_recover") {
      const created = await securityCall<{ sessionId: string }>(c.env, "/session/create", { recovery: payload.action === "security_recover" });
      setCookie(c, SECURITY_COOKIE, created.sessionId, { ...FLOW_COOKIE_OPTIONS, maxAge: 900 });
      deleteCookie(c, FLOW_COOKIE, { path: "/", secure: true });
      return c.redirect(payload.returnTo ?? "/security");
    }
    if (payload.action === "schwab_connect") {
      const schwab = await beginSchwabAuthorization(c.env, payload.origin);
      setCookie(c, FLOW_COOKIE, schwab.state, FLOW_COOKIE_OPTIONS);
      return c.redirect(schwab.url);
    }
    if (!payload.authRequest) return c.text("Missing MCP authorization request", 400);
    if (payload.authorizationVersion !== AUTHORIZATION_VERSION || !isPermissionLevel(payload.permissionLevel)) {
      return c.text("Authorization expired; restart authorization", 400);
    }
    if (!hasS256Pkce(payload.authRequest)) return invalidPkceResponse();
    if (payload.advancedSecurity === true && payload.permissionLevel !== "full_access") return c.text("Invalid security mode", 400);
    const policy = await securityCall<ClientPolicy>(c.env, "/policy", { clientId: payload.authRequest.clientId });
    const pending: PendingAuthorization = { authRequest: payload.authRequest, permissionLevel: payload.permissionLevel, advancedSecurity: payload.advancedSecurity ?? false, username: user.login, policyVersion: policy.version };
    if (pending.advancedSecurity || policy.advancedSecurity) {
      const created = await securityCall<{ sessionId: string }>(c.env, "/session/create", { pending });
      setCookie(c, SECURITY_COOKIE, created.sessionId, { ...FLOW_COOKIE_OPTIONS, maxAge: 900 });
      deleteCookie(c, FLOW_COOKIE, { path: "/", secure: true });
      return c.redirect("/security");
    }
    const result = await finishAuthorization(c.env, pending);
    if (result instanceof Response) return result;
    const redirectTo = result.redirectTo;
    deleteCookie(c, FLOW_COOKIE, { path: "/", secure: true });
    return c.redirect(redirectTo);
  } catch (error) {
    console.error(JSON.stringify({ event: "github_oauth_failed", errorType: error instanceof Error ? error.name : "UnknownError" }));
    return c.text("GitHub authorization failed", 400);
  }
});

app.get("/auth/schwab/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state || !code) return c.text("Missing Schwab OAuth callback parameters", 400);
  if (getCookie(c, FLOW_COOKIE) !== state) return c.text("Invalid browser OAuth state", 400);
  try {
    await consumeState<{ origin: string }>(c.env, state, "schwab");
    const response = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${c.env.SCHWAB_CLIENT_ID}:${c.env.SCHWAB_CLIENT_SECRET}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: c.env.SCHWAB_REDIRECT_URI,
      }),
    });
    const tokenBody: unknown = await response.json();
    if (!response.ok) throw new Error(`Schwab token exchange returned HTTP ${String(response.status)}`);
    const saved = await vaultStub(c.env).fetch("https://vault/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tokenBody),
    });
    if (!saved.ok) throw new Error("Schwab token response was invalid");
    deleteCookie(c, FLOW_COOKIE, { path: "/", secure: true });
    return c.html(renderSchwabConnectedPage());
  } catch (error) {
    console.error(JSON.stringify({ event: "schwab_oauth_failed", errorType: error instanceof Error ? error.name : "UnknownError" }));
    return c.text("Schwab authorization failed", 400);
  }
});

export { app as AuthHandler };
