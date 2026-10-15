import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";

export const READ_SCOPE = "schwab.read";

// Bump only when all MCP clients must complete fresh browser consent.
export const AUTHORIZATION_VERSION = "client-permissions-v1";

export type PermissionLevel = "read_only" | "full_access";

export interface AuthorizationProps {
  userId: string;
  username: string;
  permissionLevel: PermissionLevel;
  authorizationVersion: typeof AUTHORIZATION_VERSION;
  // Optional for existing access/refresh tokens; required for new code exchanges.
  pkceMethod?: "S256";
  clientId?: string;
  advancedSecurity?: boolean;
  securityPolicyVersion?: number;
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "read_only" || value === "full_access";
}

export function isCurrentAuthorization(value: unknown): value is AuthorizationProps {
  if (value === null || typeof value !== "object") return false;
  return Reflect.get(value, "authorizationVersion") === AUTHORIZATION_VERSION &&
    isPermissionLevel(Reflect.get(value, "permissionLevel")) &&
    typeof Reflect.get(value, "userId") === "string" &&
    typeof Reflect.get(value, "username") === "string" &&
    (Reflect.get(value, "advancedSecurity") === undefined || typeof Reflect.get(value, "advancedSecurity") === "boolean") &&
    (Reflect.get(value, "advancedSecurity") !== true ||
      (Reflect.get(value, "permissionLevel") === "full_access" && typeof Reflect.get(value, "clientId") === "string" && Number.isInteger(Reflect.get(value, "securityPolicyVersion"))));
}

export function validateTokenExchange({ props, grantType }: { props: unknown; grantType: GrantType }): void {
  if (!isCurrentAuthorization(props)) {
    throw new OAuthError("invalid_grant", { description: "MCP authorization expired; reconnect and select a permission level" });
  }
  if (grantType === GrantType.AUTHORIZATION_CODE && props.pkceMethod !== "S256") {
    throw new OAuthError("invalid_grant", { description: "S256 PKCE required; restart authorization" });
  }
}
