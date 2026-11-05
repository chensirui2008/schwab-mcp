import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { URL } from 'node:url';
import { build } from 'esbuild';

async function loadModule(path) {
  const bundle = await build({ entryPoints: [path], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}
const [auth, security, sw] = await Promise.all([
  loadModule('src/auth-ui.ts'),
  loadModule('src/security-ui.ts'),
  readFile(new URL('../public/sw.js', import.meta.url), 'utf8'),
]);
const scripts = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const session = { csrf: 'test', expiresAt: Date.now() + 900_000, credentialVersion: 1, recovery: false };

test('transient consent language switches without replaying OAuth or changing selected accounts', async () => {
  for (const html of [
    String(await auth.renderAccountSelectionPage({ state: 'single-use-state', clientName: 'Client', accounts: [{ hashValue: 'hash', label: '••••1234' }], selected: ['hash'], connected: false, lang: 'en-US' })),
    String(await auth.renderClientContinuePage('https://client.example/cb?code=opaque&state=s', 'en-US')),
  ]) {
    const elements = [...html.matchAll(/<[^>]*data-auth-i18n="(\w+)"[^>]*>([^<]*)</g)].map(match => ({ dataset: { authI18n: match[1] }, textContent: match[2] }));
    assert.ok(elements.length >= 4);
    const select = { addEventListener(type, handler) { assert.equal(type, 'change'); this.change = handler; } };
    const document = {
      documentElement: { lang: 'en-US' },
      getElementById: id => { assert.equal(id, 'auth-language'); return select; },
      querySelectorAll: selector => { assert.equal(selector, '[data-auth-i18n]'); return elements; },
    };
    // No location/fetch globals: any navigation or request during switching fails.
    runInNewContext(scripts(html).find(script => script.includes('const translations')), { document });
    for (const lang of ['zh-CN', 'en-US']) {
      select.change({ target: { value: lang } });
      assert.equal(document.documentElement.lang, lang);
      assert.match(document.cookie, new RegExp(`schwab_lang=${lang}; Path=/;`));
      if (lang === 'en-US') {
        elements.forEach(element => assert.doesNotMatch(element.textContent, /\p{Script=Han}/u));
        assert.ok(elements.some(element => /Select accounts|Return to client/.test(element.textContent)));
      } else {
        assert.ok(elements.some(element => /选择授权账户|返回客户端/.test(element.textContent)));
      }
    }
  }
});

async function authorizationUi(lang, original = false) {
  const html = String(await security.renderClientAuthorizationPage(session, {
    id: 'auth', clientName: 'Client', clientId: 'client', permissionLevel: 'full_access',
    advancedSecurity: true, redirectUri: 'https://client.example/cb', status: 'PENDING',
    createdAt: Date.now(), expiresAt: session.expiresAt, digest: 'digest',
  }, [{ id: 'key', name: 'Test Key' }], original, lang));
  assert.ok(html.includes(lang === 'en-US' ? 'Authorized accounts' : '授权账户'));
  assert.ok(html.includes(lang === 'en-US' ? 'Market data only' : '仅行情'));
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', addEventListener(type, handler) { this[type] = handler; }, remove() {} });
    return elements.get(id);
  };
  const pageData = html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const intervals = [];
  const context = {
    document: {
      querySelectorAll: () => [],
      querySelector: selector => selector === 'meta[name="csrf"]' ? { content: 'test' } : selector === '#page-data' ? { textContent: pageData } : get(selector),
    },
    window: { PublicKeyCredential: function () {} }, navigator: { credentials: {} },
    setInterval: handler => { intervals.push(handler); return handler; },
    clearInterval() {},
    fetch: async () => ({ ok: true, json: async () => ({ challengeId: 'challenge', status: 'EXPIRED' }) }),
  };
  runInNewContext(scripts(html).find(script => script.includes('async function act(')), context);
  runInNewContext('ceremony = async () => ({id: "test"})', context);
  return { get, context, intervals };
}

for (const lang of ['zh-CN', 'en-US']) {
  test(`client authorization progress, cancellation, and polling are localized (${lang})`, async () => {
    const ui = await authorizationUi(lang);
    const english = lang === 'en-US';
    const stage = ui.get('#stage-auth-btn').click();
    assert.match(ui.get('#status').textContent, english ? /Loading approval options/ : /正在获取核准选项/);
    await stage;
    assert.match(ui.get('#status').textContent, english ? /Options ready/ : /选项已准备就绪/);
    const submit = ui.get('#submit-auth-btn').click();
    assert.match(ui.get('#status').textContent, english ? /Please complete Passkey verification/ : /请在系统提示中完成 Passkey/);
    await submit;
    assert.match(ui.get('#status').textContent, english ? /Approved with Passkey/ : /成功核准/);

    const cancelled = await authorizationUi(lang);
    await cancelled.get('#cancel-auth-btn').click();
    assert.equal(cancelled.get('#status').textContent, english ? 'This request has been cancelled.' : '已取消本次申请。');

    const denied = await authorizationUi(lang);
    await denied.get('#stage-auth-btn').click();
    runInNewContext('ceremony = async () => { const error = new Error(); error.name = "NotAllowedError"; throw error; }', denied.context);
    await denied.get('#submit-auth-btn').click();
    assert.match(denied.get('#status').textContent, english ? /cancelled or timed out/ : /已取消或超时/);

    const polling = await authorizationUi(lang, true);
    await polling.intervals[0]();
    assert.equal(polling.get('#status').textContent, english ? 'Authorization status changed to: EXPIRED' : '授权状态已变更为: EXPIRED');
  });
}

async function push(payload, language = 'en-US', malformed = false) {
  const handlers = {};
  const shown = [];
  const self = {
    navigator: { language },
    addEventListener: (type, handler) => { handlers[type] = handler; },
    registration: { showNotification: async (title, options) => { shown.push({ title, ...options }); } },
    clients: { matchAll: async () => [] },
  };
  runInNewContext(sw, { self });
  let pending;
  handlers.push({
    data: payload === null ? null : { json: () => { if (malformed) throw new Error('invalid JSON'); return payload; } },
    waitUntil: promise => { pending = promise; },
  });
  await pending;
  return shown[0];
}

test('all push templates follow the browser language, with optional payload override', async () => {
  const titles = {
    CLIENT_AUTHORIZATION_PENDING: ['Client authorization awaiting approval', '客户端授权待批准'],
    CLIENT_AUTHORIZED: ['Client authorization completed', '客户端授权已完成'],
    TRADE_APPROVAL_PENDING: ['Trade proposal awaiting approval', '交易提案待批准'],
    TRADE_RESULT: ['Trade request status updated', '交易请求状态更新'],
    SCHWAB_REAUTH_DUE_SOON: ['Schwab authorization expiring soon', 'Schwab 授权即将到期'],
    SCHWAB_REAUTH_REQUIRED: ['Schwab authorization expired', 'Schwab 授权已失效'],
    TEST: ['Test notification', '测试通知'],
  };
  for (const [type, [english, chinese]] of Object.entries(titles)) {
    const en = await push({ type }, 'en-GB');
    assert.equal(en.title, english);
    assert.equal(en.lang, 'en-US');
    assert.doesNotMatch(en.body, /\p{Script=Han}/u);
    assert.equal((await push({ type }, 'zh-TW')).title, chinese);
    assert.equal((await push({ type, lang: 'en-US' }, 'zh-CN')).title, english);
    assert.equal((await push({ type, lang: 'zh-CN' }, 'en-US')).title, chinese);
  }
});

test('empty, malformed, unknown, and prototype push payloads use safe localized defaults', async () => {
  for (const language of ['en-US', 'zh-CN']) {
    for (const payload of [null, {}, { type: 'UNKNOWN' }, { type: '__proto__' }, { type: 'constructor' }, { type: 'TEST' }]) {
      const notification = await push(payload, language, payload?.type === 'TEST');
      assert.equal(notification.title, language === 'en-US' ? 'Schwab MCP alert' : 'Schwab MCP 提醒');
      assert.equal(notification.lang, language);
      assert.equal(notification.tag, 'schwab-mcp-notification');
    }
  }
  assert.equal((await push({ type: 'TEST', lang: 'invalid' }, 'en-US')).title, 'Test notification');
});
