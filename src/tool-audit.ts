import { McpServer } from "@modelcontextprotocol/server";
import type { JSONRPCMessage, RequestId, Transport, TransportSendOptions } from "@modelcontextprotocol/server";
import type { AppEnv } from "./env";
import { vaultStub } from "./env";
import type { ClientIdentity } from "./security-store";
import type { ErrorCode } from "./types";
import { logEvent } from "./log";
const TOOL_NAMES: Readonly<Record<string, true>> = {
  schwab_connection_status: true, get_trading_diagnostics: true, get_quotes: true, get_price_history: true,
  get_option_chain: true, get_option_expiration_chain: true, get_market_hours: true, get_movers: true,
  search_instruments: true, list_accounts: true, get_account: true, get_orders: true, get_order: true,
  get_transactions: true, get_user_preferences: true, enable_trading: true, get_trade_proposal: true,
  prepare_trade: true, prepare_trade_batch: true, confirm_trade: true, enable_session_direct_trading: true, disable_session_direct_trading: true,
  place_order_direct: true, cancel_order: true, list_delayed_trades: true, cancel_delayed_trade: true,
};
const PUBLIC_ERROR_CODES: Readonly<Record<ErrorCode, true>> = {
  ACCOUNT_ACCESS_DENIED: true,
  SECURITY_VERIFICATION_FAILED: true, SECURITY_POLICY_CHANGED: true, BROWSER_AUTH_REQUIRED: true,
  AUTH_REQUIRED: true, REAUTHORIZATION_REQUIRED: true, INVALID_ARGUMENT: true, RATE_LIMITED: true,
  SCHWAB_REJECTED: true, UPSTREAM_UNAVAILABLE: true, CONFIRMATION_INVALID: true,
  CONFIRMATION_EXPIRED: true, TRADE_NOT_FOUND: true, TRADE_STATE_CONFLICT: true,
  DIRECT_TRADING_SESSION_INVALID: true, EXECUTION_UNCERTAIN: true,
};

type AuditLifetime = Pick<ExecutionContext, "waitUntil">;

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

// Never serialize caller-provided strings, nested objects, account/order IDs,
// instructions, confirmation material or passkey/session data, even on invalid
// calls. Each tool opts into only bounded counts, booleans and closed enums.
export function summarizeParams(tool: string, args: unknown): string {
  const summary: Record<string, number | boolean | string> = {};
  const count = (key: string, maximum: number) => {
    const value = field(args, key);
    if (Array.isArray(value)) summary[`${key}Count`] = Math.min(value.length, maximum);
  };
  const flag = (key: string) => {
    const value = field(args, key);
    if (typeof value === "boolean") summary[key] = value;
  };
  const integer = (key: string, maximum: number) => {
    const value = field(args, key);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum) summary[key] = value;
  };
  const enumeration = (key: string, allowed: readonly string[]) => {
    const value = field(args, key);
    if (typeof value === "string" && allowed.includes(value)) summary[key] = value;
  };
  switch (tool) {
    case "get_quotes":
      count("symbols", 50);
      flag("indicative");
      break;
    case "get_price_history":
      enumeration("periodType", ["day", "month", "year", "ytd"]);
      enumeration("frequencyType", ["minute", "daily", "weekly", "monthly"]);
      integer("period", 1000);
      integer("frequency", 1000);
      flag("needExtendedHoursData");
      flag("needPreviousClose");
      break;
    case "get_option_chain":
      enumeration("contractType", ["CALL", "PUT", "ALL"]);
      enumeration("strategy", ["SINGLE", "ANALYTICAL", "COVERED", "VERTICAL", "CALENDAR", "STRANGLE", "STRADDLE", "BUTTERFLY", "CONDOR", "DIAGONAL", "COLLAR", "ROLL"]);
      enumeration("optionType", ["S", "NS", "ALL"]);
      integer("strikeCount", 100);
      flag("includeUnderlyingQuote");
      break;
    case "get_market_hours":
      count("markets", 5);
      break;
    case "get_movers":
      enumeration("index", ["$DJI", "$COMPX", "$SPX", "NYSE", "NASDAQ", "OTCBB", "INDEX_ALL", "EQUITY_ALL", "OPTION_ALL", "OPTION_PUT", "OPTION_CALL"]);
      enumeration("sort", ["VOLUME", "TRADES", "PERCENT_CHANGE_UP", "PERCENT_CHANGE_DOWN"]);
      integer("frequency", 60);
      break;
    case "search_instruments":
      enumeration("projection", ["symbol-search", "symbol-regex", "desc-search", "desc-regex", "search", "fundamental"]);
      break;
    case "get_account":
      flag("includePositions");
      break;
    case "get_orders":
      integer("maxResults", 3000);
      break;
    case "prepare_trade":
      enumeration("action", ["PLACE", "REPLACE"]);
      enumeration("executionMode", ["IMMEDIATE", "DELAYED"]);
      break;
    case "list_delayed_trades":
      enumeration("status", ["ACTIVE", "EXECUTING", "EXECUTED", "FAILED", "EXECUTION_UNCERTAIN", "CANCELLED", "EXPIRED"]);
      break;
  }
  const encoded = JSON.stringify(summary);
  return new TextEncoder().encode(encoded).byteLength <= 512 ? encoded : "{}";
}

interface PendingCall {
  toolName: string;
  requestId: string;
  parametersSummary: string;
  startedAt: number;
  createdAt: number;
}

function resultRequestId(result: unknown): string | undefined {
  const structured = field(result, "structuredContent");
  const requestId = field(field(structured, "error"), "requestId") ?? field(field(structured, "meta"), "requestId");
  return typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : undefined;
}

function resultErrorCode(result: unknown): string | undefined {
  const error = field(field(result, "structuredContent"), "error");
  if (field(result, "isError") !== true && error === undefined) return undefined;
  const code = field(error, "code");
  if (typeof code === "string" && Object.hasOwn(PUBLIC_ERROR_CODES, code)) return code;
  const content = field(result, "content");
  if (Array.isArray(content) && content.some(item => {
    const text = field(item, "text");
    return typeof text === "string" && text.startsWith("Input validation error:");
  })) return "INVALID_ARGUMENT";
  return "TOOL_ERROR";
}

// The public Transport seam observes the SDK's own validation and error results,
// rather than bypassing schemas or wrapping only successfully parsed handlers.
class ToolAuditTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private readonly pending = new Map<RequestId, PendingCall>();
  private closingAudits: Promise<void> = Promise.resolve();

  constructor(
    private readonly transport: Transport,
    private readonly env: AppEnv,
    private readonly identity: ClientIdentity,
    private readonly lifetime: AuditLifetime | undefined,
  ) {}

  get sessionId(): string | undefined { return this.transport.sessionId; }
  get hasPerRequestStream(): boolean { return this.transport.hasPerRequestStream === true; }
  setProtocolVersion(version: string): void { this.transport.setProtocolVersion?.(version); }
  setSupportedProtocolVersions(versions: string[]): void { this.transport.setSupportedProtocolVersions?.(versions); }

  start(): Promise<void> {
    this.transport.onmessage = (message, extra) => {
      if ("method" in message && message.method === "tools/call" && "id" in message) {
        const name = field(message.params, "name");
        const toolName = typeof name === "string" && Object.hasOwn(TOOL_NAMES, name) ? name : "unknown_tool";
        this.pending.set(message.id, {
          toolName,
          requestId: crypto.randomUUID(),
          parametersSummary: summarizeParams(toolName, field(message.params, "arguments")),
          startedAt: performance.now(),
          createdAt: Date.now(),
        });
      }
      this.onmessage?.(message, extra);
    };
    this.transport.onerror = error => { this.onerror?.(error); };
    this.transport.onclose = () => {
      const writes = Array.from(this.pending.values(), call => this.record(call, "REQUEST_CANCELLED"));
      this.pending.clear();
      this.closingAudits = Promise.all(writes).then(() => undefined);
      this.lifetime?.waitUntil(this.closingAudits);
      this.onclose?.();
    };
    return this.transport.start();
  }

  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (!("method" in message) && "id" in message && message.id !== undefined) {
      const call = this.pending.get(message.id);
      if (call) {
        this.pending.delete(message.id);
        const errorCode = "error" in message
          ? (message.error.code === -32602 ? "INVALID_ARGUMENT" : "INTERNAL_ERROR")
          : resultErrorCode(message.result);
        if ("result" in message) call.requestId = resultRequestId(message.result) ?? call.requestId;
        const write = this.record(call, errorCode);
        if (this.lifetime) this.lifetime.waitUntil(write);
        else await write;
      }
    }
    return this.transport.send(message, options);
  }

  async close(): Promise<void> {
    await this.transport.close();
    await this.closingAudits;
  }

  private async record(call: PendingCall, errorCode?: string): Promise<void> {
    const durationMs = Math.max(0, Math.round(performance.now() - call.startedAt));
    const status = errorCode ? "ERROR" : "SUCCESS";
    logEvent("mcp_tool_call", {
      tool: call.toolName,
      requestId: call.requestId,
      status,
      durationMs,
      ...(errorCode ? { errorCode } : {}),
    });
    try {
      const response = await vaultStub(this.env).fetch("https://vault/audit/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.identity.clientId,
          toolName: call.toolName,
          requestId: call.requestId,
          parametersSummary: call.parametersSummary,
          status: errorCode ? "ERROR" : "SUCCESS",
          ...(errorCode ? { errorCode, errorMessage: errorCode === "INVALID_ARGUMENT" ? "Tool arguments are invalid" : "Tool call failed" } : {}),
          durationMs,
          createdAt: call.createdAt,
        }),
      });
      if (!response.ok) throw new Error("Audit write failed");
    } catch {
      // Audit storage failure must not change an already-completed tool result.
      console.error(JSON.stringify({ event: "tool_audit_record_failed", tool: call.toolName, requestId: call.requestId }));
    }
  }
}

export class AuditedMcpServer extends McpServer {
  constructor(
    info: ConstructorParameters<typeof McpServer>[0],
    private readonly env: AppEnv,
    private readonly identity: ClientIdentity,
    private readonly lifetime?: AuditLifetime,
  ) { super(info); }

  override connect(transport: Transport): Promise<void> {
    return super.connect(new ToolAuditTransport(transport, this.env, this.identity, this.lifetime));
  }
}
