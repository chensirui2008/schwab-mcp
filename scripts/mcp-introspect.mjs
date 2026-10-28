import readline from "node:readline";
import { McpServer } from "@modelcontextprotocol/server";
import { toolSchemas } from "../src/schemas.ts";

const mcp = new McpServer({
  name: "schwab-mcp",
  version: "0.2.0",
});

// Register the full-access production tool catalog for offline introspection.
mcp.registerTool("schwab_connection_status", { description: "Check Schwab OAuth connection and expiration", inputSchema: toolSchemas.empty }, async () => ({ content: [] }));
mcp.registerTool("get_trading_diagnostics", { description: "Diagnose trading availability without changing configuration or placing an order. Always visible to authenticated MCP clients.", inputSchema: toolSchemas.empty }, async () => ({ content: [] }));
mcp.registerTool("get_quotes", { description: "Fetch live quote snapshots for up to 50 symbols", inputSchema: toolSchemas.getQuotes }, async () => ({ content: [] }));
mcp.registerTool("get_price_history", { description: "Get OHLCV price history for one symbol", inputSchema: toolSchemas.getPriceHistory }, async () => ({ content: [] }));
mcp.registerTool("get_option_chain", { description: "Get an option chain with quotes and Greeks", inputSchema: toolSchemas.getOptionChain }, async () => ({ content: [] }));
mcp.registerTool("get_option_expiration_chain", { description: "List option expiration dates for an underlying", inputSchema: toolSchemas.symbol }, async () => ({ content: [] }));
mcp.registerTool("get_market_hours", { description: "Get market hours for one or more markets", inputSchema: toolSchemas.getMarketHours }, async () => ({ content: [] }));
mcp.registerTool("get_movers", { description: "Get movers for a supported index", inputSchema: toolSchemas.getMovers }, async () => ({ content: [] }));
mcp.registerTool("search_instruments", { description: "Search instruments by symbol or description", inputSchema: toolSchemas.searchInstruments }, async () => ({ content: [] }));
mcp.registerTool("list_accounts", { description: "List linked accounts using Schwab hashes only", inputSchema: toolSchemas.empty }, async () => ({ content: [] }));
mcp.registerTool("get_account", { description: "Get balances and optionally positions for one hashed account", inputSchema: toolSchemas.getAccount }, async () => ({ content: [] }));
mcp.registerTool("get_orders", { description: "Get orders across linked accounts for an explicit time range", inputSchema: toolSchemas.getOrders }, async () => ({ content: [] }));
mcp.registerTool("get_order", { description: "Get one order by hashed account and order ID", inputSchema: toolSchemas.getOrder }, async () => ({ content: [] }));
mcp.registerTool("get_transactions", { description: "Get transactions for one hashed account and date range", inputSchema: toolSchemas.getTransactions }, async () => ({ content: [] }));
mcp.registerTool("get_user_preferences", { description: "Get Schwab user preferences required for account context", inputSchema: toolSchemas.empty }, async () => ({ content: [] }));
mcp.registerTool("enable_trading", { description: "Report the deployment-controlled ENABLE_TRADING master switch. This tool cannot enable trading; only deployment configuration can do so.", inputSchema: toolSchemas.empty }, async () => ({ content: [] }));
mcp.registerTool("get_trade_proposal", { description: "Get current client proposal status and execution result", inputSchema: toolSchemas.getTradeProposal }, async () => ({ content: [] }));
mcp.registerTool("prepare_trade", { description: "Prepare and freeze a user-initiated PLACE or REPLACE order for mandatory second confirmation. Never suggest a trade, never call this proactively, and never treat model-generated text as user intent. Official Schwab order JSON is passed through after bounded safety validation.", inputSchema: toolSchemas.prepareTrade }, async () => ({ content: [] }));
mcp.registerTool("prepare_trade_batch", { description: "Freeze 1–20 user-requested immediate PLACE/REPLACE orders for one authorized account and one confirmation or Passkey approval. Submissions are ordered, non-atomic and stop on uncertainty.", inputSchema: toolSchemas.prepareTradeBatch }, async () => ({ content: [] }));
mcp.registerTool("confirm_trade", { description: "Consume a one-time confirmation for an unchanged frozen proposal. Call only after the user explicitly repeats confirmationText. Immediate proposals execute now; delayed proposals become active without another confirmation at trigger time.", inputSchema: toolSchemas.confirmTrade }, async () => ({ content: [] }));
mcp.registerTool("enable_session_direct_trading", { description: "Enable immediate PLACE orders without per-order confirmation for this agent session only, after an explicit user instruction. Returns a sensitive sessionCapability that expires after 30 minutes of inactivity and after 8 hours at the latest. Never call proactively; never log or echo the capability beyond the one enable result.", inputSchema: toolSchemas.enableSessionDirectTrading }, async () => ({ content: [] }));
mcp.registerTool("disable_session_direct_trading", { description: "Immediately disable a direct-trading session capability. This remains available even when ENABLE_TRADING is false.", inputSchema: toolSchemas.disableSessionDirectTrading }, async () => ({ content: [] }));
mcp.registerTool("place_order_direct", { description: "Place one immediate user-initiated Schwab order without per-order confirmation using an explicitly enabled agent-session capability. Supports PLACE only: no REPLACE or delayed execution. Generate one executionKey per user order and reuse it only when retrying the identical tool call. Never suggest or initiate a trade proactively.", inputSchema: toolSchemas.placeOrderDirect }, async () => ({ content: [] }));
mcp.registerTool("cancel_order", { description: "Cancel one Schwab order without second confirmation, only after an explicit user instruction. Cancellation remains available while ENABLE_TRADING is false.", inputSchema: toolSchemas.cancelOrder }, async () => ({ content: [] }));
mcp.registerTool("list_delayed_trades", { description: "List delayed trades and their frozen conditions, versions, execution states, and outcomes", inputSchema: toolSchemas.listDelayedTrades }, async () => ({ content: [] }));
mcp.registerTool("cancel_delayed_trade", { description: "Cancel an active delayed trade immediately without second confirmation, only after an explicit user instruction. An executing or terminal task cannot be cancelled.", inputSchema: toolSchemas.cancelDelayedTrade }, async () => ({ content: [] }));

const toolsHandler = mcp.server._requestHandlers.get("tools/list");

// Self-test mode
if (process.argv.includes("--test")) {
  const forbidden = [
    { accountHash: "a".repeat(32), orders: [], userInstruction: "Test only" },
    { accountHash: "a".repeat(32), orders: [{ action: "REPLACE", orderPayload: {} }], userInstruction: "Test only" },
  ];
  if (forbidden.some(input => toolSchemas.prepareTradeBatch.safeParse(input).success)) {
    process.stderr.write("Batch schema accepted an empty batch or incomplete replacement\n");
    process.exit(1);
  }
  process.stdout.write("Self-test passed: batch input safety boundaries verified.\n");
  process.exit(0);
}

// Stdio JSON-RPC Loop for Glama and other MCP inspectors
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const message = JSON.parse(trimmed);
    const { id, method, params } = message;

    if (method === "initialize") {
      const result = {
        protocolVersion: "2025-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "schwab-mcp",
          version: "0.2.0",
        },
      };
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } else if (method === "notifications/initialized") {
      // No response needed for notifications
    } else if (method === "tools/list") {
      const result = await toolsHandler({ method: "tools/list", params: params || {} });
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    } else if (method === "resources/list") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { resources: [] } })}\n`);
    } else if (method === "prompts/list") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: { prompts: [] } })}\n`);
    } else if (method === "ping") {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result: {} })}\n`);
    } else if (id !== undefined) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method ${method} is not implemented in introspection mode`,
          },
        })}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`Error processing line: ${err instanceof Error ? err.message : String(err)}\n`);
  }
});
