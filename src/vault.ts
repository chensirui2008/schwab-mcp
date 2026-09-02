import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { logEvent } from "./log";
import type { PublicError, TokenRecord, VaultRequest } from "./types";

const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INLINE_RETRY_WAIT_MS = 2000;

export function retryAfterDelay(header: string | null, now = Date.now()): number {
  if (header === null) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

interface SchwabTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function field(value: object, key: string): unknown {
  return Reflect.get(value, key) as unknown;
}

function isTokenResponse(value: unknown): value is SchwabTokenResponse {
  if (value === null || typeof value !== "object") return false;
  return (
    typeof field(value, "access_token") === "string" &&
    typeof field(value, "refresh_token") === "string" &&
    typeof field(value, "expires_in") === "number"
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && Object.values(value).every((item) => typeof item === "string");
}

function isVaultRequest(value: unknown): value is VaultRequest {
  if (value === null || typeof value !== "object") return false;
  const base = field(value, "base");
  const path = field(value, "path");
  const requestId = field(value, "requestId");
  const tool = field(value, "tool");
  const query = field(value, "query");
  return (
    (base === "market" || base === "trader") &&
    typeof path === "string" &&
    typeof requestId === "string" &&
    typeof tool === "string" &&
    (query === undefined || isStringRecord(query))
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function publicError(error: PublicError, status: number): Response {
  return jsonResponse({ error }, status);
}

export class SchwabVault extends DurableObject<AppEnv> {
  private refreshPromise: Promise<TokenRecord> | undefined;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS schwab_token (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        access_expires_at INTEGER NOT NULL,
        refresh_expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_state (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/state") {
      return this.saveState(request);
    }
    if (request.method === "POST" && url.pathname === "/state/consume") {
      return this.consumeState(request);
    }
    if (request.method === "PUT" && url.pathname === "/token") {
      return this.saveAuthorizationToken(request);
    }
    if (request.method === "GET" && url.pathname === "/status") {
      const token = this.readToken();
      if (token && token.refreshExpiresAt <= Date.now()) this.markReauthorizationRequired(token);
      const connected = token?.status === "connected" && token.refreshExpiresAt > Date.now();
      return jsonResponse({
        connected,
        status: connected ? "connected" : "reauthorization_required",
        accessExpiresAt: token?.accessExpiresAt ?? null,
        refreshExpiresAt: token?.refreshExpiresAt ?? null,
      });
    }
    if (request.method === "POST" && url.pathname === "/request") {
      return this.proxySchwab(request);
    }
    return new Response("Not found", { status: 404 });
  }

  private async saveState(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (input === null || typeof input !== "object") return new Response("Invalid state", { status: 400 });
    const state = field(input, "state");
    const kind = field(input, "kind");
    const payload = field(input, "payload");
    const expiresAt = field(input, "expiresAt");
    if (typeof state !== "string" || typeof kind !== "string" || typeof expiresAt !== "number") {
      return new Response("Invalid state", { status: 400 });
    }
    this.ctx.storage.sql.exec("DELETE FROM oauth_state WHERE expires_at < ?", Date.now());
    this.ctx.storage.sql.exec(
      "INSERT INTO oauth_state (state, kind, payload, expires_at) VALUES (?, ?, ?, ?)",
      state,
      kind,
      JSON.stringify(payload),
      expiresAt,
    );
    return new Response(null, { status: 204 });
  }

  private async consumeState(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (input === null || typeof input !== "object") return new Response("Invalid state", { status: 400 });
    const state = field(input, "state");
    const kind = field(input, "kind");
    if (typeof state !== "string" || typeof kind !== "string") {
      return new Response("Invalid state", { status: 400 });
    }
    const rows = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "DELETE FROM oauth_state WHERE state = ? AND kind = ? AND expires_at >= ? RETURNING payload",
        state,
        kind,
        Date.now(),
      )
      .toArray();
    const row = rows[0];
    return row ? jsonResponse({ payload: JSON.parse(row.payload) as unknown }) : new Response("Invalid or expired state", { status: 400 });
  }

  private async saveAuthorizationToken(request: Request): Promise<Response> {
    const value: unknown = await request.json();
    if (!isTokenResponse(value)) return new Response("Invalid token response", { status: 400 });
    const now = Date.now();
    this.writeToken({
      accessToken: value.access_token,
      refreshToken: value.refresh_token,
      accessExpiresAt: now + value.expires_in * 1000,
      refreshExpiresAt: now + REFRESH_TOKEN_LIFETIME_MS,
      status: "connected",
      updatedAt: now,
    });
    return new Response(null, { status: 204 });
  }

  private readToken(): TokenRecord | null {
    const row = this.ctx.storage.sql
      .exec<{
        access_token: string;
        refresh_token: string;
        access_expires_at: number;
        refresh_expires_at: number;
        status: TokenRecord["status"];
        updated_at: number;
      }>("SELECT * FROM schwab_token WHERE id = 1")
      .toArray()[0];
    if (!row) return null;
    return {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      accessExpiresAt: row.access_expires_at,
      refreshExpiresAt: row.refresh_expires_at,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  private writeToken(token: TokenRecord): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO schwab_token
       (id, access_token, refresh_token, access_expires_at, refresh_expires_at, status, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
       refresh_token=excluded.refresh_token, access_expires_at=excluded.access_expires_at,
       refresh_expires_at=excluded.refresh_expires_at, status=excluded.status, updated_at=excluded.updated_at`,
      token.accessToken,
      token.refreshToken,
      token.accessExpiresAt,
      token.refreshExpiresAt,
      token.status,
      token.updatedAt,
    );
  }

  private markReauthorizationRequired(token: TokenRecord): void {
    this.writeToken({ ...token, status: "reauthorization_required", updatedAt: Date.now() });
  }

  private async refreshToken(force: boolean, requestId: string, failedAccessToken?: string): Promise<TokenRecord> {
    const current = this.readToken();
    if (!current || current.status !== "connected" || current.refreshExpiresAt <= Date.now()) {
      if (current) this.markReauthorizationRequired(current);
      throw new Error("REAUTHORIZATION_REQUIRED");
    }
    if (force && failedAccessToken !== undefined && current.accessToken !== failedAccessToken) return current;
    if (!force && current.accessExpiresAt - ACCESS_REFRESH_SKEW_MS > Date.now()) return current;
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.performRefresh(current, requestId).finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async performRefresh(current: TokenRecord, requestId: string): Promise<TokenRecord> {
    const started = Date.now();
    const response = await fetch("https://api.schwabapi.com/v1/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.env.SCHWAB_CLIENT_ID}:${this.env.SCHWAB_CLIENT_SECRET}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }),
    });
    const body: unknown = await response.json().catch(() => null);
    logEvent("schwab_token_refresh", {
      requestId,
      status: response.status,
      durationMs: Date.now() - started,
    });
    if (!response.ok || !isTokenResponse(body)) {
      const errorName = body !== null && typeof body === "object" ? field(body, "error") : undefined;
      const reauthorizationRequired = errorName === "invalid_grant";
      if (reauthorizationRequired) this.markReauthorizationRequired(current);
      throw new Error(reauthorizationRequired ? "REAUTHORIZATION_REQUIRED" : "UPSTREAM_UNAVAILABLE");
    }
    const now = Date.now();
    const refreshed: TokenRecord = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      accessExpiresAt: now + body.expires_in * 1000,
      refreshExpiresAt: current.refreshExpiresAt,
      status: "connected",
      updatedAt: now,
    };
    this.writeToken(refreshed);
    return refreshed;
  }

  private async proxySchwab(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isVaultRequest(input)) {
      return publicError({ code: "INVALID_ARGUMENT", message: "Invalid Schwab request", requestId: crypto.randomUUID() }, 400);
    }
    if (!input.path.startsWith("/") || input.path.startsWith("//") || input.path.includes("..")) {
      return publicError({ code: "INVALID_ARGUMENT", message: "Invalid Schwab API path", requestId: input.requestId }, 400);
    }
    const baseUrl = input.base === "market" ? this.env.MARKET_DATA_BASE_URL : this.env.TRADER_BASE_URL;
    const url = new URL(`${baseUrl}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);

    let attempts = 0;
    let forceRefresh = false;
    let failedAccessToken: string | undefined;
    while (attempts < 2) {
      attempts += 1;
      let token: TokenRecord;
      try {
        token = await this.refreshToken(forceRefresh, input.requestId, failedAccessToken);
      } catch (error) {
        const reauth = error instanceof Error && error.message === "REAUTHORIZATION_REQUIRED";
        return publicError(
          {
            code: reauth ? "REAUTHORIZATION_REQUIRED" : "UPSTREAM_UNAVAILABLE",
            message: reauth ? "Schwab authorization must be renewed" : "Unable to refresh Schwab authorization",
            requestId: input.requestId,
            attempts,
          },
          reauth ? 401 : 502,
        );
      }

      const started = Date.now();
      const upstream = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token.accessToken}` } });
      logEvent("schwab_api_request", {
        requestId: input.requestId,
        tool: input.tool,
        status: upstream.status,
        attempts,
        durationMs: Date.now() - started,
      });
      if (upstream.ok) {
        const result: unknown = await upstream.json();
        return jsonResponse({ result, attempts });
      }
      if (upstream.status === 401 && attempts === 1) {
        failedAccessToken = token.accessToken;
        forceRefresh = true;
        continue;
      }
      const retryAfterMs = retryAfterDelay(upstream.headers.get("Retry-After"));
      if ((upstream.status === 429 || upstream.status >= 500) && attempts === 1 && retryAfterMs <= MAX_INLINE_RETRY_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        continue;
      }
      const code = upstream.status === 429 ? "RATE_LIMITED" : upstream.status >= 500 ? "UPSTREAM_UNAVAILABLE" : "SCHWAB_REJECTED";
      return publicError(
        { code, message: `Schwab API returned HTTP ${String(upstream.status)}`, requestId: input.requestId, attempts, ...(retryAfterMs > 0 ? { retryAfterMs } : {}) },
        upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400,
      );
    }
    return publicError(
      { code: "UPSTREAM_UNAVAILABLE", message: "Schwab API request failed", requestId: input.requestId, attempts },
      502,
    );
  }
}
