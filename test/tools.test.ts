import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { tradingEnabled } from "../src/env";
import { authorizationNotice, createServer, tradingDiagnostics, transactionDateRange } from "../src/tools";

const env = {
  SCHWAB_REDIRECT_URI: "https://example.com/auth/schwab/callback",
} as AppEnv;

describe("Schwab authorization notice", () => {
  it("returns a reconnect notice within 24 hours of refresh expiry", () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0);
    expect(authorizationNotice(now + 60 * 60 * 1000, env, now)).toEqual({
      code: "REAUTHORIZATION_DUE_SOON",
      message: "Schwab authorization expires within 24 hours; reconnect to avoid interruption",
      refreshExpiresAt: "2026-09-09T01:00:00.000Z",
      reconnectUrl: "https://example.com/auth/schwab/connect",
    });
  });

  it("does not return a notice outside the reminder window", () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0);
    expect(authorizationNotice(now + 24 * 60 * 60 * 1000 + 1, env, now)).toBeUndefined();
    expect(authorizationNotice(now, env, now)).toBeUndefined();
  });
});

describe("trading master switch", () => {
  it("is enabled only by the exact deployment value true", () => {
    expect(tradingEnabled({ ENABLE_TRADING: "true" } as AppEnv)).toBe(true);
    expect(tradingEnabled({ ENABLE_TRADING: "false" } as AppEnv)).toBe(false);
    expect(tradingEnabled({ ENABLE_TRADING: "TRUE" } as AppEnv)).toBe(false);
  });
});

describe("transaction date range", () => {
  it("converts date-only input to an inclusive UTC range for Schwab", () => {
    expect(transactionDateRange("2026-09-15", "2026-09-16")).toEqual({
      startDate: "2026-09-15T00:00:00.000Z",
      endDate: "2026-09-16T23:59:59.999Z",
    });
  });
});

describe("authenticated tool exposure", () => {
  const tradingTools = [
    "enable_trading",
    "prepare_trade",
    "confirm_trade",
    "enable_session_direct_trading",
    "disable_session_direct_trading",
    "place_order_direct",
    "cancel_order",
    "list_delayed_trades",
    "cancel_delayed_trade",
  ];

  it("registers diagnostics and trading tools for every authenticated MCP client", () => {
    const server = createServer(env);
    expect(server.toolInputSchemaJson("get_trading_diagnostics")).toBeDefined();
    for (const tool of tradingTools) expect(server.toolInputSchemaJson(tool)).toBeDefined();
  });

  it("reports the deployment switch without an OAuth trade gate", () => {
    expect(tradingDiagnostics({ ENABLE_TRADING: "true" } as AppEnv)).toMatchObject({
      oauthTradeScopeRequired: false,
      tradingToolsRegistered: true,
      deploymentTradingEnabled: true,
      effectiveTradingState: "ENABLED",
    });
    expect(tradingDiagnostics({ ENABLE_TRADING: "false" } as AppEnv)).toMatchObject({
      deploymentTradingEnabled: false,
      effectiveTradingState: "DISABLED_BY_DEPLOYMENT",
      cancellationAvailableWhenDisabled: true,
    });
  });
});
