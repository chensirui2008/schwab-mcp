import { describe, expect, it } from "vitest";
import { toolSchemas } from "../src/schemas";

describe("tool input schemas", () => {
  it("rejects excessive symbol counts and invalid enums", () => {
    expect(toolSchemas.getQuotes.safeParse({ symbols: Array.from({ length: 51 }, () => "AAPL") }).success).toBe(false);
    expect(toolSchemas.getMovers.safeParse({ index: "UNSUPPORTED" }).success).toBe(false);
    expect(toolSchemas.searchInstruments.safeParse({ symbol: "AAPL", projection: "unknown" }).success).toBe(false);
  });

  it("rejects malformed symbols, hashes, and dates", () => {
    expect(toolSchemas.getQuotes.safeParse({ symbols: ["AAPL\nAuthorization: secret"] }).success).toBe(false);
    expect(toolSchemas.getAccount.safeParse({ accountHash: "1234" }).success).toBe(false);
    expect(toolSchemas.getTransactions.safeParse({ accountHash: "a".repeat(32), startDate: "2026/01/02", endDate: "2026-01-03" }).success).toBe(false);
  });

  it("rejects reversed date ranges before any Schwab request", () => {
    expect(toolSchemas.getPriceHistory.safeParse({ symbol: "AAPL", periodType: "day", frequencyType: "minute", frequency: 1, startDate: 2, endDate: 1 }).success).toBe(false);
    expect(toolSchemas.getOptionChain.safeParse({ symbol: "AAPL", fromDate: "2026-02-02", toDate: "2026-02-01" }).success).toBe(false);
    expect(toolSchemas.getOrders.safeParse({ fromEnteredTime: "2026-02-02T00:00:00Z", toEnteredTime: "2026-02-01T00:00:00Z" }).success).toBe(false);
  });
});
