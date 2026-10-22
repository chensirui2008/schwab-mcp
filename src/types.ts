export type ErrorCode =
  | "ACCOUNT_ACCESS_DENIED"
  | "SECURITY_VERIFICATION_FAILED"
  | "SECURITY_POLICY_CHANGED"
  | "BROWSER_AUTH_REQUIRED"
  | "AUTH_REQUIRED"
  | "REAUTHORIZATION_REQUIRED"
  | "INVALID_ARGUMENT"
  | "RATE_LIMITED"
  | "SCHWAB_REJECTED"
  | "UPSTREAM_UNAVAILABLE"
  | "CONFIRMATION_INVALID"
  | "CONFIRMATION_EXPIRED"
  | "TRADE_NOT_FOUND"
  | "TRADE_STATE_CONFLICT"
  | "DIRECT_TRADING_SESSION_INVALID"
  | "EXECUTION_UNCERTAIN";

export interface ToolMeta {
  source: "schwab" | "deployment";
  fetchedAt: string;
  requestId: string;
  authorizationNotice?: AuthorizationNotice;
}

export interface AuthorizationNotice {
  code: "REAUTHORIZATION_DUE_SOON";
  message: string;
  refreshExpiresAt: string;
  reconnectUrl: string;
}

export interface ToolResult<T> {
  data: T;
  meta: ToolMeta;
}

export interface PublicError {
  code: ErrorCode;
  message: string;
  requestId: string;
  attempts?: number;
  retryAfterMs?: number;
  reconnectUrl?: string;
}

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
  status: "connected" | "reauthorization_required";
  updatedAt: number;
  authorizationGeneration?: string | undefined;
  reminderSent?: boolean | undefined;
}

export interface VaultRequest {
  identity?: import("./security-store").ClientIdentity;
  base: "market" | "trader";
  path: string;
  query?: Record<string, string>;
  requestId: string;
  tool: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type TradeCondition =
  | { type: "ALL"; conditions: TradeCondition[] }
  | { type: "ANY"; conditions: TradeCondition[] }
  | { type: "NOT"; condition: TradeCondition }
  | { type: "TIME"; operator: "BEFORE" | "AT_OR_BEFORE" | "AFTER" | "AT_OR_AFTER"; at: string }
  | {
      type: "QUOTE";
      symbol: string;
      field: "askPrice" | "bidPrice" | "lastPrice" | "mark" | "netPercentChangeInDouble" | "totalVolume";
      operator: "LT" | "LTE" | "EQ" | "GTE" | "GT";
      value: number;
    };

export interface TradeProposalInput {
  accountHash: string;
  action: "PLACE" | "REPLACE";
  executionMode: "IMMEDIATE" | "DELAYED";
  orderId?: number;
  orderPayload: { [key: string]: JsonValue };
  userInstruction: string;
  condition?: TradeCondition;
  validUntil?: string;
  pollIntervalSeconds?: number;
  replacesTaskId?: string;
}
