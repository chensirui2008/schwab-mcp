import { z } from "zod";

const symbol = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9$./_ -]+$/);
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const accountHash = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);

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
} as const;
