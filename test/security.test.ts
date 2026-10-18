import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { SecurityStore } from "../src/security-store";
import { renderSecurityPage } from "../src/security-ui";
import { AuthHandler } from "../src/auth";
import type { BrowserSession, ClientIdentity, PendingAuthorization } from "../src/security-store";
import { authenticator } from "./webauthn-fixture";

type Options = { challengeId: string; options: { challenge: string; userVerification?: string; authenticatorSelection?: { userVerification: string } } };
const input = {
  accountHash: "a".repeat(32), action: "PLACE", executionMode: "IMMEDIATE",
  orderPayload: { orderType: "LIMIT", session: "NORMAL", duration: "DAY", price: "100.00", orderStrategyType: "SINGLE", orderLegCollection: [{ instruction: "BUY", quantity: 1, instrument: { symbol: "AAPL", assetType: "EQUITY" } }] },
  userInstruction: "Buy one AAPL share",
};
const plain: ClientIdentity = { clientId: "plain", advancedSecurity: false, securityPolicyVersion: 0 };
const pending: PendingAuthorization = { authRequest: { clientId: "enhanced", redirectUri: "https://client.example/callback", responseType: "code", scope: ["schwab.read"], state: "test", codeChallenge: "a".repeat(43), codeChallengeMethod: "S256" }, permissionLevel: "full_access", advancedSecurity: true, username: "owner", policyVersion: 0 };
async function setup() {
  const appEnv = env as unknown as AppEnv;
  const vault = appEnv.SCHWAB_VAULT.get(appEnv.SCHWAB_VAULT.idFromName(crypto.randomUUID()));
  const post = (path: string, data: unknown) => vault.fetch(`https://vault${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const ordinaryPolicy = await vault.fetch("https://vault/client/policy?clientId=plain&ensure=true&permissionLevel=full_access&advancedSecurity=false&version=0");
  expect(ordinaryPolicy.status).toBe(200);
  const beginRes = await post("/security/authorization/begin", { intent: pending, clientName: "enhanced", currentAdvanced: false });
  const begin = await beginRes.json<{ sessionId: string; authorizationId: string }>();
  const sessionRes = await post("/security/session", { sessionId: begin.sessionId });
  const { session: initial } = await sessionRes.json<{ session: BrowserSession }>();
  const key = await authenticator();
  const options = await (await post("/security/authorization/options", { sessionId: begin.sessionId, csrf: initial.csrf, authorizationId: begin.authorizationId })).json<Options>();
  expect(options.options.authenticatorSelection?.userVerification).toBe("required");
  const registered = await post("/security/authorization/verify", { sessionId: begin.sessionId, csrf: initial.csrf, challengeId: options.challengeId, response: await key.register(options.options.challenge) });
  expect(registered.status).toBe(200);
  const claim = await (await post("/security/authorization/claim", { authorizationId: begin.authorizationId, sessionId: begin.sessionId, csrf: initial.csrf })).json<{ commitTicket: string; finishingId: string }>();
  expect((await post("/security/commit-policy", { clientId: "enhanced", permissionLevel: "full_access", advancedSecurity: true, expected: 0, ticket: claim.commitTicket })).status).toBe(200);
  await post("/security/authorization/finalize", { authorizationId: begin.authorizationId, finishingId: claim.finishingId, originalSessionId: begin.sessionId, authorizationEventId: crypto.randomUUID() });
  const created = await (await post("/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
  const browser = (path: string, data: Record<string, unknown> = {}) => post(`/security${path}`, { ...data, sessionId: created.sessionId, csrf: created.session.csrf });
  const identity: ClientIdentity = { clientId: "enhanced", advancedSecurity: true, securityPolicyVersion: 1 };
  const prepare = async (overrides: Record<string, unknown> = {}, client = identity) => {
    const response = await post("/trade/prepare", { identity: client, requestId: crypto.randomUUID(), input: { ...input, ...overrides } });
    expect(response.status).toBe(200);
    return (await response.json<{ result: { proposalId: string; approvalUrl?: string; approvalMethod?: string; confirmationToken?: string } }>()).result;
  };
  const approveOptions = async (proposalId: string) => {
    const response = await browser("/options", { operation: "approve", proposalId });
    expect(response.status).toBe(200);
    return response.json<Options>();
  };
  await vault.fetch("https://vault/token", { method: "PUT", body: JSON.stringify({ access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 1800 }) });
  return { appEnv, vault, post, browser, key, prepare, approveOptions, identity, created };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function completionPage(t: Awaited<ReturnType<typeof setup>>, proposalId: string) {
  return AuthHandler.request(`https://example.com/security/approvals/${proposalId}/complete`, {
    headers: { Cookie: `__Host-schwab-security=${t.created.sessionId}` },
  }, { ...t.appEnv, SCHWAB_VAULT: {
    idFromName: () => t.vault.id, get: () => t.vault,
  } as unknown as DurableObjectNamespace });
}

describe("Passkey trading", () => {
  it("shows frozen replacement target and polling interval in proposal status and browser approval", async () => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const delayedInput = {
      executionMode: "DELAYED",
      condition: { type: "TIME", operator: "AFTER", at: new Date(Date.now() + 60_000).toISOString() },
      validUntil: new Date(Date.now() + 120_000).toISOString(),
      pollIntervalSeconds: 15,
    };
    const original = await t.prepare(delayedInput);
    const options = await t.approveOptions(original.proposalId);
    const activated = await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) });
    expect(activated.status).toBe(200);
    const { result: { taskId } } = await activated.json<{ result: { taskId: string } }>();
    const replacement = await t.prepare({ ...delayedInput, replacesTaskId: taskId });
    const status = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: replacement.proposalId } });
    expect(await status.json()).toMatchObject({ result: { preview: { ...delayedInput, replacesTaskId: taskId } } });
    const response = await t.browser("/proposal", { proposalId: replacement.proposalId });
    expect(response.status).toBe(200);
    const proposal = await response.json<Parameters<typeof renderSecurityPage>[2]>();
    expect(proposal).toMatchObject({ preview: { ...delayedInput, replacesTaskId: taskId } });
    const page = await renderSecurityPage(t.created.session, [], proposal);
    expect(page.toString()).toContain(`replacesTaskId&quot;: &quot;${taskId}`);
    expect(page.toString()).toContain("pollIntervalSeconds&quot;: 15");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("isolates ordinary confirmation, enhanced approval and client-owned status", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201, headers: { Location: "/accounts/hash/orders/123" } }));
    vi.stubGlobal("fetch", fetchMock);
    const ordinary = await t.prepare({}, plain);
    expect(ordinary.confirmationToken).toBeTypeOf("string");
    const proposal = await t.prepare();
    expect((await completionPage(t, proposal.proposalId)).status).toBe(409);
    expect(proposal.approvalMethod).toBe("passkey");
    expect(proposal.approvalUrl).toContain(`/security/approvals/${proposal.proposalId}`);
    expect(proposal).not.toHaveProperty("confirmationToken");
    expect(proposal).not.toHaveProperty("confirmationText");
    for (const path of ["/trade/confirm", "/trade/session/enable", "/trade/place-direct"]) expect((await t.post(path, { identity: t.identity, input: {} })).status).toBe(403);
    expect((await t.post("/trade/confirm", { identity: plain, input: { proposalId: proposal.proposalId, confirmationToken: "a".repeat(43), confirmationText: "guess" } })).status).toBe(403);
    expect((await t.post("/trade/proposal", { identity: plain, input: { proposalId: proposal.proposalId } })).status).toBe(404);
    const options = await t.approveOptions(proposal.proposalId);
    expect(options.options.userVerification).toBe("required");
    const response = await t.key.authenticate(options.options.challenge);
    const approved = await t.browser("/verify", { challengeId: options.challengeId, response });
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ result: { orderId: 123 } });
    const completed = await completionPage(t, proposal.proposalId);
    expect(completed.status).toBe(200);
    expect(completed.headers.get("Cache-Control")).toBe("no-store");
    expect(completed.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(await completed.text()).toContain("授权完成，可以关闭页面");
    const repeated = await t.browser("/verify", { challengeId: options.challengeId, response });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: "EXECUTED" });
    const status = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } });
    expect(await status.json()).toMatchObject({ result: { status: "EXECUTED", outcome: { result: { orderId: 123 } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["origin", "rp", "uv", "signature", "challenge", "purpose", "crossOrigin"])("rejects incorrect %s with real signatures", async failure => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare();
    const options = await t.approveOptions(proposal.proposalId);
    const response = await t.key.authenticate(failure === "challenge" ? "wrong-challenge" : options.options.challenge, {
      ...(failure === "origin" ? { origin: "https://evil.example" } : {}),
      ...(failure === "rp" ? { rp: "evil.example" } : {}),
      ...(failure === "uv" ? { uv: false } : {}),
      ...(failure === "signature" ? { badSignature: true } : {}),
      ...(failure === "purpose" ? { type: "webauthn.create" } : {}),
      ...(failure === "crossOrigin" ? { crossOrigin: true } : {}),
    });
    expect((await t.browser("/verify", { challengeId: options.challengeId, response })).status).toBe(403);
    const status = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } });
    expect(await status.json()).toMatchObject({ result: { status: "PENDING" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("binds responses to proposal, browser session and operation, and claims concurrent approvals once", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    const first = await t.prepare(); const second = await t.prepare();
    const a = await t.approveOptions(first.proposalId); const b = await t.approveOptions(second.proposalId);
    expect((await t.browser("/verify", { challengeId: b.challengeId, response: await t.key.authenticate(a.options.challenge) })).status).toBe(403);
    const other = await (await t.post("/security/session/create", {})).json<{ sessionId: string; session: BrowserSession }>();
    expect((await t.post("/security/verify", { sessionId: other.sessionId, csrf: other.session.csrf, challengeId: a.challengeId, response: await t.key.authenticate(a.options.challenge) })).status).toBe(403);
    const c = await t.approveOptions(first.proposalId); const d = await t.approveOptions(first.proposalId);
    const [r1, r2] = await Promise.all([
      t.browser("/verify", { challengeId: c.challengeId, response: await t.key.authenticate(c.options.challenge) }),
      t.browser("/verify", { challengeId: d.challengeId, response: await t.key.authenticate(d.options.challenge) }),
    ]);
    expect([r1.status, r2.status]).toContain(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates stale policies and preserves protected delayed task modifications", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    const delayed = await t.prepare({ executionMode: "DELAYED", condition: { type: "TIME", operator: "AFTER", at: new Date(Date.now() + 60_000).toISOString() }, validUntil: new Date(Date.now() + 120_000).toISOString() });
    const options = await t.approveOptions(delayed.proposalId);
    const active = await (await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).json<{ result: { taskId: string } }>();
    expect(active.result.taskId).toBeTypeOf("string");
    expect(await (await completionPage(t, delayed.proposalId)).text()).toContain("授权完成，可以关闭页面");
    expect(fetchMock).not.toHaveBeenCalled();
    const edit = await t.prepare({ executionMode: "DELAYED", replacesTaskId: active.result.taskId, condition: { type: "TIME", operator: "AFTER", at: new Date(Date.now() + 60_000).toISOString() }, validUntil: new Date(Date.now() + 120_000).toISOString() }, plain);
    expect(edit.approvalMethod).toBe("passkey");
    expect(edit.confirmationToken).toBeUndefined();
    const editOptions = await t.approveOptions(edit.proposalId);
    const approved = await t.browser("/verify", { challengeId: editOptions.challengeId, response: await t.key.authenticate(editOptions.options.challenge) });
    expect(approved.status).toBe(200);
    const replacement = await approved.json<{ result: { taskId: string; version: number } }>();
    expect(replacement.result.taskId).toBeTypeOf("string");
    expect(replacement.result.version).toBe(2);
    const tasks = await runInDurableObject(t.vault, (_instance, state) => state.storage.sql.exec(
      "SELECT id, status, approval_method, client_id, policy_version FROM delayed_trade ORDER BY version",
    ).toArray());
    expect(tasks).toEqual([
      expect.objectContaining({ id: active.result.taskId, status: "CANCELLED", approval_method: "passkey" }),
      expect.objectContaining({ id: replacement.result.taskId, status: "ACTIVE", approval_method: "passkey", client_id: plain.clientId, policy_version: plain.securityPolicyVersion }),
    ]);
    const stale = await t.prepare(); const staleOptions = await t.approveOptions(stale.proposalId);
    await runInDurableObject(t.vault, (_instance, state) => {
      const store = new SecurityStore(state.storage, env as unknown as AppEnv);
      store.commitPolicy("enhanced", true, 1);
    });
    expect((await t.browser("/verify", { challengeId: staleOptions.challengeId, response: await t.key.authenticate(staleOptions.options.challenge) })).status).toBe(403);
    expect((await t.post("/trade/prepare", { identity: t.identity, input })).status).toBe(403);
    expect((await t.post("/trade/session/enable", { identity: { clientId: "enhanced", advancedSecurity: false, securityPolicyVersion: 0 }, input: { userInstruction: "enable" } })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["downgrade", "revoke", "version"] as const)("rejects ordinary-client protected task edits after a policy %s", async change => {
    const t = await setup();
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const delayed = { executionMode: "DELAYED", condition: { type: "TIME", operator: "AFTER", at: new Date(Date.now() + 60_000).toISOString() }, validUntil: new Date(Date.now() + 120_000).toISOString() };
    const original = await t.prepare(delayed);
    const options = await t.approveOptions(original.proposalId);
    const active = await (await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).json<{ result: { taskId: string } }>();
    const edit = await t.prepare({ ...delayed, replacesTaskId: active.result.taskId }, plain);
    const challenge = await t.approveOptions(edit.proposalId);
    const update = await t.post("/client/policy/update", {
      clientId: plain.clientId, expected: plain.securityPolicyVersion,
      ...(change === "revoke" ? { revoked: true } : { permissionLevel: change === "downgrade" ? "read_only" : "full_access" }),
    });
    expect(update.status).toBe(200);
    expect((await t.browser("/verify", { challengeId: challenge.challengeId, response: await t.key.authenticate(challenge.options.challenge) })).status).toBe(403);
    const tasks = await runInDurableObject(t.vault, (_instance, state) => state.storage.sql.exec("SELECT id, status FROM delayed_trade").toArray());
    expect(tasks).toEqual([{ id: active.result.taskId, status: "ACTIVE" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("expires challenges without fallback and blocks approval if the deployment switch turns off", async () => {
    const t = await setup();
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const proposal = await t.prepare(); const options = await t.approveOptions(proposal.proposalId);
    now += 120_001;
    expect((await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).status).toBe(403);
    const fresh = await t.approveOptions(proposal.proposalId);
    const switchTrading = (enabled: string) => runInDurableObject(t.vault, instance => {
      const runtimeEnv: unknown = Reflect.get(instance, "env");
      if (runtimeEnv !== null && typeof runtimeEnv === "object") Reflect.set(runtimeEnv, "ENABLE_TRADING", enabled);
    });
    await switchTrading("false");
    try {
      expect((await t.browser("/verify", { challengeId: fresh.challengeId, response: await t.key.authenticate(fresh.options.challenge) })).status).toBe(403);
    } finally { await switchTrading("true"); }
  });
});

describe("Passkey management and recovery", () => {
  it("requires an existing credential to add, rename, delete, or disable; cannot delete last", async () => {
    const t = await setup();
    expect((await t.browser("/options", { operation: "register" })).status).toBe(403);
    expect((await t.browser("/options", { operation: "delete", target: t.key.id })).status).toBe(403);
    const add = await (await t.browser("/options", { operation: "add" })).json<Options>();
    const authorized = await (await t.browser("/verify", { challengeId: add.challengeId, response: await t.key.authenticate(add.options.challenge) })).json<{ registrationTicket: string }>();
    const otherKey = await authenticator();
    const opts = await (await t.browser("/add-options", { ticket: authorized.registrationTicket, name: "Phone" })).json<Options>();
    expect((await t.browser("/add-verify", { challengeId: opts.challengeId, response: await otherKey.register(opts.options.challenge) })).status).toBe(200);
    expect((await t.browser("/add-options", { ticket: authorized.registrationTicket })).status).toBe(403);
    const rename = await (await t.browser("/options", { operation: "rename", target: otherKey.id, name: "New phone" })).json<Options>();
    expect((await t.browser("/verify", { challengeId: rename.challengeId, response: await t.key.authenticate(rename.options.challenge) })).status).toBe(200);
    const remove = await (await t.browser("/options", { operation: "delete", target: otherKey.id })).json<Options>();
    expect((await t.browser("/verify", { challengeId: remove.challengeId, response: await t.key.authenticate(remove.options.challenge) })).status).toBe(200);
    expect((await t.browser("/options", { operation: "delete", target: t.key.id })).status).toBe(403);
    expect((await t.post("/security/commit-policy", { clientId: "enhanced", permissionLevel: "full_access", advancedSecurity: false, expected: 1 })).status).toBe(403);
    const beginRes = await t.post("/security/authorization/begin", { intent: { ...pending, advancedSecurity: false, policyVersion: 1 }, clientName: "enhanced", currentAdvanced: true });
    const begin = await beginRes.json<{ sessionId: string; authorizationId: string }>();
    const sessionRes = await t.post("/security/session", { sessionId: begin.sessionId });
    const { session: disabling } = await sessionRes.json<{ session: BrowserSession }>();
    const options = await (await t.post("/security/authorization/options", { sessionId: begin.sessionId, csrf: disabling.csrf, authorizationId: begin.authorizationId })).json<Options>();
    const verified = await (await t.post("/security/authorization/verify", { sessionId: begin.sessionId, csrf: disabling.csrf, challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).json<{ authorizationId: string; status: string }>();
    expect(verified.status).toBe("APPROVED");
    const claim = await (await t.post("/security/authorization/claim", { authorizationId: begin.authorizationId, sessionId: begin.sessionId, csrf: disabling.csrf })).json<{ commitTicket: string }>();
    expect((await t.post("/security/commit-policy", { clientId: "enhanced", permissionLevel: "full_access", advancedSecurity: false, expected: 1, ticket: claim.commitTicket })).status).toBe(200);
  });

  it("atomically replaces keys only after fresh registration, invalidates old sessions and pending proposals but keeps activated tasks", async () => {
    const t = await setup();
    const delayed = await t.prepare({ executionMode: "DELAYED", condition: { type: "TIME", operator: "AFTER", at: new Date(Date.now() + 600_000).toISOString() }, validUntil: new Date(Date.now() + 1_200_000).toISOString() });
    const opt = await t.approveOptions(delayed.proposalId);
    expect((await t.browser("/verify", { challengeId: opt.challengeId, response: await t.key.authenticate(opt.options.challenge) })).status).toBe(200);
    const proposal = await t.prepare(); const old = await t.approveOptions(proposal.proposalId);
    const recovery = await (await t.post("/security/session/create", { recovery: true })).json<{ sessionId: string; session: BrowserSession }>();
    const recover = (path: string, data: Record<string, unknown>) => t.post(`/security${path}`, { ...data, sessionId: recovery.sessionId, csrf: recovery.session.csrf });
    expect((await t.browser("/options", { operation: "recover", resetConfirmation: "重置全部 Passkey" })).status).toBe(403);
    expect((await recover("/options", { operation: "recover", resetConfirmation: "reset" })).status).toBe(403);
    const options = await (await recover("/options", { operation: "recover", resetConfirmation: "重置全部 Passkey" })).json<Options>();
    const before = await (await t.browser("/session")).json<{ credentials: { id: string }[] }>();
    expect(before.credentials[0]?.id).toBe(t.key.id);
    const key = await authenticator();
    expect((await recover("/verify", { challengeId: options.challengeId, response: await key.register(options.options.challenge) })).status).toBe(200);
    expect((await t.browser("/verify", { challengeId: old.challengeId, response: await t.key.authenticate(old.options.challenge) })).status).toBe(403);
    expect((await t.browser("/session")).status).toBe(403);
    const status = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } });
    expect(await status.json()).toMatchObject({ result: { status: "INVALIDATED" } });
    const policy = await (await t.post("/security/policy", { clientId: "enhanced" })).json();
    expect(policy).toMatchObject({ advancedSecurity: true, version: 1 });
    const list = await (await t.post("/trade/list-delayed", { identity: t.identity, input: {} })).json();
    expect(list).toMatchObject({ result: [{ status: "ACTIVE" }] });
    expect(await runDurableObjectAlarm(t.vault)).toBe(true);
  });

  it.each(["origin", "rp", "uv"])("rejects registration with incorrect %s", async failure => {
    const t = await setup();
    const recovery = await (await t.post("/security/session/create", { recovery: true })).json<{ sessionId: string; session: BrowserSession }>();
    const args = { sessionId: recovery.sessionId, csrf: recovery.session.csrf };
    const options = await (await t.post("/security/options", { ...args, operation: "recover", resetConfirmation: "重置全部 Passkey" })).json<Options>();
    const key = await authenticator();
    const response = await key.register(options.options.challenge, { ...(failure === "origin" ? { origin: "https://evil.example" } : {}), ...(failure === "rp" ? { rp: "evil.example" } : {}), ...(failure === "uv" ? { uv: false } : {}) });
    expect((await t.post("/security/verify", { ...args, challengeId: options.challengeId, response })).status).toBe(403);
    expect((await t.browser("/session")).status).toBe(200);
  });
});

describe("Passkey persistence and execution regressions", () => {
  it("migrates existing proposals incrementally, repeatedly, without touching Schwab tokens or trade records", async () => {
    const t = await setup();
    const legacy = await t.prepare({}, plain);
    await runInDurableObject(t.vault, (_instance, state) => {
      const before = state.storage.sql.exec<{ access_token: string }>("SELECT access_token FROM schwab_token").one().access_token;
      for (const table of ["trade_proposal", "delayed_trade"]) for (const column of ["approval_method", "client_id", "policy_version"]) state.storage.sql.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      new SecurityStore(state.storage, env as unknown as AppEnv);
      new SecurityStore(state.storage, env as unknown as AppEnv);
      expect(state.storage.sql.exec("SELECT approval_method, policy_version, status FROM trade_proposal WHERE id = ?", legacy.proposalId).one()).toMatchObject({ approval_method: "conversation", policy_version: 0, status: "PENDING" });
      expect(state.storage.sql.exec("SELECT access_token FROM schwab_token").one().access_token).toBe(before);
    });
    expect((await t.post("/trade/prepare", { input })).status).toBe(403);
  });

  it("accepts synchronized zero counters but rejects a non-increasing nonzero counter", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201 })); vi.stubGlobal("fetch", fetchMock);
    const one = await t.prepare(); const a = await t.approveOptions(one.proposalId);
    expect((await t.browser("/verify", { challengeId: a.challengeId, response: await t.key.authenticate(a.options.challenge, { counter: 2 }) })).status).toBe(200);
    const two = await t.prepare(); const b = await t.approveOptions(two.proposalId);
    expect((await t.browser("/verify", { challengeId: b.challengeId, response: await t.key.authenticate(b.options.challenge, { counter: 1 }) })).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("activates and executes enhanced delayed orders exactly once with frozen provenance", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 201, headers: { Location: "/accounts/hash/orders/333" } })); vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare({ executionMode: "DELAYED", condition: { type: "TIME", operator: "AT_OR_BEFORE", at: new Date(Date.now() + 60_000).toISOString() }, validUntil: new Date(Date.now() + 120_000).toISOString() });
    const options = await t.approveOptions(proposal.proposalId);
    const response = await t.key.authenticate(options.options.challenge);
    expect((await t.browser("/verify", { challengeId: options.challengeId, response })).status).toBe(200);
    const duplicate = await t.browser("/verify", { challengeId: options.challengeId, response });
    expect(await duplicate.json()).toMatchObject({ status: "ACTIVE", outcome: { result: { status: "ACTIVE" } } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await runDurableObjectAlarm(t.vault)).toBe(true);
    const list = await t.post("/trade/list-delayed", { identity: t.identity, input: {} });
    expect(await list.json()).toMatchObject({ result: [{ status: "EXECUTED", approvalMethod: "passkey", clientId: "enhanced", securityPolicyVersion: 1, outcome: { result: { orderId: 333 } } }] });
    const polled = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } });
    expect(await polled.json()).toMatchObject({ result: { status: "EXECUTED", outcome: { result: { orderId: 333 } } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caps challenges at proposal lifetime and never approves expired proposals", async () => {
    const t = await setup();
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const proposal = await t.prepare();
    now += 299_000;
    const options = await t.approveOptions(proposal.proposalId);
    const lifetime = await runInDurableObject(t.vault, (_instance, state) => state.storage.sql.exec<{ expires_at: number }>("SELECT expires_at FROM oauth_state WHERE state = ?", options.challengeId).one().expires_at);
    expect(lifetime - now).toBe(1000);
    now += 1001;
    expect((await t.browser("/verify", { challengeId: options.challengeId, response: await t.key.authenticate(options.options.challenge) })).status).toBe(403);
    expect((await t.browser("/options", { operation: "approve", proposalId: proposal.proposalId })).status).toBe(403);
    const status = await t.post("/trade/proposal", { identity: t.identity, input: { proposalId: proposal.proposalId } });
    expect(await status.json()).toMatchObject({ result: { status: "EXPIRED" } });
  });
});

describe("Passkey submission outcomes", () => {
  it("reports an uncertain submission as an execution outcome, with no replay", async () => {
    const t = await setup();
    const fetchMock = vi.fn(() => new Response(null, { status: 503 })); vi.stubGlobal("fetch", fetchMock);
    const proposal = await t.prepare(); const options = await t.approveOptions(proposal.proposalId);
    const response = await t.key.authenticate(options.options.challenge);
    const result = await t.browser("/verify", { challengeId: options.challengeId, response });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ status: "EXECUTION_UNCERTAIN", error: { code: "EXECUTION_UNCERTAIN", attempts: 1 } });
    expect((await completionPage(t, proposal.proposalId)).status).toBe(409);
    const replay = await t.browser("/verify", { challengeId: options.challengeId, response });
    expect(await replay.json()).toMatchObject({ status: "EXECUTION_UNCERTAIN", outcome: { error: { code: "EXECUTION_UNCERTAIN" } } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("Cross-device client authorization (OAuth Passkey)", () => {
  it("holds same-client finishing exclusion across new attempts and expired envelope cleanup", async () => {
    const t = await setup();
    const intent: PendingAuthorization = {
      ...pending, advancedSecurity: false, permissionLevel: "read_only",
      authRequest: { ...pending.authRequest, clientId: "finishing-exclusion" },
    };
    const begin = async () => {
      const response = await t.post("/security/authorization/begin", { intent, clientName: "Finishing client", currentAdvanced: false });
      expect(response.status).toBe(200);
      const { sessionId, authorizationId } = await response.json<{ sessionId: string; authorizationId: string }>();
      return { sessionId, authorizationId };
    };
    const first = await begin();
    expect((await t.post("/security/authorization/claim", first)).status).toBe(200);
    const second = await begin();
    expect(await (await t.post("/security/authorization/status", first)).json()).toMatchObject({ status: "FINISHING" });
    expect((await t.post("/security/authorization/claim", second)).status).toBe(403);
    await runInDurableObject(t.vault, (_instance, state) => {
      state.storage.sql.exec("UPDATE oauth_state SET expires_at = 0 WHERE state = ?", first.authorizationId);
    });
    // Saving another session removes expired oauth_state rows, not the mutex.
    await t.post("/security/session/create", {});
    expect((await t.post("/security/authorization/claim", second)).status).toBe(403);
    expect((await t.post("/security/authorization/fail", { authorizationId: first.authorizationId })).status).toBe(200);
    expect((await t.post("/security/authorization/claim", second)).status).toBe(200);
  });

  it.each([
    { permissionLevel: "full_access" },
    { advancedSecurity: true },
    { expected: 1 },
  ])("rejects changes to frozen authorization policy bindings: %j", async changes => {
    const t = await setup();
    const clientId = "frozen-bindings";
    const intent: PendingAuthorization = {
      ...pending, advancedSecurity: false, permissionLevel: "read_only",
      authRequest: { ...pending.authRequest, clientId },
    };
    const { sessionId, authorizationId } = await (await t.post("/security/authorization/begin", { intent, clientName: clientId, currentAdvanced: false })).json<{ sessionId: string; authorizationId: string }>();
    const claimResponse = await t.post("/security/authorization/claim", { sessionId, authorizationId });
    expect(claimResponse.status).toBe(200);
    const claim = await claimResponse.json<{ commitTicket: string }>();
    const frozen = { clientId, permissionLevel: "read_only", advancedSecurity: false, expected: 0, ticket: claim.commitTicket };
    expect((await t.post("/security/commit-policy", { ...frozen, ...changes })).status).toBe(403);
    expect(await (await t.post("/security/policy", { clientId })).json()).toMatchObject({ version: 0 });
    expect((await t.post("/security/commit-policy", frozen)).status).toBe(200);
  });

  it("allows phone owner to sign while only computer original session can claim and resume code", async () => {
    const t = await setup();

    // 1. Computer initiates enhanced authorization
    const clientPending: PendingAuthorization = {
      authRequest: {
        clientId: "cross-device-client",
        redirectUri: "https://client.example/callback",
        responseType: "code",
        scope: ["schwab.read"],
        state: "test-state",
        codeChallenge: "b".repeat(43),
        codeChallengeMethod: "S256",
      },
      permissionLevel: "full_access",
      advancedSecurity: true,
      username: "owner",
      policyVersion: 0,
    };

    const beginRes = await t.post("/security/authorization/begin", {
      intent: clientPending,
      clientName: "Cross Device Client",
      currentAdvanced: false,
    });
    expect(beginRes.status).toBe(200);
    const begin = await beginRes.json<{ sessionId: string; authorizationId: string; requiresPasskey: boolean; status: string }>();
    expect(begin.requiresPasskey).toBe(true);
    expect(begin.status).toBe("PENDING");

    const compSession = (await (await t.post("/security/session", { sessionId: begin.sessionId })).json<{ session: BrowserSession }>()).session;

    // 2. Phone logs in as owner (different session)
    const phoneSessionRes = await t.post("/security/session/create", {});
    const phoneState = await phoneSessionRes.json<{ sessionId: string; session: BrowserSession }>();

    // 3. Phone inspects authorization details
    const detailsRes = await t.post("/security/authorization/details", {
      sessionId: phoneState.sessionId,
      csrf: phoneState.session.csrf,
      authorizationId: begin.authorizationId,
    });
    expect(detailsRes.status).toBe(200);
    const details = await detailsRes.json<{
      authorization: { clientName: string; clientId: string; status: string; digest: string };
      isOriginalSession: boolean;
    }>();
    expect(details.authorization.clientName).toBe("Cross Device Client");
    expect(details.authorization.status).toBe("PENDING");
    expect(details.isOriginalSession).toBe(false);

    // 4. Phone cannot resume unapproved authorization
    const prematureResume = await t.post("/security/authorization/claim", {
      authorizationId: begin.authorizationId,
      sessionId: phoneState.sessionId,
      csrf: phoneState.session.csrf,
    });
    expect(prematureResume.status).toBe(403);

    // 5. Phone fetches options and verifies with Passkey
    const optionsRes = await t.post("/security/authorization/options", {
      sessionId: phoneState.sessionId,
      csrf: phoneState.session.csrf,
      authorizationId: begin.authorizationId,
    });
    expect(optionsRes.status).toBe(200);
    const options = await optionsRes.json<Options>();

    const verifyRes = await t.post("/security/authorization/verify", {
      sessionId: phoneState.sessionId,
      csrf: phoneState.session.csrf,
      challengeId: options.challengeId,
      response: await t.key.authenticate(options.options.challenge),
    });
    expect(verifyRes.status).toBe(200);
    const verifyResult = await verifyRes.json<{ authorizationId: string; status: string }>();
    expect(verifyResult.status).toBe("APPROVED");
    // Verify phone receives NO code or commit ticket
    expect(Reflect.has(verifyResult, "code")).toBe(false);
    expect(Reflect.has(verifyResult, "redirectTo")).toBe(false);
    expect(Reflect.has(verifyResult, "commitTicket")).toBe(false);

    // 6. Phone attempts to claim/resume -> REJECTED (not original session)
    const phoneClaim = await t.post("/security/authorization/claim", {
      authorizationId: begin.authorizationId,
      sessionId: phoneState.sessionId,
      csrf: phoneState.session.csrf,
    });
    expect(phoneClaim.status).toBe(403);

    // 7. Computer (original session) claims and resumes
    const compClaimRes = await t.post("/security/authorization/claim", {
      authorizationId: begin.authorizationId,
      sessionId: begin.sessionId,
      csrf: compSession.csrf,
    });
    expect(compClaimRes.status).toBe(200);
    const claim = await compClaimRes.json<{ commitTicket: string; finishingId: string }>();
    expect(claim.commitTicket).toBeTruthy();

    // Commit policy and finalize
    const commitRes = await t.post("/security/commit-policy", {
      clientId: "cross-device-client",
      permissionLevel: "full_access",
      advancedSecurity: true,
      expected: 0,
      ticket: claim.commitTicket,
    });
    expect(commitRes.status).toBe(200);

    const finalizeRes = await t.post("/security/authorization/finalize", {
      authorizationId: begin.authorizationId,
      finishingId: claim.finishingId,
      originalSessionId: begin.sessionId,
      authorizationEventId: crypto.randomUUID(),
    });
    expect(finalizeRes.status).toBe(200);

    // 8. Replay claim/resume -> fails because original session deleted and status COMPLETED
    const replayClaim = await t.post("/security/authorization/claim", {
      authorizationId: begin.authorizationId,
      sessionId: begin.sessionId,
      csrf: compSession.csrf,
    });
    expect(replayClaim.status).toBe(403);
  });

  it("cancels authorization cleanly and prevents approval or resume", async () => {
    const t = await setup();
    const clientPending: PendingAuthorization = {
      authRequest: {
        clientId: "cancel-test-client",
        redirectUri: "https://client.example/callback",
        responseType: "code",
        scope: ["schwab.read"],
        state: "test-state",
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
      },
      permissionLevel: "full_access",
      advancedSecurity: true,
      username: "owner",
      policyVersion: 0,
    };

    const beginRes = await t.post("/security/authorization/begin", {
      intent: clientPending,
      clientName: "Cancel Client",
      currentAdvanced: false,
    });
    const begin = await beginRes.json<{ sessionId: string; authorizationId: string }>();
    const compSession = (await (await t.post("/security/session", { sessionId: begin.sessionId })).json<{ session: BrowserSession }>()).session;

    // Cancel request
    const cancelRes = await t.post("/security/authorization/cancel", {
      sessionId: begin.sessionId,
      csrf: compSession.csrf,
      authorizationId: begin.authorizationId,
    });
    expect(cancelRes.status).toBe(200);

    // Check status is CANCELLED
    const statusRes = await t.post("/security/authorization/status", {
      sessionId: begin.sessionId,
      csrf: compSession.csrf,
      authorizationId: begin.authorizationId,
    });
    expect(await statusRes.json()).toMatchObject({ status: "CANCELLED" });

    // Cannot claim or get options
    const optionsRes = await t.post("/security/authorization/options", {
      sessionId: begin.sessionId,
      csrf: compSession.csrf,
      authorizationId: begin.authorizationId,
    });
    expect(optionsRes.status).toBe(403);
  });
});
