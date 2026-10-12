import { OAuthError } from "@cloudflare/workers-oauth-provider";

export const READ_SCOPE = "schwab.read";

// Bump only when all MCP clients must complete fresh browser consent.
export const AUTHORIZATION_VERSION = "client-permissions-v1";

export type PermissionLevel = "read_only" | "full_access";

export interface AuthorizationProps {
  userId: string;
  username: string;
  permissionLevel: PermissionLevel;
  authorizationVersion: typeof AUTHORIZATION_VERSION;
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "read_only" || value === "full_access";
}

export function isCurrentAuthorization(value: unknown): value is AuthorizationProps {
  if (value === null || typeof value !== "object") return false;
  return Reflect.get(value, "authorizationVersion") === AUTHORIZATION_VERSION &&
    isPermissionLevel(Reflect.get(value, "permissionLevel")) &&
    typeof Reflect.get(value, "userId") === "string" &&
    typeof Reflect.get(value, "username") === "string";
}

export function validateTokenExchange({ props }: { props: unknown }): void {
  if (!isCurrentAuthorization(props)) {
    throw new OAuthError("invalid_grant", { description: "MCP authorization expired; reconnect and select a permission level" });
  }
}
