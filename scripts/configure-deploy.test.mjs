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

async function run(env, check) {
  const cwd = await mkdtemp(join(tmpdir(), "schwab-deploy-test-"));
  try {
    await writeFile(join(cwd, "wrangler.jsonc"), template);
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
    });
  }
});

test("fails before writing when deployment settings are missing or invalid", async () => {
  const invalid = [
    ...Object.keys(settings).map((key) => ({ ...settings, [key]: "" })),
    { ...settings, PROD_OAUTH_KV_ID: "replace-with-your-kv-namespace-id" },
    { ...settings, PROD_ALLOWED_GITHUB_USER_ID: "not-numeric" },
    { ...settings, PROD_SCHWAB_REDIRECT_URI: "http://example.com/auth/schwab/callback" },
    { ...settings, PROD_ENABLE_TRADING: "TRUE" },
  ];
  for (const env of invalid) {
    await run(env, (result, text) => {
      assert.notEqual(result.status, 0);
      assert.equal(text, template);
    });
  }
});
