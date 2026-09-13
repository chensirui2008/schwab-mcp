import { z } from "zod";
import type { JsonValue, TradeCondition } from "./types";

const symbol = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9$./_ -]+$/);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const accountHash = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
const uuid = z.uuid();

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string().max(16_384), z.array(jsonValue).max(256), z.record(z.string().min(1).max(128), jsonValue)]),
);

const orderPayload = z.record(z.string().min(1).max(128), jsonValue).superRefine((value, ctx) => {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 65_536) ctx.addIssue({ code: "custom", message: "orderPayload must not exceed 64 KiB" });
  if (typeof value.orderStrategyType !== "string") {
    ctx.addIssue({ code: "custom", message: "orderPayload.orderStrategyType is required" });
  }
  const hasLegs = Array.isArray(value.orderLegCollection) && value.orderLegCollection.length > 0;
  const hasChildren = Array.isArray(value.childOrderStrategies) && value.childOrderStrategies.length > 0;
  if (!hasLegs && !hasChildren) {
    ctx.addIssue({ code: "custom", message: "orderPayload requires orderLegCollection or childOrderStrategies" });
  }
});

export const tradeConditionSchema: z.ZodType<TradeCondition> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.enum(["ALL", "ANY"]), conditions: z.array(tradeConditionSchema).min(1).max(10) }),
    z.object({ type: z.literal("NOT"), condition: tradeConditionSchema }),
    z.object({ type: z.literal("TIME"), operator: z.enum(["BEFORE", "AT_OR_BEFORE", "AFTER", "AT_OR_AFTER"]), at: isoDateTime }),
    z.object({
      type: z.literal("QUOTE"),
      symbol,
      field: z.enum(["askPrice", "bidPrice", "lastPrice", "mark", "netPercentChangeInDouble", "totalVolume"]),
      operator: z.enum(["LT", "LTE", "EQ", "GTE", "GT"]),
      value: z.number(),
    }),
  ]),
);

const prepareTrade = z.object({
  accountHash,
  action: z.enum(["PLACE", "REPLACE"]),
  executionMode: z.enum(["IMMEDIATE", "DELAYED"]),
  orderId: z.number().int().positive().optional(),
  orderPayload,
  userInstruction: z.string().trim().min(1).max(4000),
  condition: tradeConditionSchema.optional(),
  validUntil: isoDateTime.optional(),
  pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
  replacesTaskId: uuid.optional(),
}).superRefine((value, ctx) => {
  if (value.action === "REPLACE" && value.orderId === undefined) ctx.addIssue({ code: "custom", message: "orderId is required for REPLACE" });
  if (value.action === "PLACE" && value.orderId !== undefined) ctx.addIssue({ code: "custom", message: "orderId is not allowed for PLACE" });
  if (value.executionMode === "DELAYED") {
    if (value.condition === undefined) ctx.addIssue({ code: "custom", message: "condition is required for DELAYED execution" });
    if (value.validUntil === undefined) ctx.addIssue({ code: "custom", message: "validUntil is required for DELAYED execution" });
  } else if (value.condition !== undefined || value.validUntil !== undefined || value.pollIntervalSeconds !== undefined || value.replacesTaskId !== undefined) {
    ctx.addIssue({ code: "custom", message: "delayed-execution fields are not allowed for IMMEDIATE execution" });
  }
});

export const toolSchemas = {
  empty: z.object({}),
  getQuotes: z.object({
    symbols: z.array(symbol).min(1).max(50),
    fields: z.array(z.enum(["quote", "fundamental", "reference", "extended", "regular"])).optional(),
    indicative: z.boolean().optional(),
  }),
  getPriceHistory: z.object({
    symbol,
    periodType: z.enum(["day", "month", "year", "ytd"]),
    period: z.number().int().positive().optional(),
    frequencyType: z.enum(["minute", "daily", "weekly", "monthly"]),
    frequency: z.number().int().positive(),
    startDate: z.number().int().nonnegative().optional(),
    endDate: z.number().int().nonnegative().optional(),
    needExtendedHoursData: z.boolean().optional(),
    needPreviousClose: z.boolean().optional(),
  }).refine((value) => value.startDate === undefined || value.endDate === undefined || value.startDate <= value.endDate, {
    message: "startDate must not be after endDate",
  }),
  getOptionChain: z.object({
    symbol,
    contractType: z.enum(["CALL", "PUT", "ALL"]).optional(),
    strikeCount: z.number().int().positive().max(100).optional(),
    includeUnderlyingQuote: z.boolean().optional(),
    strategy: z.enum(["SINGLE", "ANALYTICAL", "COVERED", "VERTICAL", "CALENDAR", "STRANGLE", "STRADDLE", "BUTTERFLY", "CONDOR", "DIAGONAL", "COLLAR", "ROLL"]).optional(),
    fromDate: isoDate.optional(),
    toDate: isoDate.optional(),
    expMonth: z.enum(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC", "ALL"]).optional(),
    optionType: z.enum(["S", "NS", "ALL"]).optional(),
  }).refine((value) => value.fromDate === undefined || value.toDate === undefined || value.fromDate <= value.toDate, {
    message: "fromDate must not be after toDate",
  }),
  symbol: z.object({ symbol }),
  getMarketHours: z.object({
    markets: z.array(z.enum(["equity", "option", "bond", "future", "forex"])).min(1).max(5),
    date: isoDate.optional(),
  }),
  getMovers: z.object({
    index: z.enum(["$DJI", "$COMPX", "$SPX", "NYSE", "NASDAQ", "OTCBB", "INDEX_ALL", "EQUITY_ALL", "OPTION_ALL", "OPTION_PUT", "OPTION_CALL"]),
    sort: z.enum(["VOLUME", "TRADES", "PERCENT_CHANGE_UP", "PERCENT_CHANGE_DOWN"]).optional(),
    frequency: z.union([z.literal(0), z.literal(1), z.literal(5), z.literal(10), z.literal(30), z.literal(60)]).optional(),
  }),
  searchInstruments: z.object({
    symbol,
    projection: z.enum(["symbol-search", "symbol-regex", "desc-search", "desc-regex", "search", "fundamental"]),
  }),
  getAccount: z.object({ accountHash, includePositions: z.boolean().optional() }),
  getOrders: z.object({
    fromEnteredTime: isoDateTime,
    toEnteredTime: isoDateTime,
    maxResults: z.number().int().positive().max(3000).optional(),
    status: z.string().min(1).max(64).optional(),
  }).refine((value) => value.fromEnteredTime <= value.toEnteredTime, {
    message: "fromEnteredTime must not be after toEnteredTime",
  }),
  getOrder: z.object({ accountHash, orderId: z.number().int().positive() }),
  getTransactions: z.object({
    accountHash,
    startDate: isoDate,
    endDate: isoDate,
    types: z.string().min(1).max(256).optional(),
    symbol: symbol.optional(),
  }).refine((value) => value.startDate <= value.endDate, {
    message: "startDate must not be after endDate",
  }),
  prepareTrade,
  confirmTrade: z.object({
    proposalId: uuid,
    confirmationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    confirmationText: z.string().trim().min(1).max(256),
  }),
  cancelOrder: z.object({ accountHash, orderId: z.number().int().positive(), userInstruction: z.string().trim().min(1).max(4000) }),
  listDelayedTrades: z.object({ status: z.enum(["ACTIVE", "EXECUTING", "EXECUTED", "FAILED", "EXECUTION_UNCERTAIN", "CANCELLED", "EXPIRED"]).optional() }),
  cancelDelayedTrade: z.object({ taskId: uuid, userInstruction: z.string().trim().min(1).max(4000) }),
} as const;
