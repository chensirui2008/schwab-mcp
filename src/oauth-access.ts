import type { AppEnv } from "./env";

export const READ_SCOPE = "schwab.read";
export const TRADE_SCOPE = "schwab.trade";
export const OAUTH_AUTHORIZATION_VERSION = 1;

export interface OAuthGrantProps {
  userId: string;
  username: string;
  authorizationVersion?: number;
}

export interface McpAccess {
  canTrade: boolean;
}

export function grantedScopes(requestedScopes: string[]): string[] {
  return [READ_SCOPE, ...(requestedScopes.includes(TRADE_SCOPE) ? [TRADE_SCOPE] : [])];
}

interface AuthorizationToken {
  grant?: {
    scope?: unknown;
    props?: unknown;
  };
}

export function isTradeAuthorized(token: AuthorizationToken | null): boolean {
  const grant = token?.grant;
  if (!grant || !Array.isArray(grant.scope) || !grant.scope.includes(TRADE_SCOPE)) return false;
  const props = grant.props;
  return props !== null && typeof props === "object" && Reflect.get(props, "authorizationVersion") === OAUTH_AUTHORIZATION_VERSION;
}

export async function resolveMcpAccess(request: Request, env: AppEnv): Promise<McpAccess> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/i);
  if (!match?.[1]) return { canTrade: false };

  const token = await env.OAUTH_PROVIDER.unwrapToken<OAuthGrantProps>(match[1]);
  return { canTrade: isTradeAuthorized(token) };
}
