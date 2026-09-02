import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { retryAfterDelay } from "../src/vault";

function stub(): DurableObjectStub {
  const appEnv = env as unknown as AppEnv;
  return appEnv.SCHWAB_VAULT.get(appEnv.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
}

async function saveToken(vault: DurableObjectStub): Promise<void> {
  const response = await vault.fetch("https://vault/token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "old-access", refresh_token: "old-refresh", expires_in: 1800 }),
  });
  expect(response.status).toBe(204);
}

async function refreshExpiry(vault: DurableObjectStub): Promise<number> {
  const value: unknown = await (await vault.fetch("https://vault/status")).json();
  const expiresAt = value !== null && typeof value === "object" ? Reflect.get(value, "refreshExpiresAt") as unknown : undefined;
  if (typeof expiresAt !== "number") throw new Error("Missing refresh expiry in test status");
  return expiresAt;
}

function proxy(vault: DurableObjectStub, requestId = crypto.randomUUID()): Promise<Response> {
  return vault.fetch("https://vault/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base: "market", path: "/quotes", query: { symbols: "AAPL" }, requestId, tool: "get_quotes" }),
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

afterEach(() => vi.unstubAllGlobals());

describe("SchwabVault upstream behavior", () => {
  it("preserves the configured API base path", async () => {
    const vault = stub();
    await saveToken(vault);
    let requestedUrl = "";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      requestedUrl = requestUrl(input);
      return Response.json({ ok: true });
    }));

    expect((await proxy(vault)).status).toBe(200);
    expect(requestedUrl).toBe("https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL");
  });

  it("coalesces concurrent refreshes into one token rotation", async () => {
    const vault = stub();
    await saveToken(vault);
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).endsWith("/v1/oauth/token")) {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer old-access"
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ ok: true });
    }));

    const [first, second] = await Promise.all([proxy(vault), proxy(vault)]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(refreshCalls).toBe(1);
  });

  it("refreshes once after a 401 and atomically uses the rotated token", async () => {
    const vault = stub();
    await saveToken(vault);
    const before = await refreshExpiry(vault);
    let apiCalls = 0;
    let refreshCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/oauth/token")) {
        refreshCalls += 1;
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
      }
      apiCalls += 1;
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer old-access"
        ? Response.json({ error: "expired" }, { status: 401 })
        : Response.json({ symbol: "AAPL" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await proxy(vault);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { symbol: "AAPL" }, attempts: 2 });
    expect(apiCalls).toBe(2);
    expect(refreshCalls).toBe(1);
    const after = await refreshExpiry(vault);
    expect(after).toBe(before);
  });

  it.each([429, 500, 503])("retries HTTP %i only once", async (status) => {
    const vault = stub();
    await saveToken(vault);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      return Response.json({ error: "temporary" }, { status, headers: { "Retry-After": "0" } });
    }));

    const response = await proxy(vault);
    expect(calls).toBe(2);
    expect(response.status).toBe(status === 429 ? 429 : 502);
    expect(await response.json()).toMatchObject({ error: { attempts: 2 } });
  });

  it("does not retry before a long Retry-After delay", async () => {
    const vault = stub();
    await saveToken(vault);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      calls += 1;
      return Response.json({ error: "limited" }, { status: 429, headers: { "Retry-After": "10" } });
    }));

    const response = await proxy(vault);
    expect(calls).toBe(1);
    expect(await response.json()).toMatchObject({ error: { code: "RATE_LIMITED", attempts: 1, retryAfterMs: 10_000 } });
  });

  it("marks invalid_grant as requiring reauthorization", async () => {
    const vault = stub();
    await saveToken(vault);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (requestUrl(input).endsWith("/v1/oauth/token")) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ error: "expired" }, { status: 401 });
    }));

    const response = await proxy(vault);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "REAUTHORIZATION_REQUIRED", attempts: 2 } });
    expect(await (await vault.fetch("https://vault/status")).json()).toMatchObject({ status: "reauthorization_required" });
  });
});

describe("Retry-After parsing", () => {
  it("supports delta seconds and HTTP dates", () => {
    expect(retryAfterDelay("2", 0)).toBe(2000);
    expect(retryAfterDelay("Thu, 01 Jan 1970 00:00:03 GMT", 1000)).toBe(2000);
    expect(retryAfterDelay("invalid", 0)).toBe(0);
  });
});
