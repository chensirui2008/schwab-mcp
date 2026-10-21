import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountChoices, scopedPreferences } from "../src/account-access";
import { SecurityStore } from "../src/security-store";
import type { ClientIdentity } from "../src/security-store";
import { isCurrentAuthorization, AUTHORIZATION_VERSION } from "../src/oauth-access";
import type { AppEnv } from "../src/env";

const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);
const linked = [{ accountNumber: "123456789", hashValue: A }, { accountNumber: "987654321", hashValue: B }, { accountNumber: "555555555", hashValue: C }];
const identity: ClientIdentity = { clientId: "selected-client", advancedSecurity: false, securityPolicyVersion: 0 };
const order = { orderType: "MARKET", session: "NORMAL", duration: "DAY", orderStrategyType: "SINGLE", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }] };
async function setup(allowed = [A], level: "read_only" | "full_access" = "full_access") {
  const vault = env.SCHWAB_VAULT.get(env.SCHWAB_VAULT.newUniqueId());
  await runInDurableObject(vault, (_instance, state) => {
    const store = new SecurityStore(state.storage, env as unknown as AppEnv);
    store.ensurePolicy(identity.clientId, level, false, 0);
    store.setAccounts(identity.clientId, allowed);
  });
  await vault.fetch("https://vault/token", { method: "PUT", body: JSON.stringify({ access_token: "test-only-access", refresh_token: "test-only-refresh", expires_in: 1800 }) });
  const post = (path: string, data: unknown) => vault.fetch(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const read = (path: string, query: Record<string, string> = {}, caller = identity) => post("/request", { base: "trader", path, query, identity: caller, tool: "test_account_scope", requestId: crypto.randomUUID() });
  const trade = (path: string, input: unknown, caller = identity) => post(path, { input, identity: caller, requestId: crypto.randomUUID() });
  const select = (hashes: string[]) => runInDurableObject(vault, (_instance, state) => { new SecurityStore(state.storage, env as unknown as AppEnv).setAccounts(identity.clientId, hashes); });
  return { vault, post, read, trade, select };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("per-client account scope", () => {
  it("requires explicit new account consent and rejects legacy, missing, malformed or duplicate scopes", () => {
    const props = { userId: "123456", username: "owner", authorizationVersion: AUTHORIZATION_VERSION, permissionLevel: "read_only", allowedAccountHashes: [] };
    expect(isCurrentAuthorization(props)).toBe(true);
    for (const allowedAccountHashes of [undefined, null, "all", [A, A], ["invalid"]]) expect(isCurrentAuthorization({ ...props, allowedAccountHashes })).toBe(false);
    expect(isCurrentAuthorization({ ...props, authorizationVersion: "client-permissions-v1" })).toBe(false);
    expect(accountChoices(linked)).toEqual([{ hashValue: A, label: "••••6789" }, { hashValue: B, label: "••••4321" }, { hashValue: C, label: "••••5555" }]);
  });

  it("filters linked accounts and survives DO eviction", async () => {
    const t = await setup([A, B], "read_only");
    vi.stubGlobal("fetch", vi.fn(() => Response.json(linked)));
    await evictDurableObject(t.vault);
    const response = await t.read("/accounts/accountNumbers");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: [{ hashValue: A }, { hashValue: B }] });
  });

  it("denies guessed account hashes for all account reads and writes before any upstream request", async () => {
    const t = await setup();
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    for (const path of [`/accounts/${B}`, `/accounts/${B}/orders/42`, `/accounts/${B}/transactions`, `/accounts/${B}/orders`, "/accounts", "/accounts/%61", "/accounts/accountNumbers/extra"]) {
      const response = await t.read(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "ACCOUNT_ACCESS_DENIED" } });
    }
    for (const [path, input] of [
      ["/trade/prepare", { accountHash: B, action: "PLACE", executionMode: "IMMEDIATE", orderPayload: order, userInstruction: "Test only" }],
      ["/trade/cancel-order", { accountHash: B, orderId: 42, userInstruction: "Test only" }],
      ["/trade/place-direct", { accountHash: B }],
    ] as const) {
      expect(await (await t.trade(path, input)).json()).toMatchObject({ error: { code: "ACCOUNT_ACCESS_DENIED" } });
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps zero-account grants market-only without fetching private data", async () => {
    const t = await setup([]);
    const upstream = vi.fn(() => Response.json({ AAPL: { quote: { lastPrice: 100 } } })); vi.stubGlobal("fetch", upstream);
    expect(await (await t.read("/accounts/accountNumbers")).json()).toEqual({ result: [] });
    expect(await (await t.read("/orders")).json()).toEqual({ result: [] });
    expect(await (await t.read("/userPreference")).json()).toEqual({ result: { accounts: [] } });
    expect((await t.read(`/accounts/${A}`)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect((await t.post("/request", { base: "market", path: "/quotes", query: { symbols: "AAPL" }, identity, requestId: crypto.randomUUID(), tool: "get_quotes" })).status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("queries orders only through authorized account endpoints and applies a global result limit", async () => {
    const t = await setup([A, B]);
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = new URL((input instanceof Request ? input.url : String(input))); paths.push(url.pathname);
      return Response.json([{ orderId: url.pathname.includes(A) ? 1 : 2, enteredTime: url.pathname.includes(A) ? "2026-10-01T00:00:00Z" : "2026-10-02T00:00:00Z" }]);
    }));
    expect(await (await t.read("/orders", { fromEnteredTime: "2026-10-01T00:00:00Z", toEnteredTime: "2026-10-03T00:00:00Z", maxResults: "1" })).json()).toMatchObject({ result: [{ orderId: 2 }] });
    expect(paths).toEqual([`/trader/v1/accounts/${A}/orders`, `/trader/v1/accounts/${B}/orders`]);
  });

  it("limits preferences to selected accounts and excludes streamer/other private fields", async () => {
    const t = await setup();
    const prefs = { accounts: [{ accountNumber: "123456789", primaryAccount: true, type: "MARGIN" }, { accountNumber: "987654321" }], streamerInfo: [{ token: "must-not-expose" }], offers: ["other-account-data"] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => Response.json((input instanceof Request ? input.url : String(input)).endsWith("accountNumbers") ? linked : prefs)));
    const response = await t.read("/userPreference");
    expect(await response.json()).toMatchObject({ result: { accounts: [{ hashValue: A, primaryAccount: true, type: "MARGIN" }] } });
    expect(scopedPreferences(prefs, linked, [])).toEqual({ accounts: [] });
    expect(() => scopedPreferences({ accounts: [{ accountNumber: "unknown" }] }, linked, [A])).toThrow();
  });

  it("fails closed on malformed linked accounts, order lists and preferences", async () => {
    const t = await setup();
    for (const path of ["/accounts/accountNumbers", "/orders", "/userPreference"]) {
      vi.stubGlobal("fetch", vi.fn(() => Response.json({ invalid: true })));
      expect((await t.read(path)).status).toBe(502);
    }
  });

  it("rejects malformed orders instead of silently mis-sorting them", async () => {
    const t = await setup();
    vi.stubGlobal("fetch", vi.fn(() => Response.json([{ orderId: 1, enteredTime: "invalid" }])));
    expect((await t.read("/orders")).status).toBe(502);
  });

  it("rechecks account scope after an in-flight read before releasing its response", async () => {
    const t = await setup();
    const response = await runInDurableObject(t.vault, async (instance, state) => {
      const store = new SecurityStore(state.storage, env as unknown as AppEnv);
      vi.stubGlobal("fetch", vi.fn(() => {
        store.setAccounts(identity.clientId, []);
        return Response.json({ securitiesAccount: { accountNumber: "123456789", currentBalances: { cashBalance: 123 } } });
      }));
      return instance.fetch(new Request("https://vault/request", { method: "POST", body: JSON.stringify({ base: "trader", path: `/accounts/${A}`, identity, tool: "test_scope", requestId: crypto.randomUUID() }) }));
    });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("cashBalance");
  });

  it("pauses removed-account delayed tasks, retains cancellation and never resumes them implicitly", async () => {
    const t = await setup();
    const prepare = await t.trade("/trade/prepare", { accountHash: A, action: "PLACE", executionMode: "DELAYED", orderPayload: order, userInstruction: "Isolated test order", condition: { type: "TIME", operator: "AT_OR_AFTER", at: new Date(Date.now() - 1000).toISOString() }, validUntil: new Date(Date.now() + 600000).toISOString() });
    expect(prepare.status).toBe(200);
    const proposal = (await prepare.json<{ result: { proposalId: string; confirmationToken: string; confirmationText: string } }>()).result;
    const activated = await t.trade("/trade/confirm", proposal);
    expect(activated.status).toBe(200);
    const { result: task } = await activated.json<{ result: { taskId: string } }>();
    const upstream = vi.fn(); vi.stubGlobal("fetch", upstream);
    await t.select([]);
    await runDurableObjectAlarm(t.vault);
    const list = await t.trade("/trade/list-delayed", { status: "PAUSED" });
    expect(await list.json()).toMatchObject({ result: [{ taskId: task.taskId, status: "PAUSED" }] });
    await t.select([A]);
    await runDurableObjectAlarm(t.vault);
    expect(upstream).not.toHaveBeenCalled();
    await t.select([]);
    expect(await (await t.trade("/trade/cancel-delayed", { taskId: task.taskId, userInstruction: "Cancel isolated task" })).json()).toMatchObject({ result: { status: "CANCELLED" } });
  });
});
