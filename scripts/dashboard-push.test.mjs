import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer, atob } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/dashboard-ui.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { renderDashboardPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const html = String(await renderDashboardPage({ session: { csrf: 'test', expiresAt: Date.now() + 900_000 }, appVersion: 'test', allowedUserId: 'owner' }));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function loadPushSettings()'));
// Skip unrelated startup API loads; execute the rendered script and its actual event handlers.
const startup = 'run(async () => { await refreshAll(); await loadHighlightedNotification(); });';
assert.ok(script.includes(startup));
const isolatedScript = script.replace(startup, 'globalThis.loadPushSettings = loadPushSettings;');

function setup({ permission = 'default', active = false, subscribed = false, permissionApi = true } = {}) {
  const elements = new Map();
  function element() {
    return { dataset: {}, textContent: '', events: {}, children: [], addEventListener(type, handler) { this.events[type] = handler; }, setAttribute() {}, append(...children) { this.children.push(...children); this.lastChild = children.at(-1); }, replaceChildren(...children) { this.children = children; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = { visibilityState: 'visible', events: {}, getElementById: get, createElement: element, querySelector: selector => ({ content: selector.includes('session-expires') ? Date.now() + 900_000 : 'test' }), querySelectorAll: selector => selector === '[data-action]' ? [...elements.values()] : [], addEventListener(type, handler) { this.events[type] = handler; } };
  const window = { events: {}, addEventListener(type, handler) { this.events[type] = handler; }, prompt: () => 'Chrome' };
  const permissionStatus = element();
  const calls = [];
  const state = { active, subscribed, failSubscribe: false, failLookup: false, subscribeCalls: 0 };
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', expirationTime: null, toJSON: () => ({ keys: { p256dh: 'test', auth: 'test' } }) };
  const notification = { permission, requestPermission: async () => { notification.permission = 'granted'; return 'granted'; } };
  Object.assign(window, { Notification: notification, PushManager: function () {} });
  const registration = { active: {}, pushManager: { getSubscription: async () => state.subscribed ? subscription : null, subscribe: async () => { state.subscribeCalls++; state.subscribed = true; return subscription; } } };
  const navigator = { userAgent: 'Chrome', serviceWorker: { getRegistration: async () => registration, addEventListener() {} } };
  if (permissionApi) navigator.permissions = { query: async () => permissionStatus };
  const context = {
    window, document, navigator, Notification: notification, atob,
    setInterval() {},
    fetch: async (path, options) => {
      calls.push({ path, options });
      let data;
      if (path.endsWith('/push/config')) data = { publicKey: 'YQ' };
      else if (path.endsWith('/push/subscribe')) { if (state.failSubscribe) throw new Error('offline'); state.active = true; data = {}; }
      else if (path.endsWith('/push/subscription')) { if (state.failLookup) throw new Error('offline'); data = { subscription: state.active ? { id: 'current', active: true } : null }; }
      else data = { items: [] };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  runInNewContext(isolatedScript, context);
  return { context, get, state, notification, permissionStatus, window, document, calls };
}

test('allowed browser permission is distinct from an active push subscription', async () => {
  const ui = setup({ permission: 'granted' });
  await ui.context.loadPushSettings();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已允许');
  assert.match(ui.get('push-status-badge').textContent, /权限已允许，尚未开启推送/);
  assert.equal(ui.get('push-subscribe-btn').disabled, false);
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
  assert.equal(ui.get('push-subscribe-btn').disabled, true);
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
  await ui.get('push-subscribe-btn').events.click();
  assert.equal(ui.get('push-permission-badge').textContent, '通知权限：已允许');
  assert.match(ui.get('push-status-badge').textContent, /尚未开启推送/);
  assert.match(ui.get('global-msg').textContent, /网络请求失败/);
  assert.equal(ui.get('push-subscribe-btn').disabled, false);
  ui.state.failSubscribe = false;
  await ui.get('push-subscribe-btn').events.click();
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
  assert.equal(ui.get('push-subscribe-btn').disabled, false);
  assert.equal(ui.get('push-test-btn').disabled, true);
});
