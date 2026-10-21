import { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./env";
import { vaultStub } from "./env";
import { accountSelectionSchema } from "./account-access";
import type { ClientPolicy } from "./security-store";

export const READ_SCOPE = "schwab.read";

// Bump only when all MCP clients must complete fresh browser consent.
export const AUTHORIZATION_VERSION = "client-accounts-v2";

export type PermissionLevel = "read_only" | "full_access";

export interface AuthorizationProps {
  userId: string;
  username: string;
  permissionLevel: PermissionLevel;
  authorizationVersion: typeof AUTHORIZATION_VERSION;
  // Optional for existing access/refresh tokens; required for new code exchanges.
  pkceMethod?: "S256";
  allowedAccountHashes: string[];
  clientId?: string;
  advancedSecurity?: boolean;
  securityPolicyVersion?: number;
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "read_only" || value === "full_access";
}

export function isCurrentAuthorization(value: unknown): value is AuthorizationProps {
  if (value === null || typeof value !== "object") return false;
  const clientId: unknown = Reflect.get(value, "clientId");
  const advancedSecurity: unknown = Reflect.get(value, "advancedSecurity");
  const version: unknown = Reflect.get(value, "securityPolicyVersion");
  return Reflect.get(value, "authorizationVersion") === AUTHORIZATION_VERSION &&
    accountSelectionSchema.safeParse(Reflect.get(value, "allowedAccountHashes")).success &&
    isPermissionLevel(Reflect.get(value, "permissionLevel")) &&
    typeof Reflect.get(value, "userId") === "string" &&
    typeof Reflect.get(value, "username") === "string" &&
    (clientId === undefined || (typeof clientId === "string" && clientId.length > 0)) &&
    (advancedSecurity === undefined || typeof advancedSecurity === "boolean") &&
    (version === undefined || (typeof version === "number" && Number.isSafeInteger(version) && version >= 0)) &&
    (advancedSecurity !== true || (typeof clientId === "string" && version !== undefined));
}

function isClientPolicy(value: unknown, clientId: string): value is ClientPolicy {
  if (value === null || typeof value !== "object") return false;
  const version: unknown = Reflect.get(value, "version");
  const updatedAt: unknown = Reflect.get(value, "updatedAt");
  return Reflect.get(value, "clientId") === clientId &&
    isPermissionLevel(Reflect.get(value, "permissionLevel")) &&
    typeof Reflect.get(value, "advancedSecurity") === "boolean" &&
    typeof Reflect.get(value, "revoked") === "boolean" &&
    typeof version === "number" && Number.isSafeInteger(version) && version >= 0 &&
    typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0;
}

// Only trusted, current grant props may initialize a missing policy; existing
// policies (including revocation tombstones) always win over token snapshots.
export async function resolveClientPolicy(env: AppEnv, clientId: string, props: AuthorizationProps): Promise<ClientPolicy> {
  const url = new URL("https://vault/client/policy");
  url.searchParams.set("clientId", clientId);
  url.searchParams.set("ensure", "true");
  url.searchParams.set("permissionLevel", props.permissionLevel);
  url.searchParams.set("advancedSecurity", String(props.advancedSecurity ?? false));
  url.searchParams.set("version", String(props.securityPolicyVersion ?? 0));
  try {
    const response = await vaultStub(env).fetch(url.href);
    if (!response.ok) throw new Error("Client policy lookup failed");
    const policy: unknown = await response.json();
    if (!isClientPolicy(policy, clientId)) throw new Error("Invalid client policy envelope");
    return policy;
  } catch {
    const requestId = crypto.randomUUID();
    console.error(JSON.stringify({ event: "client_policy_unavailable", requestId }));
    throw new OAuthError("temporarily_unavailable", {
      description: "Client policy is unavailable; retry later",
      statusCode: 503,
    });
  }
}

export interface TokenExchangeOptions {
  grantType: GrantType;
  props: unknown;
  clientId?: string;
}

export async function validateTokenExchange(
  options: TokenExchangeOptions,
  env: AppEnv,
): Promise<{ newProps: AuthorizationProps }> {
  const { props, grantType, clientId } = options;
  if (!isCurrentAuthorization(props)) {
    throw new OAuthError("invalid_grant", { description: "MCP authorization expired; reconnect and select a permission level" });
  }
  if (grantType === GrantType.AUTHORIZATION_CODE && props.pkceMethod !== "S256") {
    throw new OAuthError("invalid_grant", { description: "S256 PKCE required; restart authorization" });
  }
  if (props.userId !== env.ALLOWED_GITHUB_USER_ID || !clientId ||
      (props.clientId !== undefined && props.clientId !== clientId)) {
    throw new OAuthError("invalid_grant", { description: "Client authorization identity mismatch" });
  }
  const policy = await resolveClientPolicy(env, clientId, props);
  if (policy.revoked) {
    throw new OAuthError("invalid_grant", { description: "Client authorization revoked" });
  }
  return {
    newProps: {
      ...props,
      clientId,
      permissionLevel: policy.permissionLevel,
      advancedSecurity: policy.advancedSecurity,
      securityPolicyVersion: policy.version,
    },
  };
}
