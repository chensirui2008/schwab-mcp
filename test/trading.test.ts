import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";

function stub(): DurableObjectStub {
  const appEnv = env as unknown as AppEnv;
  return appEnv.SCHWAB_VAULT.get(appEnv.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

async function saveToken(vault: DurableObjectStub): Promise<void> {
  const response = await vault.fetch("https://vault/token", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ access_token: "trade-access", refresh_token: "trade-refresh", expires_in: 1800 }),
  });
  expect(response.status).toBe(204);
}

const orderPayload = {
  orderType: "LIMIT",
  session: "NORMAL",
  duration: "DAY",
  price: "100.00",
  orderStrategyType: "SINGLE",
  orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }],
};

async function prepare(vault: DurableObjectStub, overrides: Record<string, unknown> = {}) {
  const response = await vault.fetch("https://vault/trade/prepare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: crypto.randomUUID(),
      input: {
        accountHash: "a".repeat(32),
        action: "PLACE",
        executionMode: "IMMEDIATE",
        orderPayload,
        userInstruction: "Buy one AAPL share",
        ...overrides,
      },
    }),
  });
  expect(response.status).toBe(200);
  const payload = await response.json<{ result: { proposalId: string; confirmationToken: string; confirmationText: string } }>();
  return payload.result;
}

async function confirm(vault: DurableObjectStub, proposal: Awaited<ReturnType<typeof prepare>>): Promise<Response> {
  return vault.fetch("https://vault/trade/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: crypto.randomUUID(), input: proposal }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("trade confirmation state machine", () => {
  it("does not place until exact one-time confirmation and cannot consume twice", async () => {
    const vault = stub();
    await saveToken(vault);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Response>(() =>
      new Response(null, { status: 201, headers: { Location: "/trader/v1/accounts/hash/orders/12345" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(fetchMock).not.toHaveBeenCalled();

    const bad = await confirm(vault, { ...proposal, confirmationText: "确认" });
    expect(bad.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();

    const executed = await confirm(vault, proposal);
    expect(executed.status).toBe(200);
    expect(await executed.json()).toMatchObject({ result: { status: "accepted", orderId: 12345 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });

    const replay = await confirm(vault, proposal);
    expect(replay.status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous mutation failure", async () => {
    const vault = stub();
    await saveToken(vault);
    const fetchMock = vi.fn(() => Response.json({ error: "temporary" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await confirm(vault, await prepare(vault));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "EXECUTION_UNCERTAIN", attempts: 1 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects sensitive fields embedded in official order JSON", async () => {
    const vault = stub();
    const response = await vault.fetch("https://vault/trade/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        input: {
          accountHash: "a".repeat(32),
          action: "PLACE",
          executionMode: "IMMEDIATE",
          orderPayload: { ...orderPayload, accountNumber: "12345678" },
          userInstruction: "Buy one AAPL share",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENT" } });
  });

  it("allows an explicit cancellation without a confirmation proposal", async () => {
    const vault = stub();
    await saveToken(vault);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Response>(() => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await vault.fetch("https://vault/trade/cancel-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        input: { accountHash: "a".repeat(32), orderId: 42, userInstruction: "Cancel order 42" },
      }),
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("activates a delayed trade and executes it from an alarm without another confirmation", async () => {
    const vault = stub();
    await saveToken(vault);
    const fetchMock = vi.fn(() => new Response(null, { status: 201, headers: { Location: "/trader/v1/accounts/hash/orders/777" } }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault, {
      executionMode: "DELAYED",
      condition: { type: "TIME", operator: "AT_OR_BEFORE", at: new Date(Date.now() + 60_000).toISOString() },
      validUntil: new Date(Date.now() + 120_000).toISOString(),
      pollIntervalSeconds: 15,
    });
    const activated = await confirm(vault, proposal);
    expect(activated.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();

    expect(await runDurableObjectAlarm(vault)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const listed = await vault.fetch("https://vault/trade/list-delayed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), input: {} }),
    });
    expect(await listed.json()).toMatchObject({ result: [{ status: "EXECUTED", outcome: { result: { orderId: 777 } } }] });
  });

  it("evaluates a frozen Schwab quote condition before execution", async () => {
    const vault = stub();
    await saveToken(vault);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return Response.json({ AAPL: { quote: { lastPrice: 99.5 } } });
      return new Response(null, { status: 201, headers: { Location: "/trader/v1/accounts/hash/orders/888" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault, {
      executionMode: "DELAYED",
      condition: { type: "QUOTE", symbol: "AAPL", field: "lastPrice", operator: "LTE", value: 100 },
      validUntil: new Date(Date.now() + 120_000).toISOString(),
      pollIntervalSeconds: 15,
    });
    expect((await confirm(vault, proposal)).status).toBe(200);
    expect(await runDurableObjectAlarm(vault)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toContain("/quotes?symbols=AAPL&fields=quote");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });
});
