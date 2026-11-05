import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer, atob } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/dashboard-ui.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { renderDashboardPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const html = String(await renderDashboardPage({ session: { csrf: 'test', expiresAt: Date.now() + 900_000 }, appVersion: 'test', allowedUserId: 'owner' }));
const enHtml = String(await renderDashboardPage({ session: { csrf: 'test', expiresAt: Date.now() + 900_000 }, appVersion: 'test', allowedUserId: 'owner', lang: 'en-US' }));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function loadPushSettings()'));
const enScript = [...enHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function loadPushSettings()'));
// Skip unrelated startup API loads; execute the rendered script and its actual event handlers.
const startup = 'run(async () => { await refreshAll(); await loadHighlightedNotification(); });';
assert.ok(script.includes(startup));
const isolatedScript = script.replace(startup, 'globalThis.loadPushSettings = loadPushSettings;');

function setup({ permission = 'default', active = false, subscribed = false, permissionApi = true, scriptSuffix = '', lang = 'zh-CN', userAgent = 'Chrome', passkeys = false } = {}) {
  const elements = new Map();
  function element() {
    return { dataset: {}, style: {}, value: '', textContent: '', events: {}, children: [], focus() {}, close() { this.open = false; }, showModal() { this.open = true; }, addEventListener(type, handler) { this.events[type] = handler; }, setAttribute() {}, append(...children) { this.children.push(...children); this.lastChild = children.at(-1); }, replaceChildren(...children) { this.children = children; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = { documentElement: { lang }, visibilityState: 'visible', events: {}, getElementById: get, createElement: element, querySelector: selector => ({ content: selector.includes('session-expires') ? Date.now() + 900_000 : 'test' }), querySelectorAll: selector => selector === '[data-action]' ? [...elements.values()] : [], addEventListener(type, handler) { this.events[type] = handler; } };
  const window = { events: {}, matchMedia: () => ({ matches: false }), addEventListener(type, handler) { this.events[type] = handler; }, prompt: () => 'Chrome' };
  const permissionStatus = element();
  const calls = [];
  const timers = new Map();
  const state = { active, subscribed, hangSubscribe: false, hangLookup: false, permissionCalls: 0, failSubscribe: false, failLookup: false, subscribeCalls: 0 };
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', expirationTime: null, unsubscribe: async () => { state.subscribed = false; return true; }, toJSON: () => ({ keys: { p256dh: 'test', auth: 'test' } }) };
  const notification = { permission, requestPermission: async () => { state.permissionCalls++; notification.permission = 'granted'; return 'granted'; } };
  Object.assign(window, { Notification: notification, PushManager: function () {} });
  const registration = { active: {}, pushManager: { getSubscription: async () => state.hangLookup ? new Promise(() => {}) : state.subscribed ? subscription : null, subscribe: async () => { state.subscribeCalls++; if (state.hangSubscribe) await new Promise(resolve => { state.finishSubscribe = resolve; }); state.subscribed = true; return subscription; } } };
  const navigator = { userAgent, serviceWorker: { getRegistration: async () => registration, addEventListener() {} } };
  window.navigator = navigator;
  if (passkeys) {
    window.PublicKeyCredential = function () {};
    window.isSecureContext = true;
    navigator.credentials = {};
  }
  if (permissionApi) navigator.permissions = { query: async () => permissionStatus };
  const context = {
    window, document, navigator, Notification: notification, atob,
    intervals: [],
    setInterval(fn, ms) { context.intervals.push({ fn, ms }); },
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (path, options) => {
      calls.push({ path, options });
      let data;
      if (path.endsWith('/push/config')) data = { publicKey: 'YQ' };
      else if (path.endsWith('/push/subscribe')) { if (state.failSubscribe) throw new Error('offline'); state.active = true; data = {}; }
      else if (path.endsWith('/push/unsubscribe')) { state.active = false; data = {}; }
      else if (path.endsWith('/push/subscription')) { if (state.failLookup) throw new Error('offline'); data = { subscription: state.active ? { id: 'current', active: true } : null }; }
      else data = { items: [] };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  const localizedScript = lang === 'en-US' ? enScript.replace(startup, 'globalThis.loadPushSettings = loadPushSettings;') : isolatedScript;
  runInNewContext(localizedScript.replace('globalThis.loadPushSettings = loadPushSettings;', 'globalThis.loadPushSettings = loadPushSettings;' + scriptSuffix), context);
  return { context, get, state, timers, notification, permissionStatus, window, document, calls };
}

test('dashboard verification failure preserves the passkey and reports uncertain completion', async () => {
  for (const registration of [false, true]) {
    const ui = setup({ scriptSuffix: `pending = {
      challenge: {registration: ${registration}},
      deadline: Date.now() + 60000,
      verify: async () => { throw new Error('service unavailable'); }
    }; ceremony = async () => ({id: 'valid-passkey'});` });
    let deleted = false;
    ui.context.PublicKeyCredential = { signalUnknownCredential: async () => { deleted = true; } };
    ui.context.location = { hostname: 'localhost' };
    let closed = false;
    ui.get('passkey-dialog').close = () => { closed = true; };
    await ui.get('ceremony-submit').events.click();
    assert.equal(deleted, false, 'failed verification must not delete a valid passkey');
    assert.equal(closed, true);
    assert.match(ui.get('global-msg').textContent, /service unavailable.*请刷新核对服务器状态/);
    assert.equal(ui.get('ceremony-submit').disabled, false);
  }
});

test('allowed browser permission is distinct from an active push subscription', async () => {
  const ui = setup({ permission: 'granted' });
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已允许');
  assert.match(ui.get('push-status-badge').textContent, /权限已允许，尚未开启推送/);
  assert.equal(ui.get('push-toggle-btn').disabled, false);
  assert.equal(ui.get('push-test-btn').disabled, true);
  assert.equal(ui.state.subscribeCalls, 0);
});

test('permission change and returning to the page refresh the displayed state', async () => {
  const ui = setup();
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：未授权');
  ui.notification.permission = 'granted';
  ui.permissionStatus.events.change();
  await setImmediate();
  assert.match(ui.get('push-status-badge').textContent, /权限已允许/);
  ui.notification.permission = 'denied';
  ui.window.events.focus();
  await setImmediate();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已禁止');
  assert.equal(ui.get('push-toggle-btn').disabled, true);
  // Visibility also works when the Permissions API is unavailable.
  const fallback = setup({ permissionApi: false });
  await fallback.context.loadPushSettings();
  fallback.notification.permission = 'granted';
  fallback.document.events.visibilitychange();
  await setImmediate();
  assert.equal(fallback.get('push-permission-badge').textContent, '通知权限：已允许');
});

test('active server registration requires granted permission to show enabled', async () => {
  const ui = setup({ permission: 'granted', active: true, subscribed: true });
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-status-badge').textContent, '本机已开启推送');
  assert.equal(ui.get('push-test-btn').disabled, false);
  ui.notification.permission = 'default';
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-status-badge').textContent, '未开启推送');
  assert.equal(ui.get('push-test-btn').disabled, true);
});

test('failed registration refreshes permission and permits retry with existing browser subscription', async () => {
  const ui = setup();
  await ui.context.loadPushSettings();
  ui.state.failSubscribe = true;
  await ui.get('push-toggle-btn').events.click();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已允许');
  assert.match(ui.get('push-status-badge').textContent, /尚未开启推送/);
  assert.match(ui.get('global-msg').textContent, /网络请求失败/);
  assert.equal(ui.get('push-toggle-btn').disabled, false);
  ui.state.failSubscribe = false;
  await ui.get('push-toggle-btn').events.click();
  assert.equal(ui.get('push-status-badge').textContent, '本机已开启推送');
  assert.equal(ui.state.subscribeCalls, 1);
  assert.equal(ui.get('push-test-btn').disabled, false);
});

test('lookup failure keeps the browser permission visible without claiming push is enabled', async () => {
  const ui = setup({ permission: 'granted', subscribed: true });
  ui.state.failLookup = true;
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已允许');
  assert.match(ui.get('push-status-badge').textContent, /推送暂不可用/);
  assert.equal(ui.get('push-toggle-btn').disabled, false);
  assert.equal(ui.get('push-test-btn').disabled, true);
});

async function expireWait(ui) {
  await setImmediate();
  assert.equal(ui.timers.size, 1);
  const [timer] = ui.timers.values();
  timer.fn();
  await setImmediate();
}

test('pending browser subscription shows progress, times out, and never registers late', async () => {
  const ui = setup({ permission: 'granted' });
  await ui.context.loadPushSettings();
  ui.state.hangSubscribe = true;
  const click = ui.get('push-toggle-btn').events.click();
  await setImmediate();
  assert.match(ui.get('push-action-status').textContent, /连接浏览器推送服务/);
  assert.equal(ui.get('push-toggle-btn').disabled, true);
  assert.equal(ui.state.permissionCalls, 0);
  await expireWait(ui);
  await click;
  assert.match(ui.get('push-action-status').textContent, /连接浏览器推送服务超时/);
  assert.equal(ui.get('push-toggle-btn').disabled, false);
  assert.equal(ui.get('refresh-all-btn').disabled, false);
  assert.equal(ui.state.active, false);
  // Retry shares the existing browser operation rather than subscribing twice.
  const retry = ui.get('push-toggle-btn').events.click();
  await setImmediate();
  assert.equal(ui.state.subscribeCalls, 1);
  await expireWait(ui);
  await retry;
  ui.state.finishSubscribe();
  await setImmediate();
  assert.equal(ui.calls.filter(call => call.path.endsWith('/push/subscribe')).length, 0);
  await ui.get('push-toggle-btn').events.click();
  assert.equal(ui.get('push-status-badge').textContent, '本机已开启推送');
  assert.equal(ui.state.subscribeCalls, 1);
  assert.equal(ui.timers.size, 0);
});

test('a stalled subscription lookup cannot keep dashboard actions locked', async () => {
  const ui = setup({ permission: 'granted' });
  ui.state.hangLookup = true;
  const click = ui.get('push-toggle-btn').events.click();
  await expireWait(ui);
  // The final state refresh must also have a bounded lookup.
  await expireWait(ui);
  await click;
  assert.match(ui.get('push-action-status').textContent, /读取本机推送订阅超时/);
  assert.equal(ui.get('refresh-all-btn').disabled, false);
  assert.equal(ui.get('push-toggle-btn').disabled, false);
});

test('push errors stay in settings and do not display a Passkey error', async () => {
  const ui = setup();
  ui.notification.requestPermission = async () => { const error = new Error('permission dismissed'); error.name = 'NotAllowedError'; throw error; };
  await ui.get('push-toggle-btn').events.click();
  assert.match(ui.get('push-action-status').textContent, /permission dismissed/);
  assert.doesNotMatch(ui.get('global-msg').textContent, /Passkey/);
});

test('device name is registered without a blocking browser prompt', async () => {
  const ui = setup({ permission: 'granted' });
  ui.get('push-device-label').value = '  办公设备  ';
  ui.window.prompt = () => { throw new Error('unexpected prompt'); };
  await ui.get('push-toggle-btn').events.click();
  const registration = ui.calls.find(call => call.path.endsWith('/push/subscribe'));
  assert.equal(JSON.parse(registration.options.body).label, '办公设备');
  assert.equal(ui.get('push-status-badge').textContent, '本机已开启推送');
});

test('a late config response after timeout cannot start browser subscription', async () => {
  const ui = setup({ permission: 'granted' });
  const fetch = ui.context.fetch;
  let finishConfig;
  ui.context.fetch = (path, options) => path.endsWith('/push/config') ? new Promise(resolve => { finishConfig = () => resolve({ ok: true, status: 200, json: async () => ({ publicKey: 'YQ' }) }); }) : fetch(path, options);
  const click = ui.get('push-toggle-btn').events.click();
  await expireWait(ui);
  await click;
  assert.match(ui.get('push-action-status').textContent, /推送设备服务请求超时/);
  assert.equal(ui.get('refresh-all-btn').disabled, false);
  finishConfig();
  await setImmediate();
  assert.equal(ui.state.subscribeCalls, 0);
  assert.equal(ui.state.active, false);
});


test('one push button switches from enable to disable and back after each operation', async () => {
  assert.equal((html.match(/id="push-toggle-btn"/g) || []).length, 1);
  assert.ok(!html.includes('id="push-unsubscribe-btn"'));
  const ui = setup({ permission: 'granted' });
  await ui.context.loadPushSettings();
  const toggle = ui.get('push-toggle-btn');
  assert.equal(toggle.textContent, '开启本机通知推送');
  await toggle.events.click();
  assert.equal(toggle.textContent, '停用本机推送');
  assert.equal(toggle.className, 'button danger');
  assert.equal(toggle.disabled, false);
  await toggle.events.click();
  assert.equal(ui.state.active, false);
  assert.equal(ui.state.subscribed, false);
  assert.equal(toggle.textContent, '开启本机通知推送');
  assert.equal(toggle.className, 'button primary');
  assert.equal(toggle.disabled, false);
  assert.equal(ui.get('push-test-btn').disabled, true);
  assert.equal(ui.calls.filter(call => call.path.endsWith('/push/subscribe')).length, 1);
  assert.equal(ui.calls.filter(call => call.path.endsWith('/push/unsubscribe')).length, 1);
});


test('failed disabling keeps the same button available to retry disabling', async () => {
  const ui = setup({ permission: 'granted', active: true, subscribed: true });
  await ui.context.loadPushSettings();
  const fetch = ui.context.fetch;
  ui.context.fetch = (path, options) => {
    if (path.endsWith('/push/unsubscribe')) throw new Error('offline');
    return fetch(path, options);
  };
  await ui.get('push-toggle-btn').events.click();
  assert.match(ui.get('push-action-status').textContent, /停用通知失败/);
  assert.equal(ui.get('push-toggle-btn').textContent, '停用本机推送');
  assert.equal(ui.get('push-toggle-btn').disabled, false);
  assert.equal(ui.state.active, true);
  assert.equal(ui.state.subscribed, true);
});


test('dashboard displays all masked account labels and clears stale labels on failures', async () => {
  const ui = setup({ scriptSuffix: 'globalThis.loadLinkedAccounts = loadLinkedAccounts;' });
  ui.context.fetch = async () => ({ ok: true, json: async () => ({ connected: true, accounts: ['••••6789', '••••0012'] }) });
  await ui.context.loadLinkedAccounts();
  assert.equal(ui.get('linked-accounts').textContent, '已连接账户：••••6789, ••••0012');
  ui.context.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(ui.context.loadLinkedAccounts(), /网络请求失败/);
  assert.equal(ui.get('linked-accounts').textContent, '已连接账户：账户读取失败');
  ui.context.fetch = async () => ({ ok: true, json: async () => ({ connected: false, accounts: [] }) });
  await ui.context.loadLinkedAccounts();
  assert.equal(ui.get('linked-accounts').textContent, '已连接账户：无已连接账户');
  ui.context.fetch = async () => ({ ok: true, json: async () => ({ connected: true, accounts: ['123456789'] }) });
  await assert.rejects(ui.context.loadLinkedAccounts(), /账户读取失败/);
  assert.equal(ui.get('linked-accounts').textContent, '已连接账户：账户读取失败');
});

for (const lang of ['zh-CN', 'en-US']) {
  test(`countdown remains localized after the first timer tick (${lang})`, () => {
    const ui = setup({ lang });
    const expected = lang === 'en-US' ? 'Session remaining: 15 minutes' : '会话剩余 15 分钟';
    assert.equal(ui.get('session-state').textContent, expected);
    ui.context.intervals.find(timer => timer.ms === 1000).fn();
    assert.equal(ui.get('session-state').textContent, expected);
  });

  test(`refresh failures and PWA guidance use the selected dictionary (${lang})`, async () => {
    const ui = setup({ lang });
    ui.context.fetch = async () => { throw new Error('offline'); };
    await ui.get('refresh-all-btn').events.click();
    const text = ['last-refresh', 'global-msg', 'overview-counts', 'clients-count', 'audit-pagination-info', 'passkeys-state', 'pwa-install-status'].map(id => ui.get(id).textContent).join('\n');
    if (lang === 'en-US') {
      assert.match(text, /Last refreshed \(some failures\)/);
      assert.match(text, /Refresh incomplete/);
      assert.match(text, /Unable to load overview/);
      assert.match(text, /Credential status unknown/);
      assert.match(text, /Install as a standalone desktop app/);
      assert.doesNotMatch(text, /\p{Script=Han}/u);
    } else {
      assert.match(text, /最近刷新（部分失败）/);
      assert.match(text, /刷新未完整完成/);
    }
  });

  test(`both stages of adding a Passkey and cancellation stay localized (${lang})`, async () => {
    const ui = setup({ lang, passkeys: true, scriptSuffix: 'credentials = [{}]; ceremony = async () => ({});' });
    ui.context.fetch = async path => ({
      ok: true,
      json: async () => path.endsWith('/verify') ? { registrationTicket: 'ticket' } : { registration: path.endsWith('/add-options'), challengeId: 'challenge', options: {} },
    });
    ui.get('credential-name').value = 'Test Key';
    ui.get('add-passkey-form').events.submit({ preventDefault() {} });
    await setImmediate();
    assert.equal(ui.get('ceremony-title').textContent, lang === 'en-US' ? 'Add Passkey · 1 / 2' : '添加 Passkey · 1 / 2');
    await ui.get('ceremony-submit').events.click();
    assert.equal(ui.get('ceremony-title').textContent, lang === 'en-US' ? 'Add Passkey · 2 / 2' : '添加 Passkey · 2 / 2');
    assert.match(ui.get('ceremony-description').textContent, /Test Key/);
    if (lang === 'en-US') {
      for (const id of ['ceremony-description', 'ceremony-submit', 'ceremony-state']) {
        assert.doesNotMatch(ui.get(id).textContent, /\p{Script=Han}/u);
      }
    }
    ui.get('ceremony-cancel').events.click();
    assert.equal(ui.get('global-msg').textContent, lang === 'en-US' ? 'Passkey flow cancelled. No changes submitted.' : '已取消 Passkey 流程，未提交变更。');
  });

  test(`push defaults do not misidentify Firefox or Android and errors stay localized (${lang})`, async () => {
    for (const userAgent of ['Mozilla Android Firefox', 'Mozilla Linux Firefox', 'iPhone Safari']) {
      const ui = setup({ lang, permission: 'granted', userAgent });
      await ui.get('push-toggle-btn').events.click();
      const registration = ui.calls.find(call => call.path.endsWith('/push/subscribe'));
      assert.equal(JSON.parse(registration.options.body).label, lang === 'en-US' ? 'This browser' : '当前浏览器');
      ui.state.hangLookup = true;
      const lookup = ui.context.loadPushSettings();
      await expireWait(ui);
      await lookup;
      if (lang === 'en-US') {
        assert.match(ui.get('push-status-badge').textContent, /Reading this device’s push subscription timed out/);
        assert.doesNotMatch(ui.get('push-status-badge').textContent, /\p{Script=Han}/u);
      } else {
        assert.match(ui.get('push-status-badge').textContent, /读取本机推送订阅超时/);
      }
    }
  });
}
