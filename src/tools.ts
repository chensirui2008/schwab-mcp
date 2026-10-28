import type { McpServer } from "@modelcontextprotocol/server";
import type { AppEnv } from "./env";
import { tradingEnabled, vaultStub } from "./env";
import type { ClientIdentity } from "./security-store";
import type { PermissionLevel } from "./oauth-access";
import { accountHashes, redact } from "./redaction";
import { toolSchemas } from "./schemas";
import { AuditedMcpServer } from "./tool-audit";
import type { AuthorizationNotice, PublicError, ToolResult, VaultRequest } from "./types";

const REAUTHORIZATION_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface VaultEnvelope {
  result?: unknown;
  attempts?: number;
  refreshExpiresAt?: number;
  error?: PublicError;
}

function isPublicError(value: unknown): value is PublicError {
  if (value === null || typeof value !== "object") return false;
  return typeof Reflect.get(value, "code") === "string" && typeof Reflect.get(value, "message") === "string" && typeof Reflect.get(value, "requestId") === "string";
}

function parseVaultEnvelope(value: unknown): VaultEnvelope {
  if (value === null || typeof value !== "object") return {};
  const error = Reflect.get(value, "error") as unknown;
  const result = Reflect.get(value, "result") as unknown;
  const attempts = Reflect.get(value, "attempts") as unknown;
  const refreshExpiresAt = Reflect.get(value, "refreshExpiresAt") as unknown;
  return {
    ...(isPublicError(error) ? { error } : {}),
    ...(result === undefined ? {} : { result }),
    ...(typeof attempts === "number" ? { attempts } : {}),
    ...(typeof refreshExpiresAt === "number" ? { refreshExpiresAt } : {}),
  };
}

type Transform = (value: unknown) => unknown;

function reconnectUrl(env: AppEnv): string {
  return `${new URL(env.SCHWAB_REDIRECT_URI).origin}/auth/schwab/connect`;
}

export function authorizationNotice(refreshExpiresAt: number | null | undefined, env: AppEnv, now = Date.now()): AuthorizationNotice | undefined {
  if (typeof refreshExpiresAt !== "number" || refreshExpiresAt <= now || refreshExpiresAt - now > REAUTHORIZATION_NOTICE_WINDOW_MS) return undefined;
  return {
    code: "REAUTHORIZATION_DUE_SOON",
    message: "Schwab authorization expires within 24 hours; reconnect to avoid interruption",
    refreshExpiresAt: new Date(refreshExpiresAt).toISOString(),
    reconnectUrl: reconnectUrl(env),
  };
}

function toolError(error: PublicError, env: AppEnv) {
  const output: PublicError =
    error.code === "AUTH_REQUIRED" || error.code === "REAUTHORIZATION_REQUIRED" ? { ...error, reconnectUrl: reconnectUrl(env) } : error;
  return {
    resultType: "complete" as const,
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: output }) }],
    structuredContent: { error: output },
  };
}

async function execute(
  env: AppEnv,
  identity: ClientIdentity,
  tool: string,
  base: VaultRequest["base"],
  path: string,
  query: Record<string, string> = {},
  transform: Transform = redact,
) {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    response = await vaultStub(env).fetch("https://vault/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base, path, query, requestId, tool, identity } satisfies VaultRequest),
    });
  } catch {
    console.error(JSON.stringify({ event: "schwab_vault_unavailable", requestId, tool }));
    return toolError({ code: "UPSTREAM_UNAVAILABLE", message: "Schwab vault is unavailable", requestId }, env);
  }
  const envelope = parseVaultEnvelope(await response.json());
  if (!response.ok || envelope.error) {
    return toolError(
      envelope.error ?? { code: "UPSTREAM_UNAVAILABLE", message: "Schwab request failed", requestId },
      env,
    );
  }
  let data: unknown;
  try {
    data = transform(envelope.result);
  } catch {
    console.error(JSON.stringify({ event: "schwab_response_invalid", requestId, tool }));
    return toolError({ code: "UPSTREAM_UNAVAILABLE", message: "Unexpected Schwab response shape", requestId }, env);
  }
  const notice = authorizationNotice(envelope.refreshExpiresAt, env);
  const output: ToolResult<unknown> = {
    data,
    meta: {
      source: "schwab",
      fetchedAt: new Date().toISOString(),
      requestId,
      ...(notice ? { authorizationNotice: notice } : {}),
    },
  };
  return {
    resultType: "complete" as const,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

async function executeVaultAction(env: AppEnv, tool: string, path: string, input: unknown, transform: Transform = redact, identity?: ClientIdentity) {
  const requestId = crypto.randomUUID();
  let response: Response;
  try {
    response = await vaultStub(env).fetch(`https://vault${path}`, {
      method: path === "/trading/status" ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(path === "/trading/status" ? {} : { body: JSON.stringify({ requestId, input, identity }) }),
    });
  } catch {
    return toolError({ code: "UPSTREAM_UNAVAILABLE", message: "Schwab vault is unavailable", requestId }, env);
  }
  const envelope = parseVaultEnvelope(await response.json());
  if (!response.ok || envelope.error) {
    return toolError(envelope.error ?? { code: "UPSTREAM_UNAVAILABLE", message: "Trading request failed", requestId }, env);
  }
  let data: unknown;
  try {
    data = transform(envelope.result);
  } catch {
    return toolError({ code: "UPSTREAM_UNAVAILABLE", message: "Unexpected trading response shape", requestId }, env);
  }
  const notice = authorizationNotice(envelope.refreshExpiresAt, env);
  const output: ToolResult<unknown> = {
    data,
    meta: {
      source: "schwab",
      fetchedAt: new Date().toISOString(),
      requestId,
      ...(notice ? { authorizationNotice: notice } : {}),
    },
  };
  return {
    resultType: "complete" as const,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function optional(query: Record<string, string>, key: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) query[key] = String(value);
}

export function transactionDateRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  return {
    startDate: `${startDate}T00:00:00.000Z`,
    endDate: `${endDate}T23:59:59.999Z`,
  };
}

export function tradingDiagnostics(env: AppEnv, permissionLevel: PermissionLevel = "read_only", advancedSecurity = false) {
  const deploymentTradingEnabled = tradingEnabled(env);
  const tradingToolsRegistered = permissionLevel === "full_access";
  return {
    advancedSecurity,
    approvalMethod: advancedSecurity ? "passkey" : "conversation",
    sessionDirectTradingAvailable: permissionLevel === "full_access" && !advancedSecurity,
    oauthTradeScopeRequired: false,
    permissionLevel,
    tradingToolsRegistered,
    deploymentTradingEnabled,
    effectiveTradingState: !tradingToolsRegistered ? "DISABLED_BY_PERMISSION" : deploymentTradingEnabled ? "ENABLED" : "DISABLED_BY_DEPLOYMENT",
    cancellationAvailableWhenDisabled: tradingToolsRegistered,
    protection: advancedSecurity ? "Trading mutations require explicit user instructions and browser Passkey approval; session direct trading is unavailable." : "Trading mutations still require explicit user instructions and the applicable confirmation or session capability.",
  };
}

export function createServer(
  env: AppEnv,
  permissionLevel: PermissionLevel = "read_only",
  identity: ClientIdentity = { clientId: "local", advancedSecurity: false, securityPolicyVersion: 0 },
  ctx?: Pick<ExecutionContext, "waitUntil">,
): McpServer {
  const server = new AuditedMcpServer({ name: "schwab-mcp", version: env.APP_VERSION }, env, identity, ctx);

  server.registerTool(
    "schwab_connection_status",
    { description: "Check whether Schwab authorization is connected", inputSchema: toolSchemas.empty },
    async () => {
      const requestId = crypto.randomUUID();
      const response = await vaultStub(env).fetch("https://vault/status");
      const rawStatus: unknown = await response.json();
      const status = rawStatus !== null && typeof rawStatus === "object" ? redact(rawStatus) : {};
      const notice = authorizationNotice(Reflect.get(status as object, "refreshExpiresAt") as number | null | undefined, env);
      const output: ToolResult<unknown> = {
        data: { ...(status as Record<string, unknown>), reconnectUrl: reconnectUrl(env) },
        meta: {
          source: "schwab",
          fetchedAt: new Date().toISOString(),
          requestId,
          ...(notice ? { authorizationNotice: notice } : {}),
        },
      };
      return { resultType: "complete" as const, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    },
  );

  server.registerTool(
    "get_trading_diagnostics",
    {
      description: "Diagnose trading availability without changing configuration or placing an order. Always visible to authenticated MCP clients.",
      inputSchema: toolSchemas.empty,
    },
    () => {
      const output: ToolResult<ReturnType<typeof tradingDiagnostics>> = {
        data: tradingDiagnostics(env, permissionLevel, identity.advancedSecurity),
        meta: { source: "deployment", fetchedAt: new Date().toISOString(), requestId: crypto.randomUUID() },
      };
      return { resultType: "complete" as const, content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    },
  );

  server.registerTool(
    "get_quotes",
    {
      description: "Get live quote snapshots for up to 50 symbols",
      inputSchema: toolSchemas.getQuotes,
    },
    async ({ symbols, fields, indicative }) => {
      const query: Record<string, string> = { symbols: symbols.join(",") };
      optional(query, "fields", fields?.join(","));
      optional(query, "indicative", indicative);
      return execute(env, identity, "get_quotes", "market", "/quotes", query);
    },
  );

  server.registerTool(
    "get_price_history",
    {
      description: "Get OHLCV price history for one symbol",
      inputSchema: toolSchemas.getPriceHistory,
    },
    async (args) => {
      const query: Record<string, string> = {
        symbol: args.symbol,
        periodType: args.periodType,
        frequencyType: args.frequencyType,
        frequency: String(args.frequency),
      };
      optional(query, "period", args.period);
      optional(query, "startDate", args.startDate);
      optional(query, "endDate", args.endDate);
      optional(query, "needExtendedHoursData", args.needExtendedHoursData);
      optional(query, "needPreviousClose", args.needPreviousClose);
      return execute(env, identity, "get_price_history", "market", "/pricehistory", query);
    },
  );

  server.registerTool(
    "get_option_chain",
    {
      description: "Get an option chain with quotes and Greeks",
      inputSchema: toolSchemas.getOptionChain,
    },
    async (args) => {
      const query: Record<string, string> = { symbol: args.symbol };
      optional(query, "contractType", args.contractType);
      optional(query, "strikeCount", args.strikeCount);
      optional(query, "includeUnderlyingQuote", args.includeUnderlyingQuote);
      optional(query, "strategy", args.strategy);
      optional(query, "fromDate", args.fromDate);
      optional(query, "toDate", args.toDate);
      optional(query, "expMonth", args.expMonth);
      optional(query, "optionType", args.optionType);
      return execute(env, identity, "get_option_chain", "market", "/chains", query);
    },
  );

  server.registerTool(
    "get_option_expiration_chain",
    { description: "List option expiration dates for an underlying", inputSchema: toolSchemas.symbol },
    async ({ symbol: value }) => execute(env, identity, "get_option_expiration_chain", "market", "/expirationchain", { symbol: value }),
  );

  server.registerTool(
    "get_market_hours",
    {
      description: "Get market hours for one or more markets",
      inputSchema: toolSchemas.getMarketHours,
    },
    async ({ markets, date }) => {
      const query: Record<string, string> = { markets: markets.join(",") };
      optional(query, "date", date);
      return execute(env, identity, "get_market_hours", "market", "/markets", query);
    },
  );

  server.registerTool(
    "get_movers",
    {
      description: "Get movers for a supported index",
      inputSchema: toolSchemas.getMovers,
    },
    async ({ index, sort, frequency }) => {
      const query: Record<string, string> = {};
      optional(query, "sort", sort);
      optional(query, "frequency", frequency);
      return execute(env, identity, "get_movers", "market", `/movers/${encodeURIComponent(index)}`, query);
    },
  );

  server.registerTool(
    "search_instruments",
    {
      description: "Search instruments by symbol or description",
      inputSchema: toolSchemas.searchInstruments,
    },
    async ({ symbol: value, projection }) => execute(env, identity, "search_instruments", "market", "/instruments", { symbol: value, projection }),
  );

  server.registerTool(
    "list_accounts",
    { description: "List only accounts authorized for this MCP client, using Schwab hashes only", inputSchema: toolSchemas.empty },
    async () => execute(env, identity, "list_accounts", "trader", "/accounts/accountNumbers", {}, accountHashes),
  );

  server.registerTool(
    "get_account",
    {
      description: "Get balances and optionally positions for one hashed account",
      inputSchema: toolSchemas.getAccount,
    },
    async ({ accountHash: hash, includePositions }) => {
      const query: Record<string, string> = {};
      if (includePositions) query.fields = "positions";
      return execute(env, identity, "get_account", "trader", `/accounts/${encodeURIComponent(hash)}`, query);
    },
  );

  server.registerTool(
    "get_orders",
    {
      description: "Get orders across accounts authorized for this MCP client for an explicit time range",
      inputSchema: toolSchemas.getOrders,
    },
    async ({ fromEnteredTime, toEnteredTime, maxResults, status }) => {
      const query: Record<string, string> = { fromEnteredTime, toEnteredTime };
      optional(query, "maxResults", maxResults);
      optional(query, "status", status);
      return execute(env, identity, "get_orders", "trader", "/orders", query);
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Get one order by hashed account and order ID",
      inputSchema: toolSchemas.getOrder,
    },
    async ({ accountHash: hash, orderId }) => execute(env, identity, "get_order", "trader", `/accounts/${encodeURIComponent(hash)}/orders/${String(orderId)}`),
  );

  server.registerTool(
    "get_transactions",
    {
      description: "Get transactions for one hashed account and date range",
      inputSchema: toolSchemas.getTransactions,
    },
    async ({ accountHash: hash, startDate, endDate, types, symbol: transactionSymbol }) => {
      const query: Record<string, string> = transactionDateRange(startDate, endDate);
      optional(query, "types", types);
      optional(query, "symbol", transactionSymbol);
      return execute(env, identity, "get_transactions", "trader", `/accounts/${encodeURIComponent(hash)}/transactions`, query);
    },
  );

  server.registerTool(
    "get_user_preferences",
    { description: "Get sanitized preferences for authorized accounts only; excludes streamer credentials", inputSchema: toolSchemas.empty },
    async () => execute(env, identity, "get_user_preferences", "trader", "/userPreference"),
  );

  const tradeAction = (tool: string, path: string, input: unknown) => executeVaultAction(env, tool, path, input, redact, identity);

  // Omit the entire trading surface, so guessed tools/call names are rejected too.
  if (permissionLevel !== "full_access") return server;

  server.registerTool(
    "enable_trading",
    {
      description: "Report the deployment-controlled ENABLE_TRADING master switch. This tool cannot enable trading; only deployment configuration can do so.",
      inputSchema: toolSchemas.empty,
    },
    async () => tradeAction("enable_trading", "/trading/status", {}),
  );

  server.registerTool("get_trade_proposal", {
    description: "Get the current client's frozen trade proposal status and result without confirmation credentials.",
    inputSchema: toolSchemas.getTradeProposal,
  }, async input => tradeAction("get_trade_proposal", "/trade/proposal", input));

  server.registerTool(
    "prepare_trade",
    {
      description: "Prepare and freeze a user-initiated PLACE or REPLACE order for mandatory second confirmation. Advanced Security returns a browser approvalUrl for Passkey approval and immediate submission; poll get_trade_proposal for its outcome. Never suggest a trade, never call this proactively, and never treat model-generated text as user intent. Official Schwab order JSON is passed through after bounded safety validation.",
      inputSchema: toolSchemas.prepareTrade,
    },
    async (input) => tradeAction("prepare_trade", "/trade/prepare", input),
  );

  server.registerTool(
    "prepare_trade_batch",
    {
      description: "Freeze 1–20 user-initiated immediate PLACE or REPLACE orders for one account and one mandatory approval. Orders execute in sequence without rollback; an uncertain outcome stops the batch. Never initiate trades proactively.",
      inputSchema: toolSchemas.prepareTradeBatch,
    },
    async (input) => tradeAction("prepare_trade_batch", "/trade/prepare-batch", input),
  );

  if (!identity.advancedSecurity) server.registerTool(
    "confirm_trade",
    {
      description: "Consume a one-time confirmation for an unchanged frozen proposal. Call only after the user explicitly repeats confirmationText. Immediate proposals execute now; delayed proposals become active without another confirmation at trigger time.",
      inputSchema: toolSchemas.confirmTrade,
    },
    async (input) => tradeAction("confirm_trade", "/trade/confirm", input),
  );

  if (!identity.advancedSecurity) server.registerTool(
    "enable_session_direct_trading",
    {
      description: "Enable immediate PLACE orders without per-order confirmation for this agent session only, after an explicit user instruction. Returns a sensitive sessionCapability that expires after 30 minutes of inactivity and after 8 hours at the latest. Never call proactively; never log or echo the capability beyond the one enable result.",
      inputSchema: toolSchemas.enableSessionDirectTrading,
    },
    async (input) => tradeAction("enable_session_direct_trading", "/trade/session/enable", input),
  );

  server.registerTool(
    "disable_session_direct_trading",
    {
      description: "Immediately disable a direct-trading session capability. This remains available even when ENABLE_TRADING is false.",
      inputSchema: toolSchemas.disableSessionDirectTrading,
    },
    async (input) => tradeAction("disable_session_direct_trading", "/trade/session/disable", input),
  );

  if (!identity.advancedSecurity) server.registerTool(
    "place_order_direct",
    {
      description: "Place one immediate user-initiated Schwab order without per-order confirmation using an explicitly enabled agent-session capability. Supports PLACE only: no REPLACE or delayed execution. Generate one executionKey per user order and reuse it only when retrying the identical tool call. Never suggest or initiate a trade proactively.",
      inputSchema: toolSchemas.placeOrderDirect,
    },
    async (input) => tradeAction("place_order_direct", "/trade/place-direct", input),
  );

  server.registerTool(
    "cancel_order",
    {
      description: "Cancel one Schwab order without second confirmation, only after an explicit user instruction. Cancellation remains available while ENABLE_TRADING is false.",
      inputSchema: toolSchemas.cancelOrder,
    },
    async (input) => tradeAction("cancel_order", "/trade/cancel-order", input),
  );

  server.registerTool(
    "list_delayed_trades",
    { description: "List delayed trades and their frozen conditions, versions, execution states, and outcomes", inputSchema: toolSchemas.listDelayedTrades },
    async (input) => tradeAction("list_delayed_trades", "/trade/list-delayed", input),
  );

  server.registerTool(
    "cancel_delayed_trade",
    {
      description: "Cancel an active delayed trade immediately without second confirmation, only after an explicit user instruction. An executing or terminal task cannot be cancelled.",
      inputSchema: toolSchemas.cancelDelayedTrade,
    },
    async (input) => tradeAction("cancel_delayed_trade", "/trade/cancel-delayed", input),
  );

  return server;
}
