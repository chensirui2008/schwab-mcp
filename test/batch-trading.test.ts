import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { toolSchemas } from "../src/schemas";

const identity = { clientId: "batch-client", advancedSecurity: false, securityPolicyVersion: 0 };
const accountHash = "a".repeat(32);
const orderPayload = { orderStrategyType: "SINGLE", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }] };
const orders = [{ action: "PLACE", orderPayload }, { action: "REPLACE", orderId: 42, orderPayload }, { action: "PLACE", orderPayload }];
type Confirmation = { proposalId: string; confirmationToken: string; confirmationText: string };

async function setup() {
  const app = env as unknown as AppEnv;
  const vault = app.SCHWAB_VAULT.get(app.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
  await (await vault.fetch("https://vault/client/policy?clientId=batch-client&ensure=true&permissionLevel=full_access&advancedSecurity=false&version=0")).text();
  await runInDurableObject(vault, (_instance, state) => { state.storage.sql.exec("INSERT OR REPLACE INTO client_accounts (client_id, hashes) VALUES (?, ?)", identity.clientId, JSON.stringify([accountHash])); });
  await vault.fetch("https://vault/token", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, access_token: "access", refresh_token: "refresh", expires_in: 1800 }) });
  return vault;
}

function call(vault: DurableObjectStub, path: string, input: unknown, client = identity) {
  return vault.fetch(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity: client, requestId: crypto.randomUUID(), input }) });
}
function direct(instance: { fetch?(request: Request): Response | Promise<Response> }, path: string, input: unknown) {
  if (!instance.fetch) throw new Error("Expected a fetch-capable vault");
  return Promise.resolve(instance.fetch(new Request(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ identity, requestId: crypto.randomUUID(), input }) })));
}
async function prepare(vault: DurableObjectStub, inputOrders = orders) {
  const response = await call(vault, "/trade/prepare-batch", { accountHash, orders: inputOrders, userInstruction: "Submit these orders" });
  expect(response.status).toBe(200);
  const { result } = await response.json<{ result: Confirmation }>();
  return { proposalId: result.proposalId, confirmationToken: result.confirmationToken, confirmationText: result.confirmationText };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("batch trade proposals", () => {
  it("validates strict shapes, order bounds, action constraints and aggregate UTF-8 size", () => {
    const input = { accountHash, orders, userInstruction: "Submit" };
    expect(toolSchemas.prepareTradeBatch.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, extra: true }, { ...input, orders: [] }, { ...input, orders: Array(21).fill(orders[0]) },
      { ...input, orders: [{ ...orders[0], orderId: 1 }] }, { ...input, orders: [{ ...orders[1], orderId: undefined }] },
      { ...input, orders: [{ ...orders[0], extra: true }] },
      { ...input, orders: Array(20).fill({ action: "PLACE", orderPayload: { ...orderPayload, note: "界".repeat(5000) } }) },
    ]) expect(toolSchemas.prepareTradeBatch.safeParse(invalid).success).toBe(false);
  });

  it("rejects unsafe order input before storing a proposal or calling Schwab", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await call(vault, "/trade/prepare-batch", { accountHash, orders: [orders[0], { action: "PLACE", orderPayload: { ...orderPayload, accountNumber: "123456" } }], userInstruction: "Submit" });
    expect(response.status).toBe(400);
    const count = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM trade_proposal").one().count);
    expect(count).toBe(0); expect(fetchMock).not.toHaveBeenCalled();
  });

  it("freezes ordered PLACE and REPLACE, continues definite rejection, and prevents replay", async () => {
    const vault = await setup();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Response>()
      .mockImplementationOnce(() => new Response(null, { status: 201 }))
      .mockImplementationOnce(() => new Response(null, { status: 400 }))
      .mockImplementationOnce(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(fetchMock).not.toHaveBeenCalled();
    const response = await call(vault, "/trade/confirm", proposal);
    expect(await response.json()).toMatchObject({ result: { status: "PARTIALLY_EXECUTED", orders: [{ index: 1, status: "EXECUTED" }, { index: 2, status: "FAILED", orderId: 42 }, { index: 3, status: "EXECUTED" }] } });
    expect(fetchMock.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "PUT", "POST"]);
    expect((await call(vault, "/trade/confirm", proposal)).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("marks the parent executed when every mixed order succeeds", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: {
      status: "EXECUTED", orders: [{ status: "EXECUTED" }, { status: "EXECUTED" }, { status: "EXECUTED" }],
    } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("halts after an uncertain write and exposes persisted not-submitted items", async () => {
    const vault = await setup();
    const fetchMock = vi.fn().mockReturnValueOnce(new Response(null, { status: 201 })).mockReturnValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: { status: "EXECUTION_UNCERTAIN", orders: [{ status: "EXECUTED" }, { status: "EXECUTION_UNCERTAIN" }, { status: "NOT_SUBMITTED" }] } });
    expect(await (await call(vault, "/trade/proposal", { proposalId: proposal.proposalId })).json()).toMatchObject({ result: { outcome: { result: { status: "EXECUTION_UNCERTAIN" } } } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("halts when a successful executor response cannot be decoded", async () => {
    const vault = await setup();
    const proposal = await prepare(vault);
    const execute = vi.fn(() => Promise.resolve(new Response("not json", { status: 200 })));
    await runInDurableObject(vault, instance => { Reflect.set(instance, "executeMutation", execute); });
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: {
      status: "EXECUTION_UNCERTAIN", orders: [{ status: "EXECUTION_UNCERTAIN" }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }],
    } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("stops before the next item if account authorization changes", async () => {
    const vault = await setup();
    const proposal = await prepare(vault);
    await runInDurableObject(vault, async (instance, state) => {
      const fetchMock = vi.fn(() => {
        state.storage.sql.exec("UPDATE client_accounts SET hashes = ? WHERE client_id = ?", "[]", identity.clientId);
        return new Response(null, { status: 201 });
      });
      vi.stubGlobal("fetch", fetchMock);
      expect(await (await direct(instance, "/trade/confirm", proposal)).json()).toMatchObject({ result: { status: "PARTIALLY_EXECUTED", orders: [{ status: "EXECUTED" }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }] } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("does not expose a proposal to another client", async () => {
    const vault = await setup();
    const proposal = await prepare(vault);
    const other = { ...identity, clientId: "other-client" };
    await (await vault.fetch("https://vault/client/policy?clientId=other-client&ensure=true&permissionLevel=full_access&advancedSecurity=false&version=0")).text();
    await runInDurableObject(vault, (_instance, state) => { state.storage.sql.exec("INSERT OR REPLACE INTO client_accounts (client_id, hashes) VALUES (?, ?)", other.clientId, JSON.stringify([accountHash])); });
    expect((await call(vault, "/trade/proposal", { proposalId: proposal.proposalId }, other)).status).toBe(404);
    expect((await call(vault, "/trade/confirm", proposal, other)).status).toBe(403);
  });
  it("exposes in-flight progress and never submits twice under concurrent confirmation", async () => {
    const vault = await setup();
    const proposal = await prepare(vault, [{ action: "PLACE", orderPayload }]);
    await runInDurableObject(vault, async instance => {
      let enteredResolve!: () => void;
      let upstreamResolve!: (response: Response) => void;
      const entered = new Promise<void>(resolve => { enteredResolve = resolve; });
      const upstream = new Promise<Response>(resolve => { upstreamResolve = resolve; });
      const fetchMock = vi.fn(() => { enteredResolve(); return upstream; });
      vi.stubGlobal("fetch", fetchMock);
      const first = direct(instance, "/trade/confirm", proposal);
      await entered;
      expect(await (await direct(instance, "/trade/proposal", { proposalId: proposal.proposalId })).json()).toMatchObject({
        result: { status: "EXECUTING", outcome: { result: { status: "EXECUTING", orders: [{ status: "EXECUTING" }] } } },
      });
      expect((await direct(instance, "/trade/confirm", proposal)).status).toBe(409);
      upstreamResolve(new Response(null, { status: 201 }));
      expect(await (await first).json()).toMatchObject({ result: { status: "EXECUTED" } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("freezes a detached snapshot and stops when the approval expires between items", async () => {
    const vault = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON order body");
      expect(JSON.parse(init.body)).toMatchObject({ orderStrategyType: "SINGLE" });
      clock.mockReturnValue(now + 301_000);
      return new Response(null, { status: 201 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const firstPayload = { ...orderPayload };
    const mutable = [{ action: "PLACE", orderPayload: firstPayload }, { action: "PLACE", orderPayload: { ...orderPayload } }];
    const proposal = await prepare(vault, mutable);
    firstPayload.orderStrategyType = "CHANGED";
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: { status: "PARTIALLY_EXECUTED", orders: [{ status: "EXECUTED" }, { status: "NOT_SUBMITTED" }] } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not resume an interrupted claimed batch", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec("UPDATE trade_proposal SET status = 'EXECUTING' WHERE id = ?", proposal.proposalId);
      state.storage.sql.exec("UPDATE trade_batch_item SET status = 'EXECUTING' WHERE proposal_id = ? AND item_index = 1", proposal.proposalId);
    });
    await evictDurableObject(vault);
    expect((await call(vault, "/trade/confirm", proposal)).status).toBe(409);
    expect(await (await call(vault, "/trade/proposal", { proposalId: proposal.proposalId })).json()).toMatchObject({
      result: { status: "EXECUTION_UNCERTAIN", outcome: { result: { orders: [{ status: "EXECUTION_UNCERTAIN" }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }] } } },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports invalidated unclaimed orders as not submitted without mutating the journal", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED' WHERE id = ?", proposal.proposalId);
    });
    expect(await (await call(vault, "/trade/proposal", { proposalId: proposal.proposalId })).json()).toMatchObject({
      result: { status: "INVALIDATED", outcome: { result: { orders: [{ status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }] } } },
    });
    const rows = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec<{ status: string }>(
      "SELECT status FROM trade_batch_item WHERE proposal_id = ? ORDER BY item_index", proposal.proposalId,
    ).toArray());
    expect(rows.map(row => row.status)).toEqual(["PENDING", "PENDING", "PENDING"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("projects expired pending batches as not submitted in proposal outcome when deadline elapses", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const proposal = await prepare(vault);
    clock.mockReturnValue(now + 301_000);
    expect(await (await call(vault, "/trade/proposal", { proposalId: proposal.proposalId })).json()).toMatchObject({
      result: {
        status: "EXPIRED",
        outcome: {
          result: {
            status: "EXPIRED",
            orders: [{ status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }],
          },
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops on a network exception and reports all definite rejections as failed", async () => {
    const vault = await setup();
    const fetchMock = vi.fn(() => { throw new Error("connection lost"); });
    vi.stubGlobal("fetch", fetchMock);
    const first = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", first)).json()).toMatchObject({ result: {
      status: "EXECUTION_UNCERTAIN", orders: [{ status: "EXECUTION_UNCERTAIN" }, { status: "NOT_SUBMITTED", outcome: { error: { code: "EXECUTION_UNCERTAIN" } } }, { status: "NOT_SUBMITTED" }],
    } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const reject = vi.fn(() => new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", reject);
    const second = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", second)).json()).toMatchObject({ result: { status: "FAILED", orders: [{ status: "FAILED" }, { status: "FAILED" }, { status: "FAILED" }] } });
    expect(reject).toHaveBeenCalledTimes(3);
  });

  it("stops remaining orders when the master switch changes", async () => {
    const vault = await setup();
    const proposal = await prepare(vault);
    await runInDurableObject(vault, async instance => {
      const runtime = Reflect.get(instance, "env") as object;
      const fetchMock = vi.fn(() => {
        Reflect.set(runtime, "ENABLE_TRADING", "false");
        return new Response(null, { status: 201 });
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        expect(await (await direct(instance, "/trade/confirm", proposal)).json()).toMatchObject({ result: { status: "PARTIALLY_EXECUTED", orders: [
          { status: "EXECUTED" }, { status: "NOT_SUBMITTED", outcome: { error: { code: "TRADE_STATE_CONFLICT" } } }, { status: "NOT_SUBMITTED" },
        ] } });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally { Reflect.set(runtime, "ENABLE_TRADING", "true"); }
    });
  });

  it("rechecks approval after a 401 token refresh before retrying the mutation", async () => {
    const vault = await setup();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Response>()
      .mockImplementationOnce(() => new Response(null, { status: 401 }))
      .mockImplementationOnce(() => {
        clock.mockReturnValue(now + 301_000);
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
      });
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: { orders: [
      { status: "NOT_SUBMITTED", outcome: { error: { code: "CONFIRMATION_EXPIRED" } } }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" },
    ] } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const refreshUrl = fetchMock.mock.calls[1]?.[0];
    expect(typeof refreshUrl === "string" ? refreshUrl : refreshUrl instanceof URL ? refreshUrl.href : refreshUrl?.url).toContain("/oauth/token");
  });

  it("halts on repeated upstream 401 rather than treating it as an ordinary rejection", async () => {
    const vault = await setup();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Response>()
      .mockImplementationOnce(() => new Response(null, { status: 401 }))
      .mockImplementationOnce(() => Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 }))
      .mockImplementationOnce(() => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await prepare(vault);
    expect(await (await call(vault, "/trade/confirm", proposal)).json()).toMatchObject({ result: { orders: [
      { status: "NOT_SUBMITTED", outcome: { error: { code: "AUTH_REQUIRED" } } }, { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" },
    ] } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["policy", "switch"] as const)("rechecks %s after a 401 refresh before retry", async change => {
    const vault = await setup();
    const proposal = await prepare(vault);
    await runInDurableObject(vault, async (instance, state) => {
      let calls = 0;
      const runtime = Reflect.get(instance, "env") as object;
      const fetchMock = vi.fn(() => {
        if (++calls === 1) return new Response(null, { status: 401 });
        if (change === "policy") state.storage.sql.exec("UPDATE client_security SET revoked = 1 WHERE client_id = ?", identity.clientId);
        else Reflect.set(runtime, "ENABLE_TRADING", "false");
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 });
      });
      vi.stubGlobal("fetch", fetchMock);
      try {
        expect(await (await direct(instance, "/trade/confirm", proposal)).json()).toMatchObject({ result: { orders: [
          { status: "NOT_SUBMITTED", outcome: { error: { code: change === "policy" ? "SECURITY_POLICY_CHANGED" : "TRADE_STATE_CONFLICT" } } },
          { status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" },
        ] } });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        if (change === "switch") Reflect.set(runtime, "ENABLE_TRADING", "true");
      }
    });
  });

});
