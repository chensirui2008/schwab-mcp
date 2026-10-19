import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";
import { z } from "zod";

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
let redirect;
try {
  redirect = new URL(process.env.PROD_SCHWAB_REDIRECT_URI);
} catch {
  throw new Error("Invalid PROD_SCHWAB_REDIRECT_URI");
}
if (redirect.protocol !== "https:" || redirect.pathname !== "/auth/schwab/callback") {
  throw new Error("Invalid PROD_SCHWAB_REDIRECT_URI");
}
const trading = process.env.PROD_ENABLE_TRADING || "false";
if (trading !== "true" && trading !== "false") throw new Error("Invalid PROD_ENABLE_TRADING");
const emailEnabled = process.env.PROD_EMAIL_ALERTS_ENABLED || "false";
if (emailEnabled !== "true" && emailEnabled !== "false") {
  throw new Error("Invalid PROD_EMAIL_ALERTS_ENABLED");
}
const sender = process.env.PROD_ALERT_EMAIL_FROM || undefined;
const recipient = process.env.PROD_ALERT_EMAIL_TO || undefined;
const validAddress = (address) => !/[\r\n]/.test(address) && z.email().safeParse(address).success;
if ((sender && !validAddress(sender)) || (recipient && !validAddress(recipient))) {
  throw new Error("Invalid deployment email address");
}
if (Boolean(sender) !== Boolean(recipient) || (emailEnabled === "true" && !sender)) {
  throw new Error("Incomplete deployment email configuration");
}

const path = "wrangler.jsonc";
const config = JSON.parse(await readFile(path, "utf8"));
const kv = config.kv_namespaces.find((binding) => binding.binding === "OAUTH_KV");
if (!kv) throw new Error("Missing OAUTH_KV binding");
const limiterSettings = [
  ["BROWSER_AUTH_RATE_LIMITER", "PROD_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID"],
  ["ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER", "PROD_ACCEPTANCE_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID"],
].map(([name, variable]) => {
  const bindings = config.ratelimits?.filter((binding) => binding.name === name) ?? [];
  if (bindings.length !== 1) throw new Error(`Expected one ${name} binding`);
  const namespaceId = process.env[variable] || bindings[0].namespace_id;
  if (typeof namespaceId !== "string" || !/^[1-9]\d*$/.test(namespaceId)) {
    throw new Error(`Invalid ${variable}`);
  }
  return { binding: bindings[0], namespaceId };
});
if (limiterSettings[0].namespaceId === limiterSettings[1].namespaceId) {
  throw new Error("Browser authorization rate limiter namespaces must differ");
}
for (const { binding, namespaceId } of limiterSettings) binding.namespace_id = namespaceId;
kv.id = process.env.PROD_OAUTH_KV_ID;
Object.assign(config.vars, {
  GITHUB_CLIENT_ID: process.env.PROD_GITHUB_CLIENT_ID,
  ALLOWED_GITHUB_USER_ID: process.env.PROD_ALLOWED_GITHUB_USER_ID,
  SCHWAB_REDIRECT_URI: process.env.PROD_SCHWAB_REDIRECT_URI,
  ENABLE_TRADING: trading,
});
const otherEmailBindings = (config.send_email ?? []).filter((binding) => binding.name !== "OWNER_ALERT_EMAIL");
if (sender && recipient) {
  config.send_email = [
    ...otherEmailBindings,
    { name: "OWNER_ALERT_EMAIL", destination_address: recipient },
  ];
  Object.assign(config.vars, {
    EMAIL_ALERTS_ENABLED: emailEnabled,
    ALERT_EMAIL_FROM: sender,
    ALERT_EMAIL_TO: recipient,
  });
} else {
  if (otherEmailBindings.length) config.send_email = otherEmailBindings;
  else delete config.send_email;
  delete config.vars.EMAIL_ALERTS_ENABLED;
  delete config.vars.ALERT_EMAIL_FROM;
  delete config.vars.ALERT_EMAIL_TO;
}
await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
