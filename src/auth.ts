import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { renderAuthorizePage, renderSchwabConnectedPage } from "./auth-ui";
import type { AppEnv } from "./env";
import { vaultStub } from "./env";
import { READ_SCOPE } from "./oauth-access";

const STATE_TTL_MS = 10 * 60 * 1000;
const FLOW_COOKIE = "__Host-schwab-oauth";
const FLOW_COOKIE_OPTIONS = { secure: true, httpOnly: true, sameSite: "Lax" as const, path: "/", maxAge: STATE_TTL_MS / 1000 };

interface GitHubUser {
  id: number;
  login: string;
  name: string | null | undefined;
}

interface GitHubStatePayload {
  action: "mcp_authorize" | "schwab_connect";
  origin: string;
  authRequest?: AuthRequest;
}

export function isAllowedGitHubUser(userId: number, allowedUserId: string): boolean {
  return String(userId) === allowedUserId;
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
  if (!response.ok) throw new Error("Invalid or expired OAuth state");
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

const app = new Hono<{ Bindings: AppEnv }>();

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
  const authRequest = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const client = await c.env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (!client) return c.text("Invalid OAuth client", 400);
  const origin = new URL(c.req.url).origin;
  const state = await saveState(c.env, "consent", { action: "mcp_authorize", origin, authRequest } satisfies GitHubStatePayload);
  setCookie(c, FLOW_COOKIE, state, FLOW_COOKIE_OPTIONS);
  const clientName = client.clientName ?? client.clientId;
  return c.html(renderAuthorizePage({ clientName, redirectUri: authRequest.redirectUri, state }));
});

app.post("/authorize/approve", async (c) => {
  const form = await c.req.parseBody();
  const state = form.state;
  if (typeof state !== "string" || getCookie(c, FLOW_COOKIE) !== state) return c.text("Invalid consent state", 400);
  const payload = await consumeState<GitHubStatePayload>(c.env, state, "consent");
  const githubState = await saveState(c.env, "github", payload);
  setCookie(c, FLOW_COOKIE, githubState, FLOW_COOKIE_OPTIONS);
  return c.redirect(githubAuthorizationUrl(c.env, payload.origin, githubState));
});

app.get("/auth/schwab/connect", async (c) => {
  const origin = new URL(c.req.url).origin;
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

    if (payload.action === "schwab_connect") {
      const schwab = await beginSchwabAuthorization(c.env, payload.origin);
      setCookie(c, FLOW_COOKIE, schwab.state, FLOW_COOKIE_OPTIONS);
      return c.redirect(schwab.url);
    }
    if (!payload.authRequest) return c.text("Missing MCP authorization request", 400);
    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: payload.authRequest,
      userId: String(user.id),
      metadata: { label: "Personal Schwab MCP" },
      scope: [READ_SCOPE],
      props: { userId: String(user.id), username: user.login },
    });
    deleteCookie(c, FLOW_COOKIE, { path: "/", secure: true });
    return c.redirect(redirectTo);
  } catch (error) {
    console.error(JSON.stringify({ event: "github_oauth_failed", message: error instanceof Error ? error.message : "Unknown error" }));
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
    console.error(JSON.stringify({ event: "schwab_oauth_failed", message: error instanceof Error ? error.message : "Unknown error" }));
    return c.text("Schwab authorization failed", 400);
  }
});

export { app as AuthHandler };
