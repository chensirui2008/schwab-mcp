import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./configure-deploy.mjs", import.meta.url));
const template = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const settings = {
  PROD_OAUTH_KV_ID: "a".repeat(32),
  PROD_ALLOWED_GITHUB_USER_ID: "123456",
  PROD_GITHUB_CLIENT_ID: 'test-client"|$value',
  PROD_SCHWAB_REDIRECT_URI: "https://example.com/auth/schwab/callback",
};

async function run(env, check, input = template) {
  const cwd = await mkdtemp(join(tmpdir(), "schwab-deploy-test-"));
  try {
    await writeFile(join(cwd, "wrangler.jsonc"), input);
    const result = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8" });
    await check(result, await readFile(join(cwd, "wrangler.jsonc"), "utf8"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("injects public settings with trading off by default and preserves bindings and secret declarations", async () => {
  for (const trading of [undefined, "true"]) {
    await run({ ...settings, ...(trading ? { PROD_ENABLE_TRADING: trading } : {}) }, (result, text) => {
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(text);
      const original = JSON.parse(template);
      assert.equal(actual.kv_namespaces[0].id, settings.PROD_OAUTH_KV_ID);
      assert.equal(actual.vars.GITHUB_CLIENT_ID, settings.PROD_GITHUB_CLIENT_ID);
      assert.equal(actual.vars.ALLOWED_GITHUB_USER_ID, settings.PROD_ALLOWED_GITHUB_USER_ID);
      assert.equal(actual.vars.SCHWAB_REDIRECT_URI, settings.PROD_SCHWAB_REDIRECT_URI);
      assert.equal(actual.vars.ENABLE_TRADING, trading || "false");
      assert.deepEqual(actual.secrets, original.secrets);
      assert.deepEqual(actual.durable_objects, original.durable_objects);
      assert.deepEqual(actual.migrations, original.migrations);
      assert.deepEqual(actual.assets, original.assets);
      assert.deepEqual(actual.ratelimits, original.ratelimits);
      assert.deepEqual(actual.kv_namespaces.slice(1), original.kv_namespaces.slice(1));
      assert.equal(actual.workers_dev, original.workers_dev);
    });
  }
});

test("fails before writing when deployment settings are missing or invalid", async () => {
  const invalid = [
    ...Object.keys(settings).map((key) => ({ ...settings, [key]: "" })),
    { ...settings, PROD_OAUTH_KV_ID: "replace-with-your-kv-namespace-id" },
    { ...settings, PROD_ALLOWED_GITHUB_USER_ID: "not-numeric" },
    { ...settings, PROD_SCHWAB_REDIRECT_URI: "http://example.com/auth/schwab/callback" },
    { ...settings, PROD_SCHWAB_REDIRECT_URI: "private-invalid-redirect" },
    { ...settings, PROD_ENABLE_TRADING: "TRUE" },
  ];
  for (const env of invalid) {
    await run(env, (result, text) => {
      assert.notEqual(result.status, 0);
      assert.equal(text, template);
    });
  }
});

const emailSettings = {
  PROD_ALERT_EMAIL_FROM: "alerts@example.com",
  PROD_ALERT_EMAIL_TO: "owner@example.net",
};

test("keeps a restricted test email binding with business mail disabled and preserves other resources", async () => {
  const original = JSON.parse(template);
  original.send_email = [
    { name: "OTHER_EMAIL", allowed_destination_addresses: ["other@example.org"] },
    { name: "OWNER_ALERT_EMAIL", destination_address: "old@example.org" },
  ];
  original.ratelimits.reverse();
  original.ratelimits.push({ name: "OTHER_LIMITER", namespace_id: "99", simple: { limit: 1, period: 60 } });
  for (const enabled of [undefined, "false", "true"]) {
    await run({
      ...settings,
      ...emailSettings,
      ...(enabled ? { PROD_EMAIL_ALERTS_ENABLED: enabled } : {}),
      PROD_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: "123",
      PROD_ACCEPTANCE_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: "456",
    }, (result, text) => {
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(text);
      assert.deepEqual(actual.send_email, [
        original.send_email[0],
        { name: "OWNER_ALERT_EMAIL", destination_address: emailSettings.PROD_ALERT_EMAIL_TO },
      ]);
      assert.equal(actual.vars.EMAIL_ALERTS_ENABLED, enabled || "false");
      assert.equal(actual.vars.ALERT_EMAIL_FROM, emailSettings.PROD_ALERT_EMAIL_FROM);
      assert.equal(actual.vars.ALERT_EMAIL_TO, emailSettings.PROD_ALERT_EMAIL_TO);
      assert.deepEqual(actual.ratelimits, original.ratelimits.map((binding) => ({
        ...binding,
        namespace_id: binding.name === "BROWSER_AUTH_RATE_LIMITER" ? "123"
          : binding.name === "ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER" ? "456" : binding.namespace_id,
      })));
      for (const key of ["secrets", "durable_objects", "migrations", "assets", "workers_dev"]) {
        assert.deepEqual(actual[key], original[key]);
      }
      assert.equal(actual.vars.ENABLE_TRADING, "false");
      assert.equal(result.stdout.includes(emailSettings.PROD_ALERT_EMAIL_TO), false);
    }, JSON.stringify(original));
  }
});

test("removes stale owner email configuration when addresses are absent and preserves unrelated email bindings", async () => {
  for (const others of [[], [{ name: "OTHER_EMAIL", destination_address: "other@example.org" }]]) {
    const original = JSON.parse(template);
    original.send_email = [...others, { name: "OWNER_ALERT_EMAIL", destination_address: "old@example.org" }];
    Object.assign(original.vars, { EMAIL_ALERTS_ENABLED: "true", ALERT_EMAIL_FROM: "old@example.com", ALERT_EMAIL_TO: "old@example.org" });
    await run({ ...settings, PROD_EMAIL_ALERTS_ENABLED: "false" }, (result, text) => {
      assert.equal(result.status, 0, result.stderr);
      const actual = JSON.parse(text);
      assert.deepEqual(actual.send_email, others.length ? others : undefined);
      for (const key of ["EMAIL_ALERTS_ENABLED", "ALERT_EMAIL_FROM", "ALERT_EMAIL_TO"]) {
        assert.equal(Object.hasOwn(actual.vars, key), false);
      }
      assert.deepEqual(actual.ratelimits, original.ratelimits);
    }, JSON.stringify(original));
  }
});

test("rejects invalid email and namespace inputs without writing or disclosing values", async () => {
  const invalid = [
    { PROD_EMAIL_ALERTS_ENABLED: "TRUE" },
    { PROD_EMAIL_ALERTS_ENABLED: " false " },
    { PROD_EMAIL_ALERTS_ENABLED: "true" },
    { PROD_ALERT_EMAIL_FROM: emailSettings.PROD_ALERT_EMAIL_FROM },
    { PROD_ALERT_EMAIL_TO: emailSettings.PROD_ALERT_EMAIL_TO },
    { ...emailSettings, PROD_ALERT_EMAIL_FROM: "private-invalid-sender" },
    { ...emailSettings, PROD_ALERT_EMAIL_TO: "private-invalid-recipient" },
    { ...emailSettings, PROD_ALERT_EMAIL_FROM: "alerts@example.com\r\nBcc: hidden@example.org" },
    { ...emailSettings, PROD_ALERT_EMAIL_TO: "owner@example.net\n" },
    { ...emailSettings, PROD_ALERT_EMAIL_FROM: " alerts@example.com" },
    ...["0", "-1", "1.5", "01", " 12", "private-invalid-namespace"].flatMap((value) => [
      { PROD_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: value },
      { PROD_ACCEPTANCE_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: value },
    ]),
    { PROD_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: "123", PROD_ACCEPTANCE_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: "123" },
    { PROD_BROWSER_AUTH_RATE_LIMIT_NAMESPACE_ID: "2026101902" },
  ];
  for (const overrides of invalid) {
    await run({ ...settings, ...overrides }, (result, text) => {
      assert.notEqual(result.status, 0);
      assert.equal(text, template);
      const output = result.stdout + result.stderr;
      for (const value of Object.values(emailSettings)) assert.equal(output.includes(value), false);
      for (const value of ["private-invalid-sender", "private-invalid-recipient", "private-invalid-namespace", "hidden@example.org"]) {
        assert.equal(output.includes(value), false);
      }
    });
  }
});

test("requires uniquely named limiter bindings and validates template namespace defaults before writing", async () => {
  const original = JSON.parse(template);
  const variants = [];
  for (const name of ["BROWSER_AUTH_RATE_LIMITER", "ACCEPTANCE_BROWSER_AUTH_RATE_LIMITER"]) {
    const missing = globalThis.structuredClone(original);
    missing.ratelimits = missing.ratelimits.filter((binding) => binding.name !== name);
    missing.ratelimits.push({ name: "UNRECOGNIZED_LIMITER", namespace_id: "123", simple: { limit: 30, period: 60 } });
    variants.push(missing);
    const duplicate = globalThis.structuredClone(original);
    duplicate.ratelimits.push(globalThis.structuredClone(duplicate.ratelimits.find((binding) => binding.name === name)));
    variants.push(duplicate);
  }
  const absent = globalThis.structuredClone(original);
  delete absent.ratelimits;
  variants.push(absent);
  const invalidDefault = globalThis.structuredClone(original);
  invalidDefault.ratelimits[0].namespace_id = "0";
  variants.push(invalidDefault);
  const sameDefaults = globalThis.structuredClone(original);
  sameDefaults.ratelimits[0].namespace_id = sameDefaults.ratelimits[1].namespace_id;
  variants.push(sameDefaults);
  for (const config of variants) {
    const input = JSON.stringify(config);
    await run(settings, (result, text) => {
      assert.notEqual(result.status, 0);
      assert.equal(text, input);
    }, input);
  }
});
