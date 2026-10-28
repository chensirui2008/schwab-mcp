import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { SecurityStore } from "../src/security-store";
import type { BrowserSession, ClientIdentity, PendingAuthorization } from "../src/security-store";
import { renderSecurityPage } from "../src/security-ui";
import { AuthHandler } from "../src/auth";
import { sha256 } from "../src/trading";
import { authenticator } from "./webauthn-fixture";

type Options = { challengeId: string; options: { challenge: string; userVerification?: string; authenticatorSelection?: { userVerification: string } } };
const accountHash = "a".repeat(32);
const payload = { orderType: "LIMIT", session: "NORMAL", duration: "DAY", price: "100.00", orderStrategyType: "SINGLE", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }] };
const input = { accountHash, orders: [{ action: "PLACE", orderPayload: payload }, { action: "REPLACE", orderId: 42, orderPayload: payload }], userInstruction: "Submit both orders" };
const plain: ClientIdentity = { clientId: "plain", advancedSecurity: false, securityPolicyVersion: 0 };
const pending: PendingAuthorization = { authRequest: { clientId: "enhanced", redirectUri: "https://client.example/callback", responseType: "code", scope: ["schwab.read"], state: "test", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }, permissionLevel: "full_access", advancedSecurity: true, username: "owner", policyVersion: 0, allowedAccountHashes: [accountHash] };

async function setup() {
  const appEnv = env as unknown as AppEnv;
  const vault = appEnv.SCHWAB_VAULT.get(appEnv.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
  const post = (path: string, data: unknown) => vault.fetch(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  expect((await vault.fetch("https://vault/client/policy?clientId=plain&ensure=true&permissionLevel=full_access&advancedSecurity=false&version=0")).status).toBe(200);
  await runInDurableObject(vault, (_instance, state) => { state.storage.sql.exec("INSERT OR REPLACE INTO client_accounts (client_id, hashes) VALUES (?, ?)", "plain", JSON.stringify([accountHash])); });
  const begin = await (await post("/security/authorization/begin", { intent: pending, clientName: "enhanced", currentAdvanced: false })).json<{ sessionId: string; authorizationId: string }>();
  const { session: initial } = await (await post("/security/session", { sessionId: begin.sessionId })).json<{ session: BrowserSession }>();
  const key = await authenticator();
  const registration = await (await post("/security/authorization/options", { sessionId: begin.sessionId, csrf: initial.csrf, authorizationId: begin.authorizationId })).json<Options>();
  expect((await post("/security/authorization/verify", { sessionId: begin.sessionId, csrf: initial.csrf, challengeId: registration.challengeId, response: await key.register(registration.options.challenge) })).status).toBe(200);
  const claim = await (await post("/security/authorization/claim", { authorizationId: begin.authorizationId, sessionId: begin.sessionId, csrf: initial.csrf })).json<{ commitTicket: string; finishingId: string }>();
  expect((await post("/security/commit-policy", { clientId: "enhanced", permissionLevel: "full_access", advancedSecurity: true, expected: 0, ticket: claim.commitTicket })).status).toBe(200);
  await post("/security/authorization/finalize", { authorizationId: begin.authorizationId, finishingId: claim.finishingId, originalSessionId: begin.sessionId, authorizationEventId: crypto.randomUUID() });
  const created = await (await post("/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
  const browser = (path: string, data: Record<string, unknown> = {}) => post(`/security${path}`, { ...data, sessionId: created.sessionId, csrf: created.session.csrf });
  const identity: ClientIdentity = { clientId: "enhanced", advancedSecurity: true, securityPolicyVersion: 1 };
  await vault.fetch("https://vault/token", { method: "PUT", body: JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 1800 }) });
  const prepare = async (batch = input) => {
    const response = await post("/trade/prepare-batch", { identity, requestId: crypto.randomUUID(), input: batch });
    expect(response.status).toBe(200);
    return (await response.json<{ result: { proposalId: string; approvalMethod: string; approvalUrl: string; intentDigest: string; preview: unknown } }>()).result;
  };
  const options = async (proposalId: string) => {
    const response = await browser("/options", { operation: "approve", proposalId });
    expect(response.status).toBe(200);
    return response.json<Options>();
  };
  return { vault, post, browser, identity, key, created, prepare, options };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("batch Passkey approval", () => {
  it("freezes the ordered batch, binds its digest, and executes one signed approval only once", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201, headers: { Location: "/accounts/hash/orders/123" } }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare();
    const reversed = await t.prepare({ ...input, orders: [...input.orders].reverse() });
    expect(proposal.approvalMethod).toBe("passkey");
    expect(proposal).not.toHaveProperty("confirmationToken");
    expect(proposal).not.toHaveProperty("confirmationText");
    expect(proposal.intentDigest).not.toBe(reversed.intentDigest);
    expect(proposal.preview).toMatchObject({ accountHash, action: "BATCH", executionMode: "IMMEDIATE", orders: input.orders });
    const token = "a".repeat(43);
    const tokenHash = await sha256(token);
    const confirmationText = await runInDurableObject(t.vault, (_instance, state) => {
      state.storage.sql.exec("UPDATE trade_proposal SET token_hash = ? WHERE id = ?", tokenHash, proposal.proposalId);
      return state.storage.sql.exec<{ confirmation_text: string }>("SELECT confirmation_text FROM trade_proposal WHERE id = ?", proposal.proposalId).one().confirmation_text;
    });
    const denied = await t.post("/trade/confirm", { identity: t.identity, input: { proposalId: proposal.proposalId, confirmationToken: token, confirmationText } });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "SECURITY_VERIFICATION_FAILED" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await t.post("/trade/confirm", { identity: plain, input: { proposalId: proposal.proposalId, confirmationToken: "a".repeat(43), confirmationText: "guess" } })).status).toBe(403);
    expect((await t.post("/trade/proposal", { identity: plain, input: { proposalId: proposal.proposalId } })).status).toBe(404);
    const a = await t.options(proposal.proposalId); const b = await t.options(proposal.proposalId);
    expect(a.options.userVerification).toBe("required");
    const signedA = await t.key.authenticate(a.options.challenge);
    const signedB = await t.key.authenticate(b.options.challenge);
    const results = await Promise.all([t.browser("/verify", { challengeId: a.challengeId, response: signedA }), t.browser("/verify", { challengeId: b.challengeId, response: signedB })]);
    expect(results.map(r => r.status)).toContain(200);
    await t.browser("/verify", { challengeId: a.challengeId, response: signedA });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const status = await (await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } })).json();
    expect(status).toMatchObject({ result: { status: "EXECUTED", outcome: { result: { orders: [{ index: 1, status: "EXECUTED" }, { index: 2, status: "EXECUTED" }] } } } });
    const completed = await AuthHandler.request(`https://example.com/security/approvals/${proposal.proposalId}/complete`, {
      headers: { Cookie: `__Host-schwab-security=${t.created.sessionId}` },
    }, { ...(env as unknown as AppEnv), SCHWAB_VAULT: { idFromName: () => t.vault.id, get: () => t.vault } as unknown as DurableObjectNamespace });
    expect(completed.status).toBe(200);
    expect(await completed.text()).toContain("EXECUTED");
  });

  it("rejects all pending orders without an assertion and remains cancelled on repeat", async () => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare();
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = await t.browser("/reject-proposal", { proposalId: proposal.proposalId });
      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ status: "CANCELLED" });
    }
    const view = await (await t.browser("/proposal", { proposalId: proposal.proposalId })).json<unknown>();
    expect(view).toMatchObject({ status: "CANCELLED", outcome: { result: { orders: [{ status: "NOT_SUBMITTED" }, { status: "NOT_SUBMITTED" }] } } });
    expect((await t.browser("/options", { operation: "approve", proposalId: proposal.proposalId })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects recovery sessions, revoked account authorization, stale policy and expired approvals", async () => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const recovery = await (await t.post("/security/session/create", { recovery: true })).json<{ sessionId: string; session: BrowserSession }>();
    const first = await t.prepare();
    expect((await t.post("/security/options", { sessionId: recovery.sessionId, csrf: recovery.session.csrf, operation: "approve", proposalId: first.proposalId })).status).toBe(403);
    const accountOptions = await t.options(first.proposalId);
    await runInDurableObject(t.vault, (_instance, state) => { state.storage.sql.exec("UPDATE client_accounts SET hashes = ? WHERE client_id = ?", JSON.stringify([]), "enhanced"); });
    expect((await t.browser("/verify", { challengeId: accountOptions.challengeId, response: await t.key.authenticate(accountOptions.options.challenge) })).status).toBe(403);
    await runInDurableObject(t.vault, (_instance, state) => { state.storage.sql.exec("UPDATE client_accounts SET hashes = ? WHERE client_id = ?", JSON.stringify([accountHash]), "enhanced"); });
    const second = await t.prepare(); const stale = await t.options(second.proposalId);
    await runInDurableObject(t.vault, (_instance, state) => {
      new SecurityStore(state.storage, env as unknown as AppEnv).commitPolicy("enhanced", true, 1);
    });
    expect((await t.browser("/verify", { challengeId: stale.challengeId, response: await t.key.authenticate(stale.options.challenge) })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires the signed challenge at the proposal deadline", async () => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const proposal = await t.prepare(); now += 299_000;
    const challenge = await t.options(proposal.proposalId); now += 1_001;

    expect((await t.browser("/verify", { challengeId: challenge.challengeId, response: await t.key.authenticate(challenge.options.challenge) })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { secondStatus: 201, expectedStatus: "PARTIALLY_EXECUTED", secondItem: "EXECUTED" },
    { secondStatus: 400, expectedStatus: "FAILED", secondItem: "FAILED" },
  ])("continues after rejection and displays $expectedStatus", async ({ secondStatus, expectedStatus, secondItem }) => {
    const t = await setup();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Response(null, { status: 400 }))
      .mockImplementationOnce(() => new Response(null, { status: secondStatus }));
    vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare();
    const options = await t.options(proposal.proposalId);
    expect((await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const view = await (await t.browser("/proposal", { proposalId: proposal.proposalId })).json<Parameters<typeof renderSecurityPage>[2]>();
    expect(view).toMatchObject({ status: expectedStatus, outcome: { result: { orders: [{ status: "FAILED", outcome: { error: { code: "SCHWAB_REJECTED" } } }, { status: secondItem }] } } });
    const page = (await renderSecurityPage(t.created.session, [], view, "en-US")).toString();
    expect(page).toContain(expectedStatus);
    expect(page).toContain("FAILED");
    expect(page).not.toContain('id="approve"');
    const complete = await AuthHandler.request(`https://example.com/security/approvals/${proposal.proposalId}/complete`, {
      headers: { Cookie: `__Host-schwab-security=${t.created.sessionId}` },
    }, { ...(env as unknown as AppEnv), SCHWAB_VAULT: { idFromName: () => t.vault.id, get: () => t.vault } as unknown as DurableObjectNamespace });
    expect(complete.status).toBe(409);
  });

  it("shows persisted uncertain and unsubmitted results without treating the batch as complete", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare(); const options = await t.options(proposal.proposalId);
    await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const view = await (await t.browser("/proposal", { proposalId: proposal.proposalId })).json<Parameters<typeof renderSecurityPage>[2]>();
    expect(view).toMatchObject({ status: "EXECUTION_UNCERTAIN", outcome: { result: { orders: [{ status: "EXECUTION_UNCERTAIN" }, { status: "NOT_SUBMITTED" }] } } });
    const page = (await renderSecurityPage(t.created.session, [], view, "en-US")).toString();
    expect(page).toContain("EXECUTION_UNCERTAIN");
    expect(page).toContain("NOT_SUBMITTED");
    expect(page).not.toContain('id="approve"');
    const complete = await AuthHandler.request(`https://example.com/security/approvals/${proposal.proposalId}/complete`, {
      headers: { Cookie: `__Host-schwab-security=${t.created.sessionId}` },
    }, { ...(env as unknown as AppEnv), SCHWAB_VAULT: { idFromName: () => t.vault.id, get: () => t.vault } as unknown as DurableObjectNamespace });
    expect(complete.status).toBe(409);
  });
});
