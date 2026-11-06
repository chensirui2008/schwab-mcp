import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
}
const [{ renderSecurityPage, renderClientAuthorizationPage }, { renderDashboardPage }, { getDictionary, getDashboardClientI18n }] =
  await Promise.all([load('src/security-ui.ts'), load('src/dashboard-ui.ts'), load('src/i18n.ts')]);
const session = { csrf: 'test', expiresAt: Date.now() + 900_000, credentialVersion: 1, recovery: true };
const scripts = html => [...String(html).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
function element() {
  return {
    hidden: true, value: '', dataset: {}, disabled: false, events: {}, children: [], textContent: '',
    addEventListener(name, callback) { this.events[name] = callback; },
    setAttribute() {}, append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  };
}

async function securityUi({ lang = 'zh-CN', operation = 'recover', phrase = '重置全部 Passkey', name = 'Passkey', count = 2, response, networkError, authorization = false } = {}) {
  const credentials = Array.from({ length: count }, (_, i) => ({ id: 'key-' + i, name: 'Passkey' }));
  const html = String(await (authorization
    ? renderClientAuthorizationPage(session, { id: 'auth-test', status: 'PENDING', clientName: 'test', clientId: 'test', permissionLevel: 'full_access', advancedSecurity: true, redirectUri: 'https://client.example/callback', createdAt: Date.now(), expiresAt: session.expiresAt, digest: 'test' }, credentials, true, lang)
    : renderSecurityPage(session, credentials, undefined, lang)));
  const data = html.match(/<script id="page-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('reset-confirmation').value = phrase;
  get('credential-name').value = name;
  const button = get('operation');
  button.dataset = { operation, target: 'key-0' };
  const calls = [];
  const intervals = [];
  const context = {
    window: { PublicKeyCredential: {} },
    navigator: { credentials: { create: async () => null, get: async () => null } },
    document: {
      querySelector: selector => selector === '#page-data' ? { textContent: data } : selector.startsWith('meta') ? { content: 'test' } : get(selector.slice(1)),
      querySelectorAll: selector => selector === 'button' || selector === '[data-operation]' ? [button] : [],
    },
    fetch: async (...args) => {
      calls.push(args);
      if (networkError) throw new Error('private native network diagnostic');
      return { ok: false, status: 403, json: async () => response ?? {}, ...response?.http };
    },
    location: { assign() {}, replace() {}, reload() {} },
    setInterval(callback) { intervals.push(callback); return 1; }, clearInterval() {},
  };
  runInNewContext(scripts(html).find(script => script.includes('async function api(')), context);
  return { context, get, button, calls, intervals };
}

for (const lang of ['zh-CN', 'en-US']) {
  const dict = getDictionary(lang);
  test(`${lang}: recovery phrase is checked exactly before any request`, async () => {
    for (const phrase of ['', 'wrong phrase', '重置全部 Passkey ']) {
      const ui = await securityUi({ lang, phrase });
      await ui.button.events.click();
      assert.equal(ui.calls.length, 0);
      assert.equal(ui.get('status').textContent, dict.security.scriptRecoveryMismatch);
      assert.equal(ui.button.disabled, false);
    }
    const ui = await securityUi({ lang, response: { error: { code: 'SECURITY_VERIFICATION_FAILED' } } });
    await ui.button.events.click();
    assert.equal(ui.calls.length, 1);
    assert.equal(JSON.parse(ui.calls[0][1].body).resetConfirmation, '重置全部 Passkey');
  });

  test(`${lang}: empty names and deleting the last credential have useful local errors`, async () => {
    for (const operation of ['register', 'rename', 'add', 'recover']) {
      const ui = await securityUi({ lang, name: '  ', operation });
      await ui.button.events.click();
      assert.equal(ui.calls.length, 0);
      assert.equal(ui.get('status').textContent, dict.security.scriptInvalidName);
    }
    const ui = await securityUi({ lang, operation: 'delete', count: 1 });
    await ui.button.events.click();
    assert.equal(ui.calls.length, 0);
    assert.equal(ui.get('status').textContent, dict.security.cannotDeleteLast);
  });

  test(`${lang}: API errors use codes, never raw codes or server prose`, async () => {
    for (const code of Object.keys(dict.browserErrors)) {
      const ui = await securityUi({ lang, response: { error: { code, message: 'private English upstream message <script>' } } });
      await ui.button.events.click();
      assert.equal(ui.get('status').textContent, dict.browserErrors[code]);
      assert.equal(ui.get('security-login').hidden, code !== 'BROWSER_AUTH_REQUIRED');
      if (code === 'BROWSER_AUTH_REQUIRED') {
        assert.equal(ui.button.disabled, true);
        await ui.button.events.click();
        assert.equal(ui.calls.length, 1, 'expired sessions cannot restart an operation');
      }
    }
  });

  test(`${lang}: missing/unknown codes, invalid JSON and network failures use the full fallback`, async () => {
    for (const options of [
      { response: {} }, { response: { error: { message: 'English error' } } },
      { response: { error: { code: 'FUTURE_ERROR', message: 'English error' } } },
      { networkError: true },
      { response: { http: { json: async () => { throw new SyntaxError('Unexpected token'); } } } },
    ]) {
      const ui = await securityUi({ lang, ...options });
      await ui.button.events.click();
      assert.equal(ui.get('status').textContent, dict.security.scriptGenericError);
      assert.notEqual(ui.get('status').textContent, dict.common.error);
    }
  });

  test(`${lang}: authorization polling exposes the sign-in entry on expiration`, async () => {
    const ui = await securityUi({ lang, authorization: true, response: { error: { code: 'BROWSER_AUTH_REQUIRED', message: 'BROWSER_AUTH_REQUIRED' } } });
    await ui.intervals[0]();
    assert.equal(ui.get('status').textContent, dict.browserErrors.BROWSER_AUTH_REQUIRED);
    assert.equal(ui.get('security-login').hidden, false);
  });

  test(`${lang}: dashboard API uses the same localized errors and existing re-login entry`, async () => {
    const html = String(await renderDashboardPage({ session, lang, appVersion: 'test', allowedUserId: 'test' }));
    const startup = 'run(async () => { await refreshAll(); await loadHighlightedNotification(); });';
    const script = scripts(html).find(script => script.includes(startup)).replace(startup, 'globalThis.api = api;');
    for (const code of [...Object.keys(dict.browserErrors), 'UNKNOWN']) {
      const elements = new Map();
      const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
      const context = {
        __I18N__: getDashboardClientI18n(lang),
        window: { addEventListener() {} }, navigator: {}, setInterval() {},
        document: {
          getElementById: get, createElement: element, addEventListener() {},
          querySelector: selector => ({ content: selector.includes('session-expires') ? session.expiresAt : 'test' }),
          querySelectorAll: () => [],
        },
        fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: { code, message: 'private English error' } }) }),
      };
      runInNewContext(script, context);
      await assert.rejects(context.api('/dashboard/api/session'), error => error.message === (dict.browserErrors[code] ?? dict.security.scriptGenericError));
      if (code === 'BROWSER_AUTH_REQUIRED') assert.equal(get('session-login').hidden, false);
    }
  });
}
