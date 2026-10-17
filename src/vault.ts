import { DurableObject } from "cloudflare:workers";
import type { AppEnv } from "./env";
import { tradingEnabled } from "./env";
import { SecurityError, SecurityStore } from "./security-store";
import type { ApprovalBinding, ClientIdentity, PendingAuthorization } from "./security-store";
import { z } from "zod";
import { logEvent } from "./log";
import { toolSchemas, tradeConditionSchema } from "./schemas";
import { assertSafeOrderPayload, canonicalJson, collectQuoteSymbols, evaluateCondition, randomToken, sha256, tokenMatches } from "./trading";
import type { JsonValue, PublicError, TokenRecord, TradeCondition, TradeProposalInput, VaultRequest } from "./types";
import {
  clientIdSchema, credentialResponseSchema, dashboardPolicyInputSchema, isJsonContentType,
  parseAuditQuery, pendingAuthorizationSchema, permissionSchema, policyUpdateSchema,
  readBoundedJson, registrationResponseSchema, RequestBodyError, toolAuditInputSchema, truncateUtf8, versionSchema,
} from "./security-validation";

const ACCESS_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INLINE_RETRY_WAIT_MS = 2000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const DISABLED_ALARM_RECHECK_MS = 15 * 60 * 1000;
const DIRECT_TRADING_IDLE_TTL_MS = 30 * 60 * 1000;
const DIRECT_TRADING_MAX_TTL_MS = 8 * 60 * 60 * 1000;

interface ProposalRow {
  [key: string]: string | number | null;
  id: string;
  mode: TradeProposalInput["executionMode"];
  action: TradeProposalInput["action"];
  account_hash: string;
  order_id: number | null;
  order_json: string;
  condition_json: string | null;
  valid_until: number | null;
  poll_interval_seconds: number | null;
  replaces_task_id: string | null;
  intent_digest: string;
  token_hash: string;
  confirmation_text: string;
  status: string;
  expires_at: number;
  approval_method: string;
  client_id: string | null;
  policy_version: number;
  outcome_json: string | null;
}

interface DelayedTradeRow {
  [key: string]: string | number | null;
  id: string;
  version: number;
  action: TradeProposalInput["action"];
  account_hash: string;
  order_id: number | null;
  order_json: string;
  condition_json: string;
  valid_until: number;
  poll_interval_seconds: number;
  intent_digest: string;
  status: string;
  next_check_at: number;
  execution_request_id: string | null;
  outcome_json: string | null;
  updated_at: number;
}

interface DirectTradingSessionRow {
  [key: string]: string | number | null;
  id: string;
  idle_expires_at: number;
  absolute_expires_at: number;
}

interface DirectTradeExecutionRow {
  [key: string]: string | number | null;
  intent_digest: string;
  status: string;
  outcome_json: string | null;
  response_status: number | null;
}

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
    (field(value, "access_token") as string).length > 0 &&
    typeof field(value, "refresh_token") === "string" &&
    (field(value, "refresh_token") as string).length > 0 &&
    typeof field(value, "expires_in") === "number" &&
    (field(value, "expires_in") as number) > 0
  );
}

function isReauthorizationError(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const details = [field(value, "error"), field(value, "error_description"), field(value, "message")]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  return details.includes("invalid_grant") || (details.includes("refresh token") && /expired|invalid|revoked/.test(details));
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
  private security: SecurityStore;
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
      CREATE TABLE IF NOT EXISTS trade_proposal (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        action TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        order_id INTEGER,
        order_json TEXT NOT NULL,
        condition_json TEXT,
        valid_until INTEGER,
        poll_interval_seconds INTEGER,
        replaces_task_id TEXT,
        intent_digest TEXT NOT NULL,
        instruction_digest TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        confirmation_text TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        outcome_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trade_proposal_expiry ON trade_proposal(status, expires_at);
      CREATE TABLE IF NOT EXISTS delayed_trade (
        id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        action TEXT NOT NULL,
        account_hash TEXT NOT NULL,
        order_id INTEGER,
        order_json TEXT NOT NULL,
        condition_json TEXT NOT NULL,
        valid_until INTEGER NOT NULL,
        poll_interval_seconds INTEGER NOT NULL,
        intent_digest TEXT NOT NULL,
        instruction_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        next_check_at INTEGER NOT NULL,
        execution_request_id TEXT,
        outcome_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_delayed_trade_due ON delayed_trade(status, next_check_at);
      CREATE TABLE IF NOT EXISTS direct_trading_session (
        id TEXT PRIMARY KEY,
        capability_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        absolute_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_direct_trading_session_expiry
        ON direct_trading_session(status, idle_expires_at, absolute_expires_at);
      CREATE TABLE IF NOT EXISTS direct_trade_execution (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        intent_digest TEXT NOT NULL,
        instruction_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome_json TEXT,
        response_status INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trade_audit (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        entity_id TEXT,
        request_id TEXT NOT NULL,
        intent_digest TEXT,
        instruction_digest TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_invocation_audit (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        request_id TEXT NOT NULL,
        status TEXT NOT NULL,
        parameters_summary TEXT,
        error_code TEXT,
        error_message TEXT,
        duration_ms INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_audit_created ON tool_invocation_audit(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_audit_client ON tool_invocation_audit(client_id, created_at DESC);
    `);
    this.security = new SecurityStore(this.ctx.storage, env);
  }

  override async fetch(request: Request): Promise<Response> {
    try { return await this.dispatch(request); }
    catch (error) {
      const requestId = crypto.randomUUID();
      if (error instanceof SecurityError) return publicError({ code: error.code, message: "Security policy changed or verification failed", requestId }, 403);
      if (error instanceof RequestBodyError || error instanceof z.ZodError) return publicError({ code: "INVALID_ARGUMENT", message: error instanceof RequestBodyError ? error.message : "Invalid request", requestId }, error instanceof RequestBodyError ? error.status : 400);
      logEvent("vault_request_failed", { requestId });
      return publicError({ code: "UPSTREAM_UNAVAILABLE", message: "Unable to complete the request", requestId }, 503);
    }
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/security/")) {
      try { return await this.securityRequest(request, url.pathname); }
      catch (error) {
        const requestId = crypto.randomUUID();
        if (!(error instanceof SecurityError)) throw error;
        const code = error.code;
        logEvent("security_request_rejected", { requestId, code });
        return publicError({ code, message: "Security verification failed; restart the browser flow", requestId }, 403);
      }
    }
    if (request.method === "POST" && url.pathname.startsWith("/trade/")) {
      try {
        const raw: unknown = await request.clone().json();
        const identity = this.identity(raw && typeof raw === "object" ? field(raw, "identity") : undefined);
        this.security.assertIdentity(identity);
        if (identity.advancedSecurity && ["/trade/confirm", "/trade/session/enable", "/trade/place-direct"].includes(url.pathname)) throw new SecurityError();
      } catch (error) {
        const code = error instanceof SecurityError ? error.code : "SECURITY_VERIFICATION_FAILED";
        return publicError({ code, message: "Client trading policy is invalid; reconnect if changed", requestId: crypto.randomUUID() }, 403);
      }
    }
    if (request.method === "POST" && url.pathname === "/trade/proposal") {
      const raw = z.object({ identity: z.object({ clientId: clientIdSchema, advancedSecurity: z.boolean(), securityPolicyVersion: versionSchema }), input: z.unknown(), requestId: z.string().optional() }).strict().parse(await readBoundedJson(request));
      this.security.assertIdentity(raw.identity);
      const parsed = toolSchemas.getTradeProposal.safeParse(raw.input);
      if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid proposal query", requestId: crypto.randomUUID() }, 400);
      const proposal = this.proposal(parsed.data.proposalId);
      if (!proposal || proposal.client_id !== raw.identity.clientId) return publicError({ code: "TRADE_NOT_FOUND", message: "Trade proposal was not found", requestId: crypto.randomUUID() }, 404);
      return jsonResponse({ result: this.proposalView(proposal) });
    }
    if (request.method === "POST" && ["/audit/tool", "/client/policy/update"].includes(url.pathname) && !isJsonContentType(request.headers.get("Content-Type"))) throw new RequestBodyError("JSON content type required");
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
    if (request.method === "GET" && url.pathname === "/trading/status") {
      return jsonResponse({ result: { enabled: tradingEnabled(this.env), source: "deployment_config" } });
    }
    if (request.method === "POST" && url.pathname === "/trade/prepare") {
      return this.prepareTrade(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/confirm") {
      return this.confirmTrade(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/session/enable") {
      return this.enableSessionDirectTrading(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/session/disable") {
      return this.disableSessionDirectTrading(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/place-direct") {
      return this.placeOrderDirect(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/cancel-order") {
      return this.cancelOrder(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/cancel-delayed") {
      return this.cancelDelayedTrade(request);
    }
    if (request.method === "POST" && url.pathname === "/trade/list-delayed") {
      return this.listDelayedTrades(request);
    }
    if (request.method === "POST" && url.pathname === "/audit/tool") {
      return this.recordToolAudit(request);
    }
    if (request.method === "GET" && url.pathname === "/audit/tools") {
      return this.queryToolAudits(url.searchParams);
    }
    if (request.method === "GET" && url.pathname === "/audit/clients") {
      this.pruneToolAudits();
      return jsonResponse({ clients: this.ctx.storage.sql.exec<{ clientId: string; lastInvocationAt: number }>(
        "SELECT client_id AS clientId, max(created_at) AS lastInvocationAt FROM tool_invocation_audit GROUP BY client_id ORDER BY client_id",
      ).toArray() });
    }
    if (request.method === "GET" && url.pathname === "/client/policies") {
      return jsonResponse({ policies: this.security.policies() });
    }
    if (request.method === "GET" && url.pathname === "/client/policy") {
      const query = z.object({
        clientId: clientIdSchema, ensure: z.enum(["true", "false"]).optional(),
        permissionLevel: permissionSchema.optional(), advancedSecurity: z.enum(["true", "false"]).optional(),
        version: z.string().regex(/^\d+$/).transform(Number).pipe(versionSchema).optional(),
      }).strict().parse(this.uniqueQuery(url.searchParams));
      if (query.ensure === "true") {
        if (query.permissionLevel === undefined || query.advancedSecurity === undefined || query.version === undefined) throw new RequestBodyError("Missing initial policy");
        return jsonResponse(this.security.ensurePolicy(query.clientId, query.permissionLevel, query.advancedSecurity === "true", query.version));
      }
      return jsonResponse(this.security.policy(query.clientId));
    }
    if (request.method === "POST" && url.pathname === "/client/policy/update") {
      const body = policyUpdateSchema.parse(await readBoundedJson(request));
      if (body.sessionId !== undefined) this.security.dashboardSession(body.sessionId, body.csrf);
      return jsonResponse(this.security.updatePolicy(body.clientId, {
        ...(body.permissionLevel === undefined ? {} : { permissionLevel: body.permissionLevel }),
        ...(body.revoked === undefined ? {} : { revoked: body.revoked }),
      }, body.expected));
    }
    return new Response("Not found", { status: 404 });
  }
  private uniqueQuery(params: URLSearchParams): Record<string, string> {
    const query: Record<string, string> = {};
    for (const [key, value] of params) {
      if (Object.hasOwn(query, key)) throw new RequestBodyError("Duplicate query parameter");
      query[key] = value;
    }
    return query;
  }

  private identity(value: unknown): ClientIdentity {
    const parsed = z.object({ clientId: z.string().min(1), advancedSecurity: z.boolean(), securityPolicyVersion: z.number().int().nonnegative() }).safeParse(value);
    if (!parsed.success) throw new SecurityError();
    return parsed.data;
  }

  private proposalView(proposal: ProposalRow) {
    const activation: unknown = proposal.outcome_json ? JSON.parse(proposal.outcome_json) : null;
    let task: DelayedTradeRow | undefined;
    if (proposal.mode === "DELAYED" && proposal.status === "CONFIRMED" && activation && typeof activation === "object") {
      const result: unknown = Reflect.get(activation, "result");
      const taskId: unknown = result && typeof result === "object" ? Reflect.get(result, "taskId") : undefined;
      if (typeof taskId === "string") task = this.ctx.storage.sql.exec<DelayedTradeRow>("SELECT * FROM delayed_trade WHERE id = ?", taskId).toArray()[0];
    }
    return {
      proposalId: proposal.id, status: task?.status ?? (proposal.status === "PENDING" && proposal.expires_at <= Date.now() ? "EXPIRED" : proposal.status),
      approvalMethod: proposal.approval_method, intentDigest: proposal.intent_digest,
      expiresAt: new Date(proposal.expires_at).toISOString(),
      preview: { accountHash: proposal.account_hash, action: proposal.action, executionMode: proposal.mode,
        orderId: proposal.order_id, orderPayload: JSON.parse(proposal.order_json) as unknown,
        condition: proposal.condition_json ? JSON.parse(proposal.condition_json) as unknown : null,
        validUntil: proposal.valid_until === null ? null : new Date(proposal.valid_until).toISOString(),
        pollIntervalSeconds: proposal.poll_interval_seconds, replacesTaskId: proposal.replaces_task_id,
      },
      ...(task ? { taskId: task.id, taskVersion: task.version } : {}),
      outcome: task?.outcome_json ? JSON.parse(task.outcome_json) as unknown : activation,
    };
  }

  private approvalBinding(proposalId: string): ApprovalBinding {
    const proposal = this.proposal(proposalId);
    if (!proposal || proposal.approval_method !== "passkey" || !proposal.client_id) throw new SecurityError();
    return { proposalId, intentDigest: proposal.intent_digest, clientId: proposal.client_id, policyVersion: proposal.policy_version, expiresAt: proposal.expires_at };
  }

  private checkApproval(binding: ApprovalBinding): void {
    const current = this.proposal(binding.proposalId);
    if (!current || current.status !== "PENDING" || current.approval_method !== "passkey" || current.intent_digest !== binding.intentDigest || current.client_id !== binding.clientId || current.policy_version !== binding.policyVersion || current.expires_at !== binding.expiresAt || current.expires_at <= Date.now() || !tradingEnabled(this.env)) throw new SecurityError();
    const policy = this.security.policy(binding.clientId);
    // Editing a protected task requires Passkey approval even for ordinary clients.
    // The frozen proposal determines the approval method; live policy controls access.
    if (policy.revoked || policy.permissionLevel !== "full_access" || policy.version !== binding.policyVersion) throw new SecurityError("SECURITY_POLICY_CHANGED");
  }

  private async securityRequest(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST" || !isJsonContentType(request.headers.get("Content-Type"))) throw new SecurityError();
    const input = await readBoundedJson(request);
    const id = z.string().min(1).max(2048);
    const browser = { sessionId: id, csrf: id };
    if (path === "/security/policy") {
      const raw = z.object({ clientId: clientIdSchema }).strict().parse(input);
      return jsonResponse(this.security.policy(raw.clientId));
    }
    if (path === "/security/commit-policy") {
      const raw = z.object({ clientId: clientIdSchema, advancedSecurity: z.boolean(), expected: versionSchema, permissionLevel: permissionSchema, ticket: id.optional() }).strict().parse(input);
      if (raw.advancedSecurity && raw.permissionLevel !== "full_access") throw new SecurityError();
      if (raw.advancedSecurity || this.security.policy(raw.clientId).advancedSecurity) {
        if (!raw.ticket) throw new SecurityError();
        const proof = this.security.read<{ pending: PendingAuthorization; credentialVersion: number }>(raw.ticket, "commit", true);
        if (proof.credentialVersion !== this.security.version() || proof.pending.authRequest.clientId !== raw.clientId ||
          proof.pending.advancedSecurity !== raw.advancedSecurity || proof.pending.policyVersion !== raw.expected ||
          proof.pending.permissionLevel !== raw.permissionLevel) throw new SecurityError();
      }
      return jsonResponse(this.security.commitPolicy(raw.clientId, raw.advancedSecurity, raw.expected, raw.permissionLevel));
    }
    if (path === "/security/authorization") {
      const raw = z.object({ ticket: id }).strict().parse(input);
      const proof = this.security.read<{ pending: PendingAuthorization; credentialVersion: number }>(raw.ticket, "authorization", true);
      if (proof.credentialVersion !== this.security.version()) throw new SecurityError();
      return jsonResponse({ pending: proof.pending, ticket: this.security.save("commit", proof, Date.now() + 120_000) });
    }
    if (path === "/security/session/create") {
      const raw = z.object({ recovery: z.boolean().optional(), pending: pendingAuthorizationSchema.optional() }).strict().parse(input);
      if (raw.recovery && raw.pending) throw new SecurityError();
      if (raw.pending?.advancedSecurity && raw.pending.permissionLevel !== "full_access") throw new SecurityError();
      return jsonResponse(this.security.createSession(raw.recovery, raw.pending));
    }
    if (path === "/security/session" || path === "/security/dashboard-session") {
      const raw = z.object({ sessionId: id, csrf: id.optional() }).strict().parse(input);
      const session = path === "/security/dashboard-session" ? this.security.dashboardSession(raw.sessionId, raw.csrf) : this.security.session(raw.sessionId, raw.csrf);
      return jsonResponse({ session, credentials: this.security.credentials() });
    }
    if (path === "/security/dashboard-policy-options" || path === "/security/dashboard-policy-verify") {
      const envelope = z.object({ ...browser, input: dashboardPolicyInputSchema }).strict().parse(input);
      const raw = envelope.input;
      this.security.dashboardSession(envelope.sessionId, envelope.csrf);
      if (path.endsWith("-options")) {
        if (raw.challengeId || raw.response) throw new RequestBodyError("Unexpected proof");
        return jsonResponse(await this.security.dashboardPolicyOptions(envelope.sessionId, envelope.csrf, raw.clientId, raw.advancedSecurity));
      }
      if (!raw.challengeId || !raw.response) throw new RequestBodyError("Passkey proof required");
      const result = await this.security.verify(envelope.sessionId, envelope.csrf, raw.challengeId, raw.response, () => { throw new SecurityError(); }, raw);
      if (!result.policy) throw new SecurityError();
      return jsonResponse({ ok: true, policy: result.policy });
    }
    if (path === "/security/proposal") {
      const raw = z.object({ sessionId: id, csrf: id.optional(), proposalId: id }).strict().parse(input);
      const session = this.security.session(raw.sessionId, raw.csrf);
      if (session.recovery || session.pending) throw new SecurityError();
      const proposal = this.proposal(raw.proposalId);
      if (!proposal || proposal.approval_method !== "passkey") throw new SecurityError();
      return jsonResponse(this.proposalView(proposal));
    }
    if (path === "/security/options") {
      const raw = z.object({ ...browser, operation: z.enum(["register", "recover", "authorize", "add", "delete", "rename", "approve"]), target: id.optional(), name: z.string().min(1).max(80).optional(), resetConfirmation: z.string().optional(), proposalId: id.optional() }).strict().parse(input);
      const binding = raw.operation === "approve" ? this.approvalBinding(raw.proposalId ?? "") : undefined;
      if (binding) this.checkApproval(binding);
      return jsonResponse(await this.security.options(raw.sessionId, raw.csrf, raw.operation, raw.target, raw.name, binding, raw.resetConfirmation));
    }
    if (path === "/security/add-options") {
      const raw = z.object({ ...browser, ticket: id, name: z.string().min(1).max(80).optional() }).strict().parse(input);
      return jsonResponse(await this.security.addOptions(raw.sessionId, raw.csrf, raw.ticket, raw.name ?? "Passkey"));
    }
    if (path === "/security/add-verify") {
      const raw = z.object({ ...browser, challengeId: id, response: registrationResponseSchema }).strict().parse(input);
      await this.security.addVerify(raw.sessionId, raw.csrf, raw.challengeId, raw.response);
      return jsonResponse({ saved: true });
    }
    if (path === "/security/verify") {
      const raw = z.object({ ...browser, challengeId: id, response: credentialResponseSchema }).strict().parse(input);
      this.security.session(raw.sessionId, raw.csrf);
      const previous = this.ctx.storage.sql.exec<{ payload: string }>("SELECT payload FROM oauth_state WHERE state = ? AND kind = 'security_approval_attempt' AND expires_at > ?", raw.challengeId, Date.now()).toArray()[0];
      if (previous) {
        const attempt = JSON.parse(previous.payload) as { sessionId: string; proposalId: string };
        if (attempt.sessionId !== raw.sessionId) throw new SecurityError();
        const proposal = this.proposal(attempt.proposalId);
        if (!proposal) throw new SecurityError();
        return jsonResponse(this.proposalView(proposal));
      }
      const result = await this.security.verify(raw.sessionId, raw.csrf, raw.challengeId, raw.response, binding => { this.checkApproval(binding); });
      if (result.binding) {
        this.security.session(raw.sessionId, raw.csrf);
        const proposal = this.proposal(result.binding.proposalId);
        this.checkApproval(result.binding);
        if (!proposal) throw new SecurityError();
        const requestId = crypto.randomUUID();
        if (proposal.mode === "DELAYED") return this.activateDelayedTrade(proposal, requestId);
        const claimed = this.ctx.storage.sql.exec<{ id: string }>("UPDATE trade_proposal SET status = 'EXECUTING', updated_at = ? WHERE id = ? AND status = 'PENDING' RETURNING id", Date.now(), proposal.id).toArray()[0];
        if (!claimed) return jsonResponse(this.proposalView(this.proposal(proposal.id) ?? proposal));
        this.audit("passkey_trade_approved", proposal.id, requestId, "EXECUTING", proposal.intent_digest);
        const response = await this.executeMutation(proposal.action, proposal.account_hash, proposal.order_id, JSON.parse(proposal.order_json) as { [key: string]: JsonValue }, requestId, "passkey_approval",
          { clientId: result.binding.clientId, advancedSecurity: true, securityPolicyVersion: result.binding.policyVersion });
        const finished = await this.finishProposal(proposal, requestId, response);
        const outcome: Record<string, unknown> = await finished.json();
        return jsonResponse({ ...outcome, proposalId: proposal.id, status: this.proposal(proposal.id)?.status });
      }
      return jsonResponse(result);
    }
    throw new RequestBodyError("Unknown security operation");
  }
  private async recordToolAudit(request: Request): Promise<Response> {
    const raw = toolAuditInputSchema.parse(await readBoundedJson(request));
    const id = raw.id ?? crypto.randomUUID();
    const now = Date.now();
    if (raw.createdAt !== undefined && raw.createdAt > now + 60_000) throw new RequestBodyError("Invalid audit timestamp");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO tool_invocation_audit (id, client_id, tool_name, request_id, status, parameters_summary, error_code, error_message, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, raw.clientId, raw.toolName, raw.requestId, raw.status,
        raw.parametersSummary === undefined ? null : truncateUtf8(raw.parametersSummary, 512),
        raw.errorCode ?? null, raw.errorMessage === undefined ? null : truncateUtf8(raw.errorMessage, 1024),
        raw.durationMs, raw.createdAt ?? now,
      );
      this.pruneToolAudits();
    });
    return jsonResponse({ ok: true, id });
  }

  private pruneToolAudits(): void {
    this.ctx.storage.sql.exec("DELETE FROM tool_invocation_audit WHERE created_at <= ?", Date.now() - 30 * 24 * 60 * 60 * 1000);
    this.ctx.storage.sql.exec(`DELETE FROM tool_invocation_audit WHERE id IN (
      SELECT id FROM tool_invocation_audit ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET 5000
    )`);
  }

  private queryToolAudits(params: URLSearchParams): Response {
    const { clientId, toolName, status, limit, offset } = parseAuditQuery(params);
    this.pruneToolAudits();

    const conditions: string[] = [];
    const args: (string | number)[] = [];

    if (clientId) {
      conditions.push("client_id = ?");
      args.push(clientId);
    }
    if (toolName) {
      conditions.push("tool_name = ?");
      args.push(toolName);
    }
    if (status) {
      conditions.push("status = ?");
      args.push(status);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    interface AuditRow {
      [key: string]: string | number | null;
      id: string;
      client_id: string;
      tool_name: string;
      request_id: string;
      status: string;
      parameters_summary: string | null;
      error_code: string | null;
      error_message: string | null;
      duration_ms: number;
      created_at: number;
    }

    const items = this.ctx.storage.sql.exec<AuditRow>(
      `SELECT id, client_id, tool_name, request_id, status, parameters_summary, error_code, error_message, duration_ms, created_at
       FROM tool_invocation_audit
       ${whereClause}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
      ...args,
      limit,
      offset,
    ).toArray().map(row => ({
      id: row.id,
      clientId: row.client_id,
      toolName: row.tool_name,
      requestId: row.request_id,
      status: row.status,
      parametersSummary: row.parameters_summary,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));

    const stats = this.ctx.storage.sql.exec<{ total: number; success_count: number; error_count: number; active24h: number }>(
      `SELECT count(*) AS total,
        coalesce(sum(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END), 0) AS success_count,
        coalesce(sum(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END), 0) AS error_count,
        coalesce(sum(CASE WHEN created_at > ? THEN 1 ELSE 0 END), 0) AS active24h
       FROM tool_invocation_audit ${whereClause}`,
      Date.now() - 24 * 60 * 60 * 1000, ...args,
    ).one();

    return jsonResponse({
      items,
      total: stats.total,
      successCount: stats.success_count,
      errorCount: stats.error_count,
      active24h: stats.active24h,
      limit,
      offset,
    });
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
    if (!current) throw new Error("AUTH_REQUIRED");
    if (current.status !== "connected" || current.refreshExpiresAt <= Date.now()) {
      this.markReauthorizationRequired(current);
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
    let response: Response;
    try {
      response = await fetch("https://api.schwabapi.com/v1/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${this.env.SCHWAB_CLIENT_ID}:${this.env.SCHWAB_CLIENT_SECRET}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }),
      });
    } catch (error) {
      logEvent("schwab_token_refresh", {
        requestId,
        status: "network_error",
        durationMs: Date.now() - started,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error("UPSTREAM_UNAVAILABLE");
    }
    const body: unknown = await response.json().catch(() => null);
    logEvent("schwab_token_refresh", {
      requestId,
      status: response.status,
      durationMs: Date.now() - started,
    });
    if (!response.ok || !isTokenResponse(body)) {
      const reauthorizationRequired = isReauthorizationError(body);
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

  private audit(event: string, entityId: string | null, requestId: string, status: string, intentDigest?: string, instructionDigest?: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO trade_audit (id, event, entity_id, request_id, intent_digest, instruction_digest, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(),
      event,
      entityId,
      requestId,
      intentDigest ?? null,
      instructionDigest ?? null,
      status,
      Date.now(),
    );
  }

  private tradingDisabled(requestId: string): Response {
    return publicError({ code: "TRADE_STATE_CONFLICT", message: "Trading is disabled by deployment configuration", requestId }, 409);
  }

  private expireDirectTradingSessions(now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE direct_trading_session SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND (idle_expires_at <= ? OR absolute_expires_at <= ?)",
      now,
      now,
      now,
    );
  }

  private async enableSessionDirectTrading(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    if (!tradingEnabled(this.env)) return this.tradingDisabled(requestId);
    const parsed = toolSchemas.enableSessionDirectTrading.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid direct-trading session request", requestId }, 400);

    const now = Date.now();
    this.expireDirectTradingSessions(now);
    const sessionId = crypto.randomUUID();
    const sessionCapability = randomToken();
    const idleExpiresAt = now + DIRECT_TRADING_IDLE_TTL_MS;
    const absoluteExpiresAt = now + DIRECT_TRADING_MAX_TTL_MS;
    const instructionDigest = await sha256(parsed.data.userInstruction);
    const capabilityHash = await sha256(sessionCapability);
    this.security.assertIdentity(this.identity(field(raw as object, "identity")));
    this.ctx.storage.sql.exec(
      `INSERT INTO direct_trading_session
       (id, capability_hash, status, idle_expires_at, absolute_expires_at, created_at, last_used_at, updated_at)
       VALUES (?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
      sessionId,
      capabilityHash,
      idleExpiresAt,
      absoluteExpiresAt,
      now,
      now,
      now,
    );
    this.audit("direct_trading_session_enabled", sessionId, requestId, "ACTIVE", undefined, instructionDigest);
    return jsonResponse({
      result: {
        sessionCapability,
        status: "ACTIVE",
        scope: "IMMEDIATE_PLACE_ONLY",
        idleExpiresAt: new Date(idleExpiresAt).toISOString(),
        absoluteExpiresAt: new Date(absoluteExpiresAt).toISOString(),
        warning: "Keep sessionCapability inside this agent session. It authorizes immediate PLACE orders without per-order confirmation and is never stored in plaintext.",
      },
    });
  }

  private async disableSessionDirectTrading(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    const parsed = toolSchemas.disableSessionDirectTrading.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid direct-trading session request", requestId }, 400);
    const capabilityHash = await sha256(parsed.data.sessionCapability);
    this.security.assertIdentity(this.identity(field(raw as object, "identity")));
    const now = Date.now();
    this.expireDirectTradingSessions(now);
    const disabled = this.ctx.storage.sql.exec<{ id: string }>(
      "UPDATE direct_trading_session SET status = 'DISABLED', updated_at = ? WHERE capability_hash = ? AND status = 'ACTIVE' RETURNING id",
      now,
      capabilityHash,
    ).toArray()[0];
    if (!disabled) return publicError({ code: "DIRECT_TRADING_SESSION_INVALID", message: "Direct-trading session is invalid or inactive", requestId }, 403);
    this.audit("direct_trading_session_disabled", disabled.id, requestId, "DISABLED");
    return jsonResponse({ result: { status: "DISABLED" } });
  }

  private async claimDirectTradingSession(sessionCapability: string, requestId: string): Promise<DirectTradingSessionRow | Response> {
    const now = Date.now();
    this.expireDirectTradingSessions(now);
    const claimed = this.ctx.storage.sql.exec<DirectTradingSessionRow>(
      `UPDATE direct_trading_session
       SET last_used_at = ?, idle_expires_at = CASE WHEN ? < absolute_expires_at THEN ? ELSE absolute_expires_at END, updated_at = ?
       WHERE capability_hash = ? AND status = 'ACTIVE' AND idle_expires_at > ? AND absolute_expires_at > ?
       RETURNING id, idle_expires_at, absolute_expires_at`,
      now,
      now + DIRECT_TRADING_IDLE_TTL_MS,
      now + DIRECT_TRADING_IDLE_TTL_MS,
      now,
      await sha256(sessionCapability),
      now,
      now,
    ).toArray()[0];
    return claimed ?? publicError({ code: "DIRECT_TRADING_SESSION_INVALID", message: "Direct-trading session is invalid or inactive", requestId }, 403);
  }

  private async placeOrderDirect(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    if (!tradingEnabled(this.env)) return this.tradingDisabled(requestId);
    const parsed = toolSchemas.placeOrderDirect.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid direct order", requestId }, 400);
    try {
      assertSafeOrderPayload(parsed.data.orderPayload);
    } catch {
      return publicError({ code: "INVALID_ARGUMENT", message: "Unsafe order payload", requestId }, 400);
    }

    const session = await this.claimDirectTradingSession(parsed.data.sessionCapability, requestId);
    if (session instanceof Response) return session;
    const intent: { [key: string]: JsonValue } = {
      accountHash: parsed.data.accountHash,
      action: "PLACE",
      executionMode: "IMMEDIATE",
      orderPayload: parsed.data.orderPayload,
    };
    const intentDigest = await sha256(canonicalJson(intent));
    const instructionDigest = await sha256(parsed.data.userInstruction);
    const now = Date.now();
    this.security.assertIdentity(this.identity(field(raw as object, "identity")));
    const inserted = this.ctx.storage.sql.exec<{ id: string }>(
      `INSERT OR IGNORE INTO direct_trade_execution
       (id, session_id, intent_digest, instruction_digest, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'EXECUTING', ?, ?) RETURNING id`,
      parsed.data.executionKey,
      session.id,
      intentDigest,
      instructionDigest,
      now,
      now,
    ).toArray()[0];
    if (!inserted) {
      const existing = this.ctx.storage.sql.exec<DirectTradeExecutionRow>(
        "SELECT intent_digest, status, outcome_json, response_status FROM direct_trade_execution WHERE id = ? AND session_id = ?",
        parsed.data.executionKey,
        session.id,
      ).toArray()[0];
      if (!existing || existing.intent_digest !== intentDigest) {
        return publicError({ code: "TRADE_STATE_CONFLICT", message: "executionKey is already bound to another direct order", requestId }, 409);
      }
      if (existing.outcome_json !== null) return jsonResponse(JSON.parse(existing.outcome_json) as unknown, existing.response_status ?? 200);
      return publicError({ code: "EXECUTION_UNCERTAIN", message: "Direct order execution is already in progress or its outcome is unknown; verify order status before any new submission", requestId, attempts: 1 }, 502);
    }

    this.audit("direct_trade_execution_started", parsed.data.executionKey, requestId, "EXECUTING", intentDigest, instructionDigest);
    const response = await this.executeMutation("PLACE", parsed.data.accountHash, undefined, parsed.data.orderPayload, requestId, "place_order_direct", this.identity(field(raw as object, "identity")));
    const payload: unknown = await response.json();
    const error = payload !== null && typeof payload === "object" ? field(payload, "error") : undefined;
    const status = response.ok ? "EXECUTED" : error !== null && typeof error === "object" && field(error, "code") === "EXECUTION_UNCERTAIN" ? "EXECUTION_UNCERTAIN" : "FAILED";
    this.ctx.storage.sql.exec(
      "UPDATE direct_trade_execution SET status = ?, outcome_json = ?, response_status = ?, updated_at = ? WHERE id = ? AND status = 'EXECUTING'",
      status,
      JSON.stringify(payload),
      response.status,
      Date.now(),
      parsed.data.executionKey,
    );
    this.audit("direct_trade_execution_finished", parsed.data.executionKey, requestId, status, intentDigest);
    return jsonResponse(payload, response.status);
  }

  private async prepareTrade(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    if (!tradingEnabled(this.env)) return this.tradingDisabled(requestId);
    const parsed = toolSchemas.prepareTrade.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid trade proposal", requestId }, 400);
    const input = parsed.data;
    const identity = this.identity(field(raw as object, "identity"));
    let approvalMethod = identity.advancedSecurity ? "passkey" : "conversation";
    if (input.replacesTaskId) {
      const task = this.ctx.storage.sql.exec<{ approval_method: string }>("SELECT approval_method FROM delayed_trade WHERE id = ?", input.replacesTaskId).toArray()[0];
      if (task?.approval_method === "passkey") approvalMethod = "passkey";
    }
    try {
      assertSafeOrderPayload(input.orderPayload);
    } catch {
      return publicError({ code: "INVALID_ARGUMENT", message: "Unsafe order payload", requestId }, 400);
    }
    const now = Date.now();
    const validUntil = input.validUntil === undefined ? null : Date.parse(input.validUntil);
    if (validUntil !== null && (validUntil <= now || validUntil > now + 365 * 24 * 60 * 60 * 1000)) {
      return publicError({ code: "INVALID_ARGUMENT", message: "validUntil must be in the next 365 days", requestId }, 400);
    }
    if (input.condition !== undefined && collectQuoteSymbols(input.condition).size > 50) {
      return publicError({ code: "INVALID_ARGUMENT", message: "A delayed condition can reference at most 50 symbols", requestId }, 400);
    }
    if (input.replacesTaskId !== undefined) {
      const existing = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM delayed_trade WHERE id = ?", input.replacesTaskId).toArray()[0];
      if (!existing) return publicError({ code: "TRADE_NOT_FOUND", message: "Delayed trade was not found", requestId }, 404);
      if (existing.status !== "ACTIVE") return publicError({ code: "TRADE_STATE_CONFLICT", message: "Only an active delayed trade can be modified", requestId }, 409);
    }
    const proposalId = crypto.randomUUID();
    const token = randomToken();
    const intent: { [key: string]: JsonValue } = {
      accountHash: input.accountHash,
      action: input.action,
      executionMode: input.executionMode,
      orderPayload: input.orderPayload,
      ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
      ...(input.condition === undefined ? {} : { condition: input.condition }),
      ...(input.validUntil === undefined ? {} : { validUntil: input.validUntil }),
      ...(input.pollIntervalSeconds === undefined ? {} : { pollIntervalSeconds: input.pollIntervalSeconds }),
      ...(input.replacesTaskId === undefined ? {} : { replacesTaskId: input.replacesTaskId }),
    };
    const intentDigest = await sha256(canonicalJson(intent));
    const instructionDigest = await sha256(input.userInstruction);
    const tokenHash = await sha256(token);
    const confirmationText = `确认交易 ${proposalId.slice(0, 8)} ${intentDigest.slice(0, 12)}`;
    const expiresAt = now + CONFIRMATION_TTL_MS;
    this.security.assertIdentity(identity);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO trade_proposal
         (id, mode, action, account_hash, order_id, order_json, condition_json, valid_until,
          poll_interval_seconds, replaces_task_id, intent_digest, instruction_digest, token_hash,
          confirmation_text, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        proposalId,
        input.executionMode,
        input.action,
        input.accountHash,
        input.orderId ?? null,
        JSON.stringify(input.orderPayload),
        input.condition === undefined ? null : JSON.stringify(input.condition),
        validUntil,
        input.pollIntervalSeconds ?? null,
        input.replacesTaskId ?? null,
        intentDigest,
        instructionDigest,
        tokenHash,
        confirmationText,
        expiresAt,
        now,
        now,
      );
      this.ctx.storage.sql.exec("UPDATE trade_proposal SET approval_method = ?, client_id = ?, policy_version = ? WHERE id = ?", approvalMethod, identity.clientId, identity.securityPolicyVersion, proposalId);
    });
    this.audit("trade_proposal_created", proposalId, requestId, "PENDING", intentDigest, instructionDigest);
    return jsonResponse({
      result: {
        proposalId,
        ...(approvalMethod === "passkey" ? {
          approvalMethod: "passkey", approvalUrl: `${new URL(this.env.SCHWAB_REDIRECT_URI).origin}/security/approvals/${proposalId}`,
        } : { confirmationToken: token, confirmationText }),
        expiresAt: new Date(expiresAt).toISOString(),
        intentDigest,
        preview: intent,
        warning: approvalMethod === "passkey" ? "Open approvalUrl in a browser and approve using a Passkey. No conversational fallback is available." : "Only call confirm_trade after the user explicitly repeats confirmationText; AI must never propose or initiate a trade.",
      },
    });
  }

  private proposal(id: string): ProposalRow | undefined {
    return this.ctx.storage.sql.exec<ProposalRow>("SELECT * FROM trade_proposal WHERE id = ?", id).toArray()[0];
  }

  private async confirmTrade(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    if (!tradingEnabled(this.env)) return this.tradingDisabled(requestId);
    const parsed = toolSchemas.confirmTrade.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid trade confirmation", requestId }, 400);
    const current = this.proposal(parsed.data.proposalId);
    if (!current) return publicError({ code: "TRADE_NOT_FOUND", message: "Trade proposal was not found", requestId }, 404);
    const identity = this.identity(field(raw as object, "identity"));
    if (current.approval_method === "passkey" || (current.client_id !== null && current.client_id !== identity.clientId)) return publicError({ code: "SECURITY_VERIFICATION_FAILED", message: "This proposal requires its original approval method and client", requestId }, 403);
    if (current.status !== "PENDING") return publicError({ code: "TRADE_STATE_CONFLICT", message: "Trade proposal is no longer pending", requestId }, 409);
    if (current.expires_at <= Date.now()) {
      this.ctx.storage.sql.exec("UPDATE trade_proposal SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'PENDING'", Date.now(), current.id);
      return publicError({ code: "CONFIRMATION_EXPIRED", message: "Trade confirmation expired", requestId }, 410);
    }
    if (parsed.data.confirmationText !== current.confirmation_text || !(await tokenMatches(parsed.data.confirmationToken, current.token_hash))) {
      this.audit("trade_confirmation_rejected", current.id, requestId, "INVALID", current.intent_digest);
      return publicError({ code: "CONFIRMATION_INVALID", message: "Trade confirmation did not match the frozen proposal", requestId }, 403);
    }

    try { this.security.assertIdentity(identity); } catch { return publicError({ code: "SECURITY_POLICY_CHANGED", message: "Client policy changed", requestId }, 403); }
    if (current.policy_version !== identity.securityPolicyVersion || current.expires_at <= Date.now() || !tradingEnabled(this.env)) return publicError({ code: "CONFIRMATION_EXPIRED", message: "Trade approval expired or policy changed", requestId }, 403);
    if (current.mode === "DELAYED") return this.activateDelayedTrade(current, requestId);
    const claimed = this.ctx.storage.sql.exec<{ id: string }>(
      "UPDATE trade_proposal SET status = 'EXECUTING', updated_at = ? WHERE id = ? AND status = 'PENDING' RETURNING id",
      Date.now(),
      current.id,
    ).toArray()[0];
    if (!claimed) return publicError({ code: "TRADE_STATE_CONFLICT", message: "Trade proposal was already consumed", requestId }, 409);
    this.audit("trade_execution_started", current.id, requestId, "EXECUTING", current.intent_digest);
    const response = await this.executeMutation(current.action, current.account_hash, current.order_id, JSON.parse(current.order_json) as { [key: string]: JsonValue }, requestId, "confirm_trade", identity);
    return this.finishProposal(current, requestId, response);
  }

  private async activateDelayedTrade(proposal: ProposalRow, requestId: string): Promise<Response> {
    if (proposal.condition_json === null || proposal.valid_until === null) {
      return publicError({ code: "TRADE_STATE_CONFLICT", message: "Delayed proposal is incomplete", requestId }, 409);
    }
    if (!tradingEnabled(this.env) || proposal.expires_at <= Date.now() || proposal.valid_until <= Date.now()) return publicError({ code: "CONFIRMATION_EXPIRED", message: "Delayed proposal has expired or trading is disabled", requestId }, 403);
    const validUntil = proposal.valid_until;
    const activation = this.ctx.storage.transactionSync(() => {
      let version = 1;
      if (proposal.replaces_task_id !== null) {
        const previous = this.ctx.storage.sql.exec<{ version: number; status: string; approval_method: string }>("SELECT version, status, approval_method FROM delayed_trade WHERE id = ?", proposal.replaces_task_id).toArray()[0];
        if (!previous) return publicError({ code: "TRADE_NOT_FOUND", message: "Delayed trade was not found", requestId }, 404);
        if (previous.status !== "ACTIVE") return publicError({ code: "TRADE_STATE_CONFLICT", message: "Delayed trade is no longer active", requestId }, 409);
        if (previous.approval_method === "passkey" && proposal.approval_method !== "passkey") throw new SecurityError();
        version = previous.version + 1;
      }
      const claimed = this.ctx.storage.sql.exec<{ id: string }>(
        "UPDATE trade_proposal SET status = 'CONFIRMED', updated_at = ? WHERE id = ? AND status = 'PENDING' RETURNING id",
        Date.now(),
        proposal.id,
      ).toArray()[0];
      if (!claimed) return publicError({ code: "TRADE_STATE_CONFLICT", message: "Trade proposal was already consumed", requestId }, 409);
      const now = Date.now();
      const taskId = crypto.randomUUID();
      if (proposal.replaces_task_id !== null) {
        this.ctx.storage.sql.exec("UPDATE delayed_trade SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'", now, proposal.replaces_task_id);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO delayed_trade
         (id, version, action, account_hash, order_id, order_json, condition_json, valid_until,
          poll_interval_seconds, intent_digest, instruction_digest, status, next_check_at, created_at, updated_at)
         SELECT ?, ?, action, account_hash, order_id, order_json, condition_json, valid_until,
          COALESCE(poll_interval_seconds, 60), intent_digest, instruction_digest, 'ACTIVE', ?, ?, ?
         FROM trade_proposal WHERE id = ?`,
        taskId,
        version,
        now,
        now,
        now,
        proposal.id,
      );
      this.ctx.storage.sql.exec("UPDATE delayed_trade SET approval_method = ?, client_id = ?, policy_version = ? WHERE id = ?", proposal.approval_method, proposal.client_id, proposal.policy_version, taskId);
      const result = { taskId, version, status: "ACTIVE", validUntil: new Date(validUntil).toISOString(), intentDigest: proposal.intent_digest };
      this.ctx.storage.sql.exec("UPDATE trade_proposal SET outcome_json = ? WHERE id = ?", JSON.stringify({ result }), proposal.id);
      return { taskId, version, result };
    });
    if (activation instanceof Response) return activation;
    const { taskId, result } = activation;
    this.audit("delayed_trade_activated", taskId, requestId, "ACTIVE", proposal.intent_digest);
    await this.scheduleNextAlarm();
    return jsonResponse({ result });
  }

  private async finishProposal(proposal: ProposalRow, requestId: string, response: Response): Promise<Response> {
    const payload: unknown = await response.json();
    const error = payload !== null && typeof payload === "object" ? field(payload, "error") : undefined;
    const errorCode = error !== null && typeof error === "object" ? field(error, "code") : undefined;
    const status = response.ok ? "EXECUTED" : errorCode === "EXECUTION_UNCERTAIN" ? "EXECUTION_UNCERTAIN" : "FAILED";
    this.ctx.storage.sql.exec("UPDATE trade_proposal SET status = ?, outcome_json = ?, updated_at = ? WHERE id = ?", status, JSON.stringify(payload), Date.now(), proposal.id);
    this.audit("trade_execution_finished", proposal.id, requestId, status, proposal.intent_digest);
    return jsonResponse(payload, response.status);
  }

  private async cancelOrder(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    const parsed = toolSchemas.cancelOrder.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid cancellation request", requestId }, 400);
    const instructionDigest = await sha256(parsed.data.userInstruction);
    const identity = this.identity(field(raw as object, "identity"));
    this.security.assertIdentity(identity);
    this.audit("order_cancellation_started", String(parsed.data.orderId), requestId, "EXECUTING", undefined, instructionDigest);
    const response = await this.executeMutation("CANCEL", parsed.data.accountHash, parsed.data.orderId, undefined, requestId, "cancel_order", identity);
    const payload: unknown = await response.json();
    const error = payload !== null && typeof payload === "object" ? field(payload, "error") : undefined;
    const status = response.ok ? "EXECUTED" : error !== null && typeof error === "object" && field(error, "code") === "EXECUTION_UNCERTAIN" ? "EXECUTION_UNCERTAIN" : "FAILED";
    this.audit("order_cancellation_finished", String(parsed.data.orderId), requestId, status, undefined, instructionDigest);
    return jsonResponse(payload, response.status);
  }

  private async cancelDelayedTrade(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    const parsed = toolSchemas.cancelDelayedTrade.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid delayed-trade cancellation", requestId }, 400);
    const instructionDigest = await sha256(parsed.data.userInstruction);
    this.security.assertIdentity(this.identity(field(raw as object, "identity")));
    const cancelled = this.ctx.storage.sql.exec<{ id: string }>(
      "UPDATE delayed_trade SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'ACTIVE' RETURNING id",
      Date.now(),
      parsed.data.taskId,
    ).toArray()[0];
    if (!cancelled) {
      const exists = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM delayed_trade WHERE id = ?", parsed.data.taskId).toArray()[0];
      return exists
        ? publicError({ code: "TRADE_STATE_CONFLICT", message: "Only an active delayed trade can be cancelled", requestId }, 409)
        : publicError({ code: "TRADE_NOT_FOUND", message: "Delayed trade was not found", requestId }, 404);
    }
    this.audit("delayed_trade_cancelled", parsed.data.taskId, requestId, "CANCELLED", undefined, instructionDigest);
    await this.scheduleNextAlarm();
    return jsonResponse({ result: { taskId: parsed.data.taskId, status: "CANCELLED" } });
  }

  private async listDelayedTrades(request: Request): Promise<Response> {
    const raw: unknown = await request.json().catch(() => null);
    const requestId = raw !== null && typeof raw === "object" && typeof field(raw, "requestId") === "string" ? field(raw, "requestId") as string : crypto.randomUUID();
    const parsed = toolSchemas.listDelayedTrades.safeParse(raw !== null && typeof raw === "object" ? field(raw, "input") : undefined);
    if (!parsed.success) return publicError({ code: "INVALID_ARGUMENT", message: "Invalid delayed-trade query", requestId }, 400);
    this.security.assertIdentity(this.identity(field(raw as object, "identity")));
    const rows = parsed.data.status === undefined
      ? this.ctx.storage.sql.exec<DelayedTradeRow>("SELECT * FROM delayed_trade ORDER BY updated_at DESC LIMIT 100").toArray()
      : this.ctx.storage.sql.exec<DelayedTradeRow>("SELECT * FROM delayed_trade WHERE status = ? ORDER BY updated_at DESC LIMIT 100", parsed.data.status).toArray();
    return jsonResponse({
      result: rows.map((row) => ({
        taskId: row.id,
        approvalMethod: row.approval_method,
        clientId: row.client_id,
        securityPolicyVersion: row.policy_version,
        version: row.version,
        action: row.action,
        accountHash: row.account_hash,
        ...(row.order_id === null ? {} : { orderId: row.order_id }),
        orderPayload: JSON.parse(row.order_json) as unknown,
        condition: JSON.parse(row.condition_json) as unknown,
        validUntil: new Date(row.valid_until).toISOString(),
        pollIntervalSeconds: row.poll_interval_seconds,
        intentDigest: row.intent_digest,
        status: row.status,
        nextCheckAt: new Date(row.next_check_at).toISOString(),
        ...(row.outcome_json === null ? {} : { outcome: JSON.parse(row.outcome_json) as unknown }),
      })),
    });
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE delayed_trade SET status = 'EXECUTION_UNCERTAIN', updated_at = ? WHERE status = 'EXECUTING' AND updated_at < ?",
      now,
      now - 5 * 60 * 1000,
    );
    this.ctx.storage.sql.exec("UPDATE delayed_trade SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND valid_until <= ?", now, now);
    if (!tradingEnabled(this.env)) {
      const active = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM delayed_trade WHERE status = 'ACTIVE'").one().count;
      if (active > 0) await this.ctx.storage.setAlarm(now + DISABLED_ALARM_RECHECK_MS);
      return;
    }
    const due = this.ctx.storage.sql.exec<DelayedTradeRow>(
      "SELECT * FROM delayed_trade WHERE status = 'ACTIVE' AND next_check_at <= ? AND valid_until > ? ORDER BY next_check_at LIMIT 10",
      now,
      now,
    ).toArray();
    for (const task of due) await this.processDelayedTrade(task);
    await this.scheduleNextAlarm();
  }

  private async processDelayedTrade(task: DelayedTradeRow): Promise<void> {
    const requestId = crypto.randomUUID();
    let condition: TradeCondition;
    try {
      const parsed = tradeConditionSchema.safeParse(JSON.parse(task.condition_json) as unknown);
      if (!parsed.success) throw new Error("Invalid condition");
      condition = parsed.data;
    } catch {
      this.ctx.storage.sql.exec("UPDATE delayed_trade SET status = 'FAILED', outcome_json = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'", JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "Stored condition is invalid", requestId } }), Date.now(), task.id);
      return;
    }
    const symbols = [...collectQuoteSymbols(condition)];
    const quotes: Record<string, Record<string, number>> = {};
    if (symbols.length > 0) {
      const quoteResponse = await this.requestSchwab({ base: "market", path: "/quotes", query: { symbols: symbols.join(","), fields: "quote" }, requestId, tool: "delayed_trade_condition" });
      const payload: unknown = await quoteResponse.json();
      if (!quoteResponse.ok) {
        this.ctx.storage.sql.exec("UPDATE delayed_trade SET next_check_at = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE'", Date.now() + task.poll_interval_seconds * 1000, JSON.stringify(payload), Date.now(), task.id);
        return;
      }
      const result = payload !== null && typeof payload === "object" ? field(payload, "result") : undefined;
      if (result === null || typeof result !== "object") {
        this.failDelayedCondition(task, requestId, "Schwab returned an invalid quote response");
        return;
      }
      for (const symbol of symbols) {
        const entry = field(result, symbol) ?? field(result, symbol.toUpperCase());
        const quote = entry !== null && typeof entry === "object" ? field(entry, "quote") : undefined;
        if (quote !== null && typeof quote === "object") {
          const numeric: Record<string, number> = {};
          for (const key of ["askPrice", "bidPrice", "lastPrice", "mark", "netPercentChangeInDouble", "totalVolume"] as const) {
            const value = field(quote, key);
            if (typeof value === "number" && Number.isFinite(value)) numeric[key] = value;
          }
          quotes[symbol.toUpperCase()] = numeric;
        }
      }
    }
    let matched: boolean;
    try {
      matched = evaluateCondition(condition, quotes, Date.now());
    } catch {
      this.failDelayedCondition(task, requestId, "Schwab quote response is missing a required numeric field");
      return;
    }
    if (!matched) {
      this.ctx.storage.sql.exec("UPDATE delayed_trade SET next_check_at = ?, outcome_json = NULL, updated_at = ? WHERE id = ? AND status = 'ACTIVE'", Math.min(Date.now() + task.poll_interval_seconds * 1000, task.valid_until), Date.now(), task.id);
      return;
    }
    if (!tradingEnabled(this.env)) return;
    const executionNow = Date.now();
    const claimed = this.ctx.storage.sql.exec<{ id: string }>(
      "UPDATE delayed_trade SET status = 'EXECUTING', execution_request_id = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND valid_until > ? RETURNING id",
      requestId,
      executionNow,
      task.id,
      executionNow,
    ).toArray()[0];
    if (!claimed) {
      this.ctx.storage.sql.exec("UPDATE delayed_trade SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'ACTIVE' AND valid_until <= ?", executionNow, task.id, executionNow);
      return;
    }
    this.audit("delayed_trade_execution_started", task.id, requestId, "EXECUTING", task.intent_digest);
    const response = await this.executeMutation(task.action, task.account_hash, task.order_id, JSON.parse(task.order_json) as { [key: string]: JsonValue }, requestId, "delayed_trade_execute");
    const payload: unknown = await response.json();
    const error = payload !== null && typeof payload === "object" ? field(payload, "error") : undefined;
    const errorCode = error !== null && typeof error === "object" ? field(error, "code") : undefined;
    const status = response.ok ? "EXECUTED" : errorCode === "EXECUTION_UNCERTAIN" ? "EXECUTION_UNCERTAIN" : "FAILED";
    this.ctx.storage.sql.exec("UPDATE delayed_trade SET status = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND status = 'EXECUTING'", status, JSON.stringify(payload), Date.now(), task.id);
    this.audit("delayed_trade_execution_finished", task.id, requestId, status, task.intent_digest);
  }

  private failDelayedCondition(task: DelayedTradeRow, requestId: string, message: string): void {
    const now = Date.now();
    const outcome = { error: { code: "UPSTREAM_UNAVAILABLE", message, requestId } };
    const failed = this.ctx.storage.sql.exec<{ id: string }>(
      "UPDATE delayed_trade SET status = 'FAILED', outcome_json = ?, updated_at = ? WHERE id = ? AND status = 'ACTIVE' RETURNING id",
      JSON.stringify(outcome),
      now,
      task.id,
    ).toArray()[0];
    logEvent("schwab_response_invalid", { requestId, tool: "delayed_trade_condition" });
    if (failed) this.audit("delayed_trade_condition_failed", task.id, requestId, "FAILED", task.intent_digest);
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ next_check_at: number | null }>("SELECT MIN(next_check_at) AS next_check_at FROM delayed_trade WHERE status = 'ACTIVE'").one().next_check_at;
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(tradingEnabled(this.env) ? Math.max(Date.now() + 1000, next) : Date.now() + DISABLED_ALARM_RECHECK_MS);
  }

  private executeMutation(
    action: "PLACE" | "REPLACE" | "CANCEL",
    accountHash: string,
    orderId: number | null | undefined,
    orderPayload: { [key: string]: JsonValue } | undefined,
    requestId: string,
    tool: string,
    identity?: ClientIdentity,
  ): Promise<Response> {
    const accountPath = `/accounts/${encodeURIComponent(accountHash)}/orders`;
    if (action === "PLACE") return this.requestSchwab({ base: "trader", path: accountPath, requestId, tool }, "POST", orderPayload, identity);
    const orderPath = `${accountPath}/${String(orderId)}`;
    return this.requestSchwab({ base: "trader", path: orderPath, requestId, tool }, action === "REPLACE" ? "PUT" : "DELETE", orderPayload, identity);
  }

  private async proxySchwab(request: Request): Promise<Response> {
    const input: unknown = await request.json();
    if (!isVaultRequest(input)) {
      return publicError({ code: "INVALID_ARGUMENT", message: "Invalid Schwab request", requestId: crypto.randomUUID() }, 400);
    }
    return this.requestSchwab(input);
  }

  private async requestSchwab(
    input: VaultRequest,
    method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
    body?: { [key: string]: JsonValue },
    identity?: ClientIdentity,
  ): Promise<Response> {
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
        const errorCode = error instanceof Error && (error.message === "AUTH_REQUIRED" || error.message === "REAUTHORIZATION_REQUIRED") ? error.message : undefined;
        return publicError(
          {
            code: errorCode ?? "UPSTREAM_UNAVAILABLE",
            message: errorCode === "AUTH_REQUIRED" ? "Schwab authorization is required" : errorCode === "REAUTHORIZATION_REQUIRED" ? "Schwab authorization must be renewed" : "Unable to refresh Schwab authorization",
            requestId: input.requestId,
            attempts,
          },
          errorCode ? 401 : 502,
        );
      }
      // Refresh and upstream retries yield to concurrent dashboard changes.
      // Recheck immediately before every mutation, without another await.
      if (identity) {
        try { this.security.assertIdentity(identity); }
        catch { return publicError({ code: "SECURITY_POLICY_CHANGED", message: "Client policy changed before execution", requestId: input.requestId }, 403); }
      }

      const started = Date.now();
      let upstream: Response;
      try {
        upstream = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token.accessToken}`,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        logEvent("schwab_api_request", {
          requestId: input.requestId,
          tool: input.tool,
          method,
          status: "network_error",
          attempts,
          durationMs: Date.now() - started,
        });
        return method === "GET"
          ? publicError({ code: "UPSTREAM_UNAVAILABLE", message: "Schwab API is unavailable", requestId: input.requestId, attempts }, 502)
          : publicError({ code: "EXECUTION_UNCERTAIN", message: "Schwab mutation outcome is unknown; inspect the order before retrying", requestId: input.requestId, attempts }, 502);
      }
      logEvent("schwab_api_request", {
        requestId: input.requestId,
        tool: input.tool,
        method,
        status: upstream.status,
        attempts,
        durationMs: Date.now() - started,
      });
      if (upstream.ok) {
        if (method !== "GET") {
          const location = upstream.headers.get("Location");
          const orderId = location?.match(/\/orders\/(\d+)(?:$|\?)/u)?.[1];
          return jsonResponse({
            result: {
              status: "accepted",
              httpStatus: upstream.status,
              ...(orderId === undefined ? {} : { orderId: Number(orderId) }),
            },
            attempts,
            refreshExpiresAt: token.refreshExpiresAt,
          });
        }
        let result: unknown;
        try {
          result = await upstream.json();
        } catch (error) {
          logEvent("schwab_response_invalid", { requestId: input.requestId, tool: input.tool, message: error instanceof Error ? error.message : "Invalid JSON" });
          return publicError({ code: "UPSTREAM_UNAVAILABLE", message: "Schwab returned an invalid response", requestId: input.requestId, attempts }, 502);
        }
        return jsonResponse({ result, attempts, refreshExpiresAt: token.refreshExpiresAt });
      }
      if (upstream.status === 401 && attempts === 1) {
        failedAccessToken = token.accessToken;
        forceRefresh = true;
        continue;
      }
      const retryAfterMs = retryAfterDelay(upstream.headers.get("Retry-After"));
      if (method === "GET" && (upstream.status === 429 || upstream.status >= 500) && attempts === 1 && retryAfterMs <= MAX_INLINE_RETRY_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        continue;
      }
      const code = upstream.status === 429 ? "RATE_LIMITED" : upstream.status >= 500 ? method === "GET" ? "UPSTREAM_UNAVAILABLE" : "EXECUTION_UNCERTAIN" : "SCHWAB_REJECTED";
      return publicError(
        {
          code,
          message: code === "EXECUTION_UNCERTAIN" ? "Schwab mutation outcome is unknown; inspect the order before retrying" : `Schwab API returned HTTP ${String(upstream.status)}`,
          requestId: input.requestId,
          attempts,
          ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
        },
        upstream.status === 429 ? 429 : upstream.status >= 500 ? 502 : 400,
      );
    }
    return publicError(
      {
        code: method === "GET" ? "UPSTREAM_UNAVAILABLE" : "EXECUTION_UNCERTAIN",
        message: method === "GET" ? "Schwab API request failed" : "Schwab mutation outcome is unknown; inspect the order before retrying",
        requestId: input.requestId,
        attempts,
      },
      502,
    );
  }
}
