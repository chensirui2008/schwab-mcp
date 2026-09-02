import { McpServer } from "@modelcontextprotocol/server";
import type { AppEnv } from "./env";
import { vaultStub } from "./env";
import { accountHashes, redact } from "./redaction";
import { toolSchemas } from "./schemas";
import type { PublicError, ToolResult, VaultRequest } from "./types";

interface VaultEnvelope {
  result?: unknown;
  attempts?: number;
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
  return {
    ...(isPublicError(error) ? { error } : {}),
    ...(result === undefined ? {} : { result }),
    ...(typeof attempts === "number" ? { attempts } : {}),
  };
}

type Transform = (value: unknown) => unknown;

function reconnectUrl(env: AppEnv): string {
  return `${new URL(env.SCHWAB_REDIRECT_URI).origin}/auth/schwab/connect`;
}

function toolError(error: PublicError, env: AppEnv) {
  const output: PublicError =
    error.code === "REAUTHORIZATION_REQUIRED" ? { ...error, reconnectUrl: reconnectUrl(env) } : error;
  return {
    resultType: "complete" as const,
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: output }) }],
  };
}

async function execute(
  env: AppEnv,
  tool: string,
  base: VaultRequest["base"],
  path: string,
  query: Record<string, string> = {},
  transform: Transform = redact,
) {
  const requestId = crypto.randomUUID();
  const response = await vaultStub(env).fetch("https://vault/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base, path, query, requestId, tool } satisfies VaultRequest),
  });
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
  } catch (error) {
    console.error(JSON.stringify({ event: "schwab_response_invalid", requestId, tool, message: error instanceof Error ? error.message : "Unknown error" }));
    return toolError({ code: "UPSTREAM_UNAVAILABLE", message: "Unexpected Schwab response shape", requestId }, env);
  }
  const output: ToolResult<unknown> = {
    data,
    meta: { source: "schwab", fetchedAt: new Date().toISOString(), requestId },
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

export function createServer(env: AppEnv): McpServer {
  const server = new McpServer({ name: "schwab-mcp", version: env.APP_VERSION });

  server.registerTool(
    "schwab_connection_status",
    { description: "Check whether Schwab authorization is connected", inputSchema: toolSchemas.empty },
    async () => {
      const requestId = crypto.randomUUID();
      const response = await vaultStub(env).fetch("https://vault/status");
      const rawStatus: unknown = await response.json();
      const status = rawStatus !== null && typeof rawStatus === "object" ? redact(rawStatus) : {};
      const output: ToolResult<unknown> = {
        data: { ...(status as Record<string, unknown>), reconnectUrl: reconnectUrl(env) },
        meta: { source: "schwab", fetchedAt: new Date().toISOString(), requestId },
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
      return execute(env, "get_quotes", "market", "/quotes", query);
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
      return execute(env, "get_price_history", "market", "/pricehistory", query);
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
      return execute(env, "get_option_chain", "market", "/chains", query);
    },
  );

  server.registerTool(
    "get_option_expiration_chain",
    { description: "List option expiration dates for an underlying", inputSchema: toolSchemas.symbol },
    async ({ symbol: value }) => execute(env, "get_option_expiration_chain", "market", "/expirationchain", { symbol: value }),
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
      return execute(env, "get_market_hours", "market", "/markets", query);
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
      return execute(env, "get_movers", "market", `/movers/${encodeURIComponent(index)}`, query);
    },
  );

  server.registerTool(
    "search_instruments",
    {
      description: "Search instruments by symbol or description",
      inputSchema: toolSchemas.searchInstruments,
    },
    async ({ symbol: value, projection }) => execute(env, "search_instruments", "market", "/instruments", { symbol: value, projection }),
  );

  server.registerTool(
    "list_accounts",
    { description: "List linked accounts using Schwab hashes only", inputSchema: toolSchemas.empty },
    async () => execute(env, "list_accounts", "trader", "/accounts/accountNumbers", {}, accountHashes),
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
      return execute(env, "get_account", "trader", `/accounts/${encodeURIComponent(hash)}`, query);
    },
  );

  server.registerTool(
    "get_orders",
    {
      description: "Get orders across linked accounts for an explicit time range",
      inputSchema: toolSchemas.getOrders,
    },
    async ({ fromEnteredTime, toEnteredTime, maxResults, status }) => {
      const query: Record<string, string> = { fromEnteredTime, toEnteredTime };
      optional(query, "maxResults", maxResults);
      optional(query, "status", status);
      return execute(env, "get_orders", "trader", "/orders", query);
    },
  );

  server.registerTool(
    "get_order",
    {
      description: "Get one order by hashed account and order ID",
      inputSchema: toolSchemas.getOrder,
    },
    async ({ accountHash: hash, orderId }) => execute(env, "get_order", "trader", `/accounts/${encodeURIComponent(hash)}/orders/${String(orderId)}`),
  );

  server.registerTool(
    "get_transactions",
    {
      description: "Get transactions for one hashed account and date range",
      inputSchema: toolSchemas.getTransactions,
    },
    async ({ accountHash: hash, startDate, endDate, types, symbol: transactionSymbol }) => {
      const query: Record<string, string> = { startDate, endDate };
      optional(query, "types", types);
      optional(query, "symbol", transactionSymbol);
      return execute(env, "get_transactions", "trader", `/accounts/${encodeURIComponent(hash)}/transactions`, query);
    },
  );

  server.registerTool(
    "get_user_preferences",
    { description: "Get Schwab user preferences required for account context", inputSchema: toolSchemas.empty },
    async () => execute(env, "get_user_preferences", "trader", "/userPreference"),
  );

  return server;
}
