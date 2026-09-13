import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface AppEnv {
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
