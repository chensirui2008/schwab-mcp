import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AppEnv {
  ACCEPTANCE_KV?: KVNamespace;
  ACCEPTANCE_VAULT?: DurableObjectNamespace;
  ACCEPTANCE_KEY?: string;
  acceptanceGitHub?: { url: string; fetch: typeof fetch };
  BROWSER_AUTH_RATE_LIMITER?: RateLimit | undefined;
  ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER?: RateLimit | undefined;
  OWNER_ALERT_EMAIL?: SendEmail | undefined;
  EMAIL_ALERTS_ENABLED?: string | undefined;
  ALERT_EMAIL_FROM?: string | undefined;
  ALERT_EMAIL_TO?: string | undefined;
  OAUTH_KV: KVNamespace;
  SCHWAB_VAULT: DurableObjectNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_USER_ID: string;
  SCHWAB_CLIENT_ID: string;
  SCHWAB_CLIENT_SECRET: string;
  SCHWAB_REDIRECT_URI: string;
  MARKET_DATA_BASE_URL: string;
  TRADER_BASE_URL: string;
  ENABLE_TRADING: string;
  APP_VERSION: string;
}

export function tradingEnabled(env: AppEnv): boolean {
  return env.ENABLE_TRADING === "true";
}

export function vaultStub(env: AppEnv): DurableObjectStub {
  return env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.idFromName("owner"));
}
