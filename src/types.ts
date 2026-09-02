export type ErrorCode =
  | "AUTH_REQUIRED"
  | "REAUTHORIZATION_REQUIRED"
  | "INVALID_ARGUMENT"
  | "RATE_LIMITED"
  | "SCHWAB_REJECTED"
  | "UPSTREAM_UNAVAILABLE";

export interface ToolMeta {
  source: "schwab";
  fetchedAt: string;
  requestId: string;
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
}

export interface VaultRequest {
  base: "market" | "trader";
  path: string;
  query?: Record<string, string>;
  requestId: string;
  tool: string;
}
