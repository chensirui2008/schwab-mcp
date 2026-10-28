import { test } from 'node:test';
import { Buffer, atob, btoa } from 'node:buffer';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { startAcceptance } from './passkey-acceptance.mjs';

const { fetch } = globalThis;

const bundle = await build({ entryPoints: ['src/security-ui.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { renderSecurityPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const html = String(await renderSecurityPage({ csrf: 'test', expiresAt: Date.now() + 900_000, credentialVersion: 1, recovery: false }, [{ id: 'last', name: 'last' }]));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
test('cancelled native verification preserves disabled last-key deletion and permits retry', async () => {
  const buttons = [{ disabled: true }, { disabled: false }];
  const status = { textContent: '' };
  const context = {
    document: {
      querySelectorAll: selector => selector === 'button' ? buttons : [],
      querySelector: selector => ({ '#status': status, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: '{}' } })[selector],
    },
    window: { PublicKeyCredential: function () {} },
    navigator: { credentials: { get: async () => { const e = new Error(); e.name = 'NotAllowedError'; throw e; } } },
    fetch: async () => ({ ok: true, json: async () => ({ registration: false, options: { challenge: 'YQ', allowCredentials: [] } }) }),
    atob, btoa, Uint8Array,
  };
  runInNewContext(script, context);
  await runInNewContext('act("rename", "last")', context);
  assert.match(status.textContent, /取消或超时/);
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false);
});
test('unsupported browser disables every operation', () => {
  const buttons = [{ disabled: false }];
  const status = { textContent: '' };
  runInNewContext(script, { document: { querySelectorAll: s => s === 'button' ? buttons : [], querySelector: s => ({ '#status': status, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: '{}' } })[s] }, window: {}, navigator: {} });
  assert.match(status.textContent, /不支持 WebAuthn/);
  assert.equal(buttons[0].disabled, true);
});

test('rejecting a draft works without WebAuthn and redirects only after successful cancellation', async () => {
  for (const fails of [false, true]) {
    const reject = { id: 'reject-order', disabled: false, addEventListener(_type, handler) { this.click = handler; } };
    const approve = { id: 'approve', disabled: false };
    const status = { textContent: '' };
    const redirects = [];
    const calls = [];
    let finish;
    const context = {
      document: {
        querySelectorAll: selector => selector === 'button' ? [approve, reject] : [],
        querySelector: selector => ({ '#reject-order': reject, '#status': status, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: '{"proposalId":"draft"}' } })[selector],
      },
      window: {}, navigator: {},
      location: { assign: path => redirects.push(path) },
      fetch: async (path, options) => {
        calls.push({ path, options });
        await new Promise(resolve => { finish = resolve; });
        return { ok: !fails, json: async () => fails ? { error: { message: 'Unable to cancel' } } : { status: 'CANCELLED', redirectTo: '/dashboard' } };
      },
    };
    runInNewContext(script, context);
    assert.equal(approve.disabled, true);
    assert.equal(reject.disabled, false);
    const pending = reject.click();
    assert.equal(reject.disabled, true);
    await reject.click();
    assert.equal(calls.length, 1);
    assert.deepEqual(redirects, []);
    finish();
    await pending;
    assert.equal(calls[0].path, '/security/api/reject-proposal');
    assert.equal(calls[0].options.headers['X-CSRF-Token'], 'test');
    assert.deepEqual(JSON.parse(calls[0].options.body), { proposalId: 'draft' });
    assert.deepEqual(redirects, fails ? [] : ['/dashboard']);
    if (fails) assert.equal(status.textContent, 'Unable to cancel');
    assert.equal(reject.disabled, false);
    assert.equal(approve.disabled, true);
  }
});

test('verification failures preserve passkeys and allow retry on management and registration paths', async () => {
  for (const registration of [false, true]) {
    for (const offline of [false, true]) {
      const status = { textContent: '' };
      const button = { disabled: false, dataset: { ticket: 'ticket' }, addEventListener(_type, handler) { this.click = handler; } };
      let deleted = false;
      let failed = true;
      let reloads = 0;
      const key = { signalUnknownCredential: async () => { deleted = true; } };
      const context = {
        document: {
          querySelectorAll: selector => selector === 'button' ? [button] : [],
          querySelector: selector => ({ '#status': status, '#register-add': button, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: '{}' } })[selector],
        },
        window: { PublicKeyCredential: key }, PublicKeyCredential: key,
        navigator: { credentials: {} },
        location: { hostname: 'localhost', reload() { reloads++; } },
        fetch: async path => {
          if (path.endsWith('verify') && failed) {
            if (offline) throw new Error('offline');
            return { ok: false, json: async () => ({ error: { message: 'service unavailable' } }) };
          }
          return { ok: true, json: async () => ({}) };
        },
      };
      runInNewContext(script, context);
      runInNewContext('ceremony = async () => ({id: "valid-passkey"})', context);
      const invoke = () => registration ? button.click({ currentTarget: button }) : runInNewContext('act("rename", "last")', context);
      await invoke();
      assert.equal(deleted, false, 'a verification error must not delete the authenticator credential');
      assert.equal(status.textContent, offline ? 'offline' : 'service unavailable');
      assert.equal(reloads, 0);
      assert.equal(button.disabled, false);
      failed = false;
      await invoke();
      assert.equal(reloads, 1, 'the same credential can be retried');
    }
  }
});
test('approval redirects only completed results and preserves errors', async () => {
  for (const result of [
    { status: 'EXECUTED' }, { result: { status: 'ACTIVE' } }, { status: 'ACTIVE' },
    { status: 'FAILED', error: { message: 'Schwab rejected the order' } },
    { status: 'EXECUTION_UNCERTAIN', error: { message: 'Verify order status' } },
    { status: 'EXECUTION_UNCERTAIN' }, { status: 'EXECUTING' },
  ]) {
    const status = { textContent: '' };
    const approval = { disabled: false, hidden: false };
    const redirects = [];
    const context = {
      document: {
        querySelectorAll: selector => selector === 'button' ? [approval] : [],
        querySelector: selector => ({ '#status': status, '#approve': approval, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: '{"proposalId":"proposal-123"}' } })[selector],
      },
      window: { PublicKeyCredential: function () {} }, navigator: { credentials: {} },
      location: { replace: url => redirects.push(url) },
      fetch: async path => ({ ok: true, json: async () => path.endsWith('/options') ? { challengeId: 'challenge' } : result }),
      atob, btoa, Uint8Array,
    };
    runInNewContext(script, context);
    runInNewContext('ceremony = async () => ({})', context);
    await runInNewContext('act("approve")', context);
    const success = result.status === 'EXECUTED' || result.status === 'ACTIVE' || result.result?.status === 'ACTIVE';
    assert.deepEqual(redirects, success ? ['/security/approvals/proposal-123/complete'] : []);
    if (result.error) assert.equal(status.textContent, result.error.message);
  }
});
test('batch approval uses one native assertion and reloads persisted results without completion redirects', async () => {
  for (const batchStatus of ['PARTIALLY_EXECUTED', 'EXECUTION_UNCERTAIN', 'EXECUTED']) {
    const session = { csrf: 'test', expiresAt: Date.now() + 900_000, credentialVersion: 1, recovery: false };
    const preview = { accountHash: 'a'.repeat(32), action: 'BATCH', executionMode: 'IMMEDIATE', orders: [{ action: 'PLACE', orderPayload: {} }] };
    const proposal = { proposalId: 'batch-123', status: 'PENDING', preview, intentDigest: 'digest', expiresAt: new Date().toISOString(), outcome: null };
    const page = String(await renderSecurityPage(session, [], proposal, 'en-US'));
    const batchScript = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
    const pageData = page.match(/<script id="page-data" type="application\/json">([^<]*)<\/script>/)[1];
    const calls = [];
    const redirects = [];
    const persisted = { result: { proposalId: proposal.proposalId, status: batchStatus, orders: [{ index: 1, action: 'PLACE', status: batchStatus === 'EXECUTED' ? 'EXECUTED' : 'NOT_SUBMITTED' }] } };
    let nativeCalls = 0;
    let reloaded = '';
    const reloads = [];
    const context = {
      document: {
        querySelectorAll: () => [],
        querySelector: selector => ({ '#status': { textContent: '' }, 'meta[name="csrf"]': { content: 'test' }, '#page-data': { textContent: pageData } })[selector],
      },
      window: { PublicKeyCredential: function () {} },
      navigator: { credentials: { get: async () => { nativeCalls++; return { toJSON: () => ({ id: 'signed-credential' }) }; } } },
      location: {
        assign: url => redirects.push(url),
        replace: url => redirects.push(url),
        reload: () => { reloads.push(Promise.resolve(renderSecurityPage(session, [], { ...proposal, status: batchStatus, outcome: persisted }, 'en-US')).then(value => { reloaded = String(value); })); },
      },
      fetch: async (path, options) => {
        calls.push({ path, body: JSON.parse(options.body) });
        return { ok: true, json: async () => path.endsWith('/options')
          ? { registration: false, challengeId: 'challenge', options: { challenge: 'YQ', allowCredentials: [] } }
          : persisted };
      },
      atob, btoa, Uint8Array,
    };
    runInNewContext(batchScript, context);
    await runInNewContext('act("approve")', context);
    await Promise.all(reloads);
    assert.equal(nativeCalls, 1);
    assert.deepEqual(calls.map(call => call.path), ['/security/api/options', '/security/api/verify']);
    assert.equal(calls[0].body.proposalId, proposal.proposalId);
    assert.deepEqual(calls[1].body.response, { id: 'signed-credential' });
    assert.deepEqual(redirects, []);
    assert.match(reloaded, new RegExp(batchStatus));
    assert.match(reloaded, new RegExp(persisted.result.orders[0].status));
  }
});

test('isolated fixture serves real UI, rejects foreign origins and cannot create an unregistered approval', async () => {
  const server = await startAcceptance(8792);
  try {
    const base = 'http://localhost:8792';
    const page = await fetch(base + '/security');
    assert.match(await page.text(), /仅本机模拟验收/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    const approval = await fetch(base + '/approve', { redirect: 'manual' });
    assert.equal(approval.status, 302);
    const denied = await fetch(base + '/security/api/options', { method: 'POST', headers: { Origin: 'https://foreign.example' }, body: '{}' });
    assert.equal(denied.status, 403);
    assert.deepEqual(await (await fetch(base + '/status')).json(), { environment: 'LOCAL_UI_FIXTURE', credentialRegistered: false, simulatedSubmissions: 0, realSchwabRequests: 0 });
    assert.match(await (await fetch(base + '/unsupported')).text(), /Object.defineProperty\(window,"PublicKeyCredential"/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('mobile fixture only accepts a fixed HTTPS quick-tunnel origin and binds RP ID to it', async () => {
  await assert.rejects(startAcceptance(8794, 'https://production.example'), /exact HTTPS/);
  await assert.rejects(startAcceptance(8794, 'http://test.trycloudflare.com'), /exact HTTPS/);
  const origin = 'https://test.trycloudflare.com';
  const server = await startAcceptance(8794, origin);
  try {
    const html = await (await fetch('http://localhost:8794/security')).text();
    const csrf = html.match(/name="csrf" content="([^"]+)"/)[1];
    const options = await (await fetch('http://localhost:8794/security/api/options', { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': csrf }, body: JSON.stringify({ operation: 'register' }) })).json();
    assert.equal(options.options.rp.id, 'test.trycloudflare.com');
    assert.equal(options.options.authenticatorSelection.userVerification, 'required');
    const denied = await fetch('http://localhost:8794/security/api/options', { method: 'POST', headers: { Origin: 'http://localhost:8794', 'X-CSRF-Token': csrf }, body: '{}' });
    assert.equal(denied.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
