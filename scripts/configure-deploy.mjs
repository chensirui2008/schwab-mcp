import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

// These are public deployment settings. Worker secrets stay in Cloudflare.
const required = [
  "PROD_OAUTH_KV_ID", "PROD_ALLOWED_GITHUB_USER_ID",
  "PROD_GITHUB_CLIENT_ID", "PROD_SCHWAB_REDIRECT_URI",
];
for (const name of required) {
  if (!process.env[name]?.trim()) throw new Error(`Missing deployment variable: ${name}`);
}
if (!/^[a-f0-9]{32}$/i.test(process.env.PROD_OAUTH_KV_ID)) {
  throw new Error("Invalid PROD_OAUTH_KV_ID");
}
if (!/^\d+$/.test(process.env.PROD_ALLOWED_GITHUB_USER_ID)) {
  throw new Error("Invalid PROD_ALLOWED_GITHUB_USER_ID");
}
const redirect = new URL(process.env.PROD_SCHWAB_REDIRECT_URI);
if (redirect.protocol !== "https:" || redirect.pathname !== "/auth/schwab/callback") {
  throw new Error("Invalid PROD_SCHWAB_REDIRECT_URI");
}
const trading = process.env.PROD_ENABLE_TRADING || "false";
if (trading !== "true" && trading !== "false") throw new Error("Invalid PROD_ENABLE_TRADING");

const path = "wrangler.jsonc";
const config = JSON.parse(await readFile(path, "utf8"));
const kv = config.kv_namespaces.find((binding) => binding.binding === "OAUTH_KV");
if (!kv) throw new Error("Missing OAUTH_KV binding");
kv.id = process.env.PROD_OAUTH_KV_ID;
Object.assign(config.vars, {
  GITHUB_CLIENT_ID: process.env.PROD_GITHUB_CLIENT_ID,
  ALLOWED_GITHUB_USER_ID: process.env.PROD_ALLOWED_GITHUB_USER_ID,
  SCHWAB_REDIRECT_URI: process.env.PROD_SCHWAB_REDIRECT_URI,
  ENABLE_TRADING: trading,
});
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
