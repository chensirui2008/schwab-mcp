import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";

function stub(): DurableObjectStub {
  const appEnv = env as unknown as AppEnv;
  return appEnv.SCHWAB_VAULT.get(appEnv.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
}

describe("SchwabVault OAuth state", () => {
  it("consumes state exactly once", async () => {
    const vault = stub();
    const state = crypto.randomUUID();
    const saved = await vault.fetch("https://vault/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test", payload: { value: 42 }, expiresAt: Date.now() + 60_000 }),
    });
    expect(saved.status).toBe(204);

    const first = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test" }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ payload: { value: 42 } });

    const second = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "test" }),
    });
    expect(second.status).toBe(400);
  });

  it("rejects expired and mismatched state", async () => {
    const vault = stub();
    const state = crypto.randomUUID();
    await vault.fetch("https://vault/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "expected", payload: {}, expiresAt: Date.now() - 1 }),
    });
    const response = await vault.fetch("https://vault/state/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, kind: "wrong" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("SchwabVault token status", () => {
  it("stores token data without returning credentials from status", async () => {
    const vault = stub();
    const saved = await vault.fetch("https://vault/token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 1800 }),
    });
    expect(saved.status).toBe(204);
    const response = await vault.fetch("https://vault/status");
    const text = await response.text();
    expect(text).toContain('"connected":true');
    expect(text).not.toContain("access-secret");
    expect(text).not.toContain("refresh-secret");
  });
});
