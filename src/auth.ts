import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Context } from "hono";
import { renderSecurityPage } from "./security-ui";
import { renderDashboardPage } from "./dashboard-ui";
import type { BrowserSession, ClientPolicy, PendingAuthorization } from "./security-store";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { BRAND_LOGO_SVG, renderAuthorizePage, renderGitHubContinuePage, renderPasskeyAuthorizedPage, renderSchwabConnectedPage } from "./auth-ui";
import type { ErrorCode, PublicError } from "./types";
import type { AppEnv } from "./env";
import { tradingEnabled, vaultStub } from "./env";
import { AUTHORIZATION_VERSION, isPermissionLevel, READ_SCOPE } from "./oauth-access";
import type { AuthorizationProps, PermissionLevel } from "./oauth-access";
import { z } from "zod";
import {
  clientIdSchema, dashboardPolicyInputSchema, isJsonContentType, parseAuditQuery, permissionSchema,
  policySchema, readBoundedJson, RequestBodyError, sessionEnvelopeSchema, timestampSchema, versionSchema,
} from "./security-validation";

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

const grantSchema = z.object({
  id: z.string().min(1), clientId: clientIdSchema, userId: z.string().min(1),
  createdAt: z.number().int().nonnegative().max(Math.floor(Number.MAX_SAFE_INTEGER / 1000)),
  expiresAt: z.number().int().nonnegative().optional(), scope: z.array(z.string()),
  metadata: z.unknown(),
});
async function checkedUserGrants(provider: OAuthHelpers, userId: string) {
  const grants = new Map<string, z.infer<typeof grantSchema>>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const raw: unknown = await provider.listUserGrants(userId, { limit: 50, ...(cursor ? { cursor } : {}) });
    const parsed = z.object({ items: z.array(grantSchema), cursor: z.string().min(1).optional() }).safeParse(raw);
    if (!parsed.success) throw new Error("Invalid grant page");
    const page = parsed.data;
    for (const grant of page.items) {
      if (grant.userId !== userId) throw new Error("Unexpected grant owner");
      grants.set(grant.id, grant);
    }
    cursor = page.cursor;
    if (cursor && cursors.has(cursor)) throw new Error("Repeated grant cursor");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return [...grants.values()];
}
async function revokeClientGrants(provider: OAuthHelpers, userId: string, clientId: string): Promise<void> {
  const grants = await checkedUserGrants(provider, userId);
  for (const grant of grants) if (grant.clientId === clientId) await provider.revokeGrant(grant.id, userId);
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
  const url = new URL(env.acceptanceGitHub?.url ?? "https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${origin}/auth/github/callback`);
  url.searchParams.set("scope", "read:user");
  url.searchParams.set("state", state);
  return url.toString();
}

async function exchangeGitHubCode(env: AppEnv, origin: string, code: string): Promise<GitHubUser> {
  const tokenResponse = await (env.acceptanceGitHub?.fetch ?? fetch)("https://github.com/login/oauth/access_token", {
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
  const profileResponse = await (env.acceptanceGitHub?.fetch ?? fetch)("https://api.github.com/user", {
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
    const raw: unknown = await response.json();
    const parsed = publicErrorSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid security error");
    throw new SecurityCallError(parsed.data.error);
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
  const policy = await securityCall<ClientPolicy>(env, "/commit-policy", { clientId: pending.authRequest.clientId, advancedSecurity: pending.advancedSecurity, expected: pending.policyVersion, permissionLevel: pending.permissionLevel, ticket });
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
  await next();
  // Apply to the final response, including early errors built with Response.json().
  if (c.req.path.startsWith("/security") || c.req.path.startsWith("/authorize") || c.req.path.startsWith("/dashboard")) {
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", "default-src 'none'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
  }
});

app.get("/favicon.svg", c => c.body(BRAND_LOGO_SVG, 200, {
  "Content-Type": "image/svg+xml",
  "Cache-Control": "public, max-age=86400",
  "X-Content-Type-Options": "nosniff",
}));

async function beginSecurityLogin(c: Context<{ Bindings: AppEnv }>, recovery: boolean, returnTo = "/security") {
  const origin = new URL(c.env.SCHWAB_REDIRECT_URI).origin;
  if (new URL(c.req.url).origin !== origin) return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin", 403);
  const state = await saveState(c.env, "github", { action: recovery ? "security_recover" : "security_login", origin, returnTo } satisfies GitHubStatePayload);
  setCookie(c, FLOW_COOKIE, state, FLOW_COOKIE_OPTIONS);
  deleteCookie(c, SECURITY_COOKIE, { path: "/", secure: true });
  return c.redirect(githubAuthorizationUrl(c.env, origin, state));
}
app.get("/security/recover", c => beginSecurityLogin(c, true));
app.get("/security", renderSecurity);
app.get("/security/approvals/:proposalId", renderSecurity);
app.get("/security/approvals/:proposalId/complete", renderSecurity);
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
      if (c.req.path.endsWith("/complete")) {
        if (!proposal || !["EXECUTED", "ACTIVE"].includes(proposal.status)) return c.text("授权尚未成功完成，请返回客户端查询状态。", 409);
        return c.html(renderPasskeyAuthorizedPage());
      }
      return await c.html(renderSecurityPage(state.session, state.credentials, proposal));
    } catch { return c.text("提案不可用，请返回客户端查询状态。", 403); }
  }
  return c.html(renderSecurityPage(state.session, state.credentials));
}
app.post("/security/api/:action", async c => {
  const action = c.req.param("action");
  if (!["options", "verify", "add-options", "add-verify"].includes(action)) return browserError("INVALID_ARGUMENT", "Unknown operation", 404);
  if (new URL(c.req.url).origin !== new URL(c.env.SCHWAB_REDIRECT_URI).origin || c.req.header("Origin") !== new URL(c.env.SCHWAB_REDIRECT_URI).origin || !isJsonContentType(c.req.header("Content-Type"))) return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin or content type", 403);
  const sessionId = getCookie(c, SECURITY_COOKIE);
  const csrf = c.req.header("X-CSRF-Token");
  if (!sessionId || !csrf) return browserError("BROWSER_AUTH_REQUIRED", "Browser authentication required", 403);
  try {
    const body = await readBoundedJson(c.req.raw);
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
    if (error instanceof RequestBodyError) return browserError("INVALID_ARGUMENT", error.message, error.status);
    if (error instanceof SecurityCallError) return Response.json({ error: error.error }, { status: error.error.code === "INVALID_ARGUMENT" ? 400 : error.error.code === "UPSTREAM_UNAVAILABLE" ? 503 : 403 });
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "browser_security_failed", requestId }));
    return c.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Unable to complete browser security operation; retry the request", requestId } }, 503);
  }
});
const publicErrorSchema = z.object({
  error: z.object({
    code: z.enum(["SECURITY_VERIFICATION_FAILED", "SECURITY_POLICY_CHANGED", "BROWSER_AUTH_REQUIRED", "INVALID_ARGUMENT", "UPSTREAM_UNAVAILABLE"]),
    message: z.string(), requestId: z.string().min(1),
  }),
});
async function dashboardVault<T>(env: AppEnv, path: string, schema: z.ZodType<T>, input?: unknown): Promise<T> {
  const response = await vaultStub(env).fetch(`https://vault${path}`, input === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const parsed = publicErrorSchema.safeParse(raw);
    if (!parsed.success) throw new Error("Invalid vault error");
    throw new SecurityCallError(parsed.data.error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid vault response");
  return parsed.data;
}
async function getDashboardSession(c: Context<{ Bindings: AppEnv }>, csrf?: string) {
  const sessionId = getCookie(c, SECURITY_COOKIE);
  if (!sessionId) return null;
  try {
    return await dashboardVault(c.env, "/security/dashboard-session", sessionEnvelopeSchema, { sessionId, ...(csrf ? { csrf } : {}) });
  } catch (error) {
    if (error instanceof SecurityCallError && error.error.code === "BROWSER_AUTH_REQUIRED") return null;
    throw error;
  }
}
function validDashboardOrigin(c: Context<{ Bindings: AppEnv }>): boolean {
  const origin = new URL(c.env.SCHWAB_REDIRECT_URI).origin;
  const requestOrigin = c.req.header("Origin");
  return new URL(c.req.url).origin === origin && (requestOrigin === undefined || requestOrigin === origin);
}
async function dashboardRequest(c: Context<{ Bindings: AppEnv }>, handler: (state: z.infer<typeof sessionEnvelopeSchema>) => Promise<Response> | Response): Promise<Response> {
  if (!validDashboardOrigin(c)) return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin", 403);
  if (c.req.method === "POST" && (c.req.header("Origin") !== new URL(c.env.SCHWAB_REDIRECT_URI).origin || !isJsonContentType(c.req.header("Content-Type")) || !c.req.header("X-CSRF-Token"))) {
    return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin, content type or CSRF token", 403);
  }
  try {
    const state = await getDashboardSession(c, c.req.method === "POST" ? c.req.header("X-CSRF-Token") : undefined);
    if (!state) return browserError("BROWSER_AUTH_REQUIRED", "Browser authentication required", 403);
    return await handler(state);
  } catch (error) {
    if (error instanceof RequestBodyError) return browserError("INVALID_ARGUMENT", error.message, error.status);
    if (error instanceof z.ZodError) return browserError("INVALID_ARGUMENT", "Invalid request", 400);
    if (error instanceof SecurityCallError) return Response.json({ error: error.error }, { status: error.error.code === "UPSTREAM_UNAVAILABLE" ? 503 : error.error.code === "INVALID_ARGUMENT" ? 400 : 403 });
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "dashboard_request_failed", requestId }));
    return Response.json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "Dashboard data is unavailable; retry the request", requestId } }, { status: 503 });
  }
}
async function dashboardPolicyRows(env: AppEnv) {
  // Provider timestamps are seconds (completeAuthorization uses Date.now()/1e3).
  const grants = await checkedUserGrants(env.OAUTH_PROVIDER, env.ALLOWED_GITHUB_USER_ID);
  const grantMap = new Map<string, z.infer<typeof grantSchema>>();
  let legacyGrantCount = 0;
  for (const grant of grants) {
    if (grant.expiresAt !== undefined && grant.expiresAt * 1000 <= Date.now()) continue;
    const version = z.object({ authorizationVersion: z.string().optional() }).safeParse(grant.metadata ?? {});
    if (!version.success) throw new Error("Invalid grant version metadata");
    // Historical grants remain in KV after authorization policy upgrades. They
    // cannot authorize MCP requests and must never seed a current client policy.
    if (version.data.authorizationVersion !== AUTHORIZATION_VERSION) {
      legacyGrantCount++;
      continue;
    }
    const metadata = z.object({ permissionLevel: permissionSchema, advancedSecurity: z.boolean().optional(), securityPolicyVersion: versionSchema.optional() }).safeParse(grant.metadata);
    if (!metadata.success) throw new Error("Invalid grant permission metadata");
    const current = grantMap.get(grant.clientId);
    if (!current || grant.createdAt > current.createdAt || (grant.createdAt === current.createdAt && grant.id > current.id)) grantMap.set(grant.clientId, grant);
  }
  const stored = await dashboardVault(env, "/client/policies", z.object({ policies: z.array(policySchema) }));
  const policies = new Map(stored.policies.map(policy => [policy.clientId, policy]));
  for (const [clientId, grant] of grantMap) {
    const parsed = z.object({ permissionLevel: permissionSchema, advancedSecurity: z.boolean().optional(), securityPolicyVersion: versionSchema.optional() }).safeParse(grant.metadata);
    if (!parsed.success) throw new Error("Invalid grant permission metadata");
    const metadata = parsed.data;
    const query = new URLSearchParams({
      clientId, ensure: "true", permissionLevel: metadata.permissionLevel,
      advancedSecurity: String(metadata.advancedSecurity ?? false), version: String(metadata.securityPolicyVersion ?? 0),
    });
    const policy = await dashboardVault(env, `/client/policy?${query.toString()}`, policySchema);
    policies.set(clientId, policy);
  }
  return { grantMap, policies, legacyGrantCount };
}
async function requireDashboardClient(env: AppEnv, clientId: string): Promise<ClientPolicy> {
  const { grantMap, policies } = await dashboardPolicyRows(env);
  const policy = policies.get(clientId);
  if (!policy || !grantMap.has(clientId)) throw new RequestBodyError("Client authorization was not found");
  if (policy.revoked) throw new SecurityCallError({ code: "SECURITY_POLICY_CHANGED", message: "Client authorization is revoked", requestId: crypto.randomUUID() });
  return policy;
}

// Explicit renewal always starts owner OAuth, even while the old session is valid.
app.get("/dashboard/login", c => beginSecurityLogin(c, false, "/dashboard"));
app.get("/dashboard", async c => {
  if (!validDashboardOrigin(c)) return browserError("SECURITY_VERIFICATION_FAILED", "Invalid origin", 403);
  try {
    const state = await getDashboardSession(c);
    if (!state) return await beginSecurityLogin(c, false, "/dashboard");
    return await c.html(renderDashboardPage({ session: state.session, appVersion: c.env.APP_VERSION, allowedUserId: c.env.ALLOWED_GITHUB_USER_ID }));
  } catch {
    return browserError("UPSTREAM_UNAVAILABLE", "Unable to load dashboard session", 503);
  }
});
app.get("/dashboard/api/session", c => dashboardRequest(c, state => c.json({ credentials: state.credentials })));
app.get("/dashboard/api/overview", c => dashboardRequest(c, async state => {
  const schwabStatus = await dashboardVault(c.env, "/status", z.object({
    connected: z.boolean(), status: z.enum(["connected", "reauthorization_required"]),
    accessExpiresAt: timestampSchema.nullable(), refreshExpiresAt: timestampSchema.nullable(),
  }));
  const { grantMap, policies, legacyGrantCount } = await dashboardPolicyRows(c.env);
  const audit = await dashboardVault(c.env, "/audit/tools?limit=1", z.object({ total: versionSchema }));
  return c.json({
    schwabConnected: schwabStatus.connected, schwabStatus, tradingEnabled: tradingEnabled(c.env),
    clientCount: [...grantMap.keys()].filter(clientId => !policies.get(clientId)?.revoked).length,
    toolCallsCount: audit.total, passkeyCount: state.credentials.length, legacyGrantCount,
  });
}));
app.get("/dashboard/api/clients", c => dashboardRequest(c, async () => {
  const { grantMap, policies } = await dashboardPolicyRows(c.env);
  const audit = await dashboardVault(c.env, "/audit/clients", z.object({ clients: z.array(z.object({ clientId: clientIdSchema, lastInvocationAt: timestampSchema })) }));
  const lastInvocations = new Map(audit.clients.map(client => [client.clientId, client.lastInvocationAt]));
  const clients = [];
  for (const [clientId, policy] of policies) {
    if (policy.revoked || !grantMap.has(clientId)) continue;
    const raw: unknown = await c.env.OAUTH_PROVIDER.lookupClient(clientId);
    const parsed = z.object({ clientId: clientIdSchema, clientName: z.string().optional(), redirectUris: z.array(z.string()) }).nullable().safeParse(raw);
    if (!parsed.success || (!parsed.data && grantMap.has(clientId))) throw new Error("Invalid registered client");
    const grant = grantMap.get(clientId);
    clients.push({
      clientId, clientName: parsed.data?.clientName ?? clientId, redirectUris: parsed.data?.redirectUris ?? [],
      createdAt: grant ? grant.createdAt * 1000 : policy.updatedAt, lastInvocationAt: lastInvocations.get(clientId) ?? null,
      permissionLevel: policy.permissionLevel, advancedSecurity: policy.advancedSecurity, version: policy.version,
      revoked: false,
    });
  }
  return c.json({ clients });
}));
app.post("/dashboard/api/clients/permission", c => dashboardRequest(c, async () => {
  const body = z.object({ clientId: clientIdSchema, permissionLevel: permissionSchema }).strict().parse(await readBoundedJson(c.req.raw));
  const current = await requireDashboardClient(c.env, body.clientId);
  const policy = await dashboardVault(c.env, "/client/policy/update", policySchema, {
    ...body, expected: current.version, sessionId: getCookie(c, SECURITY_COOKIE), csrf: c.req.header("X-CSRF-Token"),
  });
  return c.json({ ok: true, policy });
}));
app.post("/dashboard/api/clients/advanced-security", c => dashboardRequest(c, async () => {
  const input = dashboardPolicyInputSchema.parse(await readBoundedJson(c.req.raw));
  await requireDashboardClient(c.env, input.clientId);
  const path = input.challengeId === undefined ? "/security/dashboard-policy-options" : "/security/dashboard-policy-verify";
  const response = await dashboardVault(c.env, path, z.union([z.object({
    challengeId: z.string().min(1), options: z.record(z.string(), z.unknown()), registration: z.boolean(),
  }), z.object({ ok: z.literal(true), policy: policySchema })]), {
    sessionId: getCookie(c, SECURITY_COOKIE), csrf: c.req.header("X-CSRF-Token"), input,
  });
  return c.json(response);
}));
app.post("/dashboard/api/clients/revoke", c => dashboardRequest(c, async () => {
  const body = z.object({ clientId: clientIdSchema }).strict().parse(await readBoundedJson(c.req.raw));
  const { grantMap, policies } = await dashboardPolicyRows(c.env);
  const current = policies.get(body.clientId);
  if (!current || (!grantMap.has(body.clientId) && !current.revoked)) throw new RequestBodyError("Client authorization was not found");
  // Durable authority is revoked first. Provider failure must never leave tokens usable.
  await dashboardVault(c.env, "/client/policy/update", policySchema, {
    clientId: body.clientId, revoked: true, expected: current.version,
    sessionId: getCookie(c, SECURITY_COOKIE), csrf: c.req.header("X-CSRF-Token"),
  });
  await revokeClientGrants(c.env.OAUTH_PROVIDER, c.env.ALLOWED_GITHUB_USER_ID, body.clientId);
  return c.json({ ok: true });
}));
app.get("/dashboard/api/audit", c => dashboardRequest(c, async () => {
  const query = parseAuditQuery(new URL(c.req.url).searchParams);
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
  if (query.clientId) params.set("clientId", query.clientId);
  if (query.toolName) params.set("toolName", query.toolName);
  if (query.status) params.set("status", query.status);
  const result = await dashboardVault(c.env, `/audit/tools?${params.toString()}`, z.object({
    items: z.array(z.object({
      id: z.string(), clientId: clientIdSchema, toolName: z.string(), requestId: z.string(), status: z.enum(["SUCCESS", "ERROR"]),
      parametersSummary: z.string().nullable(), errorCode: z.string().nullable(), errorMessage: z.string().nullable(),
      durationMs: versionSchema, createdAt: timestampSchema,
    })),
    total: versionSchema, successCount: versionSchema, errorCount: versionSchema, active24h: versionSchema,
    limit: z.number().int().min(1).max(100), offset: z.number().int().min(0).max(5000),
  }));
  return c.json(result);
}));


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
  return c.html(renderGitHubContinuePage(githubAuthorizationUrl(c.env, payload.origin, githubState)));
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
