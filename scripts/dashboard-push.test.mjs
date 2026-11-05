import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer, atob } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { URLSearchParams } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/dashboard-ui.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { renderDashboardPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const html = String(await renderDashboardPage({ session: { csrf: 'test', expiresAt: Date.now() + 900_000 }, appVersion: 'test', allowedUserId: 'owner' }));
const englishHtml = String(await renderDashboardPage({ session: { csrf: 'test', expiresAt: Date.now() + 900_000 }, appVersion: 'test', allowedUserId: 'owner', lang: 'en-US' }));
const dashboardScript = page => [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('async function loadPushSettings()'));
const script = dashboardScript(html);
// Skip unrelated startup API loads; execute the rendered script and its actual event handlers.
const startup = 'run(async () => { await refreshAll(); await loadHighlightedNotification(); });';
assert.ok(script.includes(startup));
const isolatedScript = script.replace(startup, 'globalThis.loadPushSettings = loadPushSettings;');
const inboxExports = 'Object.assign(globalThis, { loadPendingApprovals, loadNotifications }); globalThis.notificationsState = () => ({ offset: notificationsOffset, total: notificationsTotal });';

function setup({ permission = 'default', active = false, subscribed = false, permissionApi = true, scriptSuffix = '', lang = 'zh-CN' } = {}) {
  const elements = new Map();
  function element() {
    return { dataset: {}, style: {}, value: '', textContent: '', events: {}, children: [], addEventListener(type, handler) { this.events[type] = handler; }, setAttribute(name, value) { this[name] = value; }, append(...children) { this.children.push(...children); this.lastChild = children.at(-1); }, replaceChildren(...children) { this.children = children; } };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = { visibilityState: 'visible', events: {}, getElementById: get, createElement: element, querySelector: selector => ({ content: selector.includes('session-expires') ? Date.now() + 900_000 : 'test' }), querySelectorAll: selector => selector === '[data-action]' ? [...elements.values()] : [], addEventListener(type, handler) { this.events[type] = handler; } };
  const window = { events: {}, addEventListener(type, handler) { this.events[type] = handler; }, prompt: () => 'Chrome', matchMedia: () => ({ matches: false }) };
  const permissionStatus = element();
  const calls = [];
  const timers = new Map();
  const intervals = new Map();
  const state = { active, subscribed, hangSubscribe: false, hangLookup: false, permissionCalls: 0, failSubscribe: false, failLookup: false, subscribeCalls: 0 };
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', expirationTime: null, unsubscribe: async () => { state.subscribed = false; return true; }, toJSON: () => ({ keys: { p256dh: 'test', auth: 'test' } }) };
  const notification = { permission, requestPermission: async () => { state.permissionCalls++; notification.permission = 'granted'; return 'granted'; } };
  Object.assign(window, { Notification: notification, PushManager: function () {} });
  const registration = { active: {}, pushManager: { getSubscription: async () => state.hangLookup ? new Promise(() => {}) : state.subscribed ? subscription : null, subscribe: async () => { state.subscribeCalls++; if (state.hangSubscribe) await new Promise(resolve => { state.finishSubscribe = resolve; }); state.subscribed = true; return subscription; } } };
  const serviceWorker = { events: {}, getRegistration: async () => registration, addEventListener(type, handler) { this.events[type] = handler; } };
  const navigator = { userAgent: 'Chrome', serviceWorker };
  window.navigator = navigator;
  if (permissionApi) navigator.permissions = { query: async () => permissionStatus };
  const context = {
    window, document, navigator, Notification: notification, atob, URLSearchParams,
    setInterval(fn, ms) { intervals.set(ms, fn); },
    setTimeout(fn, ms) { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (path, options) => {
      calls.push({ path, options });
      let data;
      if (path.endsWith('/push/config')) data = { publicKey: 'YQ' };
      else if (path.endsWith('/push/subscribe')) { if (state.failSubscribe) throw new Error('offline'); state.active = true; data = {}; }
      else if (path.endsWith('/push/unsubscribe')) { state.active = false; data = {}; }
      else if (path.endsWith('/push/subscription')) { if (state.failLookup) throw new Error('offline'); data = { subscription: state.active ? { id: 'current', active: true } : null }; }
      else if (path.endsWith('/overview')) data = { schwabConnected: false, tradingEnabled: false, clientCount: 0, toolCallsCount: 0, passkeyCount: 0, legacyGrantCount: 0 };
      else if (path.endsWith('/accounts')) data = { connected: false, accounts: [] };
      else if (path.endsWith('/clients')) data = { clients: [] };
      else if (path.endsWith('/session')) data = { credentials: [] };
      else if (path.includes('/audit?')) data = { items: [], total: 0, successCount: 0, errorCount: 0, active24h: 0 };
      else if (path.includes('/notifications?')) data = { items: [], total: 0, unreadCount: 0 };
      else data = { items: [] };
      return { ok: true, status: 200, json: async () => data };
    },
  };
  const selectedScript = lang === 'en-US' ? dashboardScript(englishHtml).replace(startup, 'globalThis.loadPushSettings = loadPushSettings;') : isolatedScript;
  runInNewContext(selectedScript.replace('globalThis.loadPushSettings = loadPushSettings;', 'globalThis.loadPushSettings = loadPushSettings;' + inboxExports + scriptSuffix), context);
  return { context, get, state, timers, intervals, notification, permissionStatus, window, document, serviceWorker, calls };
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
  assert.equal(ui.get('linked-accounts').textContent, '已连接账户：••••6789、••••0012');
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

const jsonResponse = data => ({ ok: true, status: 200, json: async () => data });
const notificationPage = (summary = 'current page', total = 30, unreadCount = 1) => ({
  items: [{ id: 'notification', summary, type: 'TEST', createdAt: Date.now(), readAt: null }],
  total, unreadCount,
});
const approval = clientId => ({ clientId, kind: 'trade', createdAt: Date.now(), expiresAt: Date.now() + 60_000, actionPath: '/approve/test' });
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('inbox loader failures reject, clear stale counts, and do not announce a successful refresh', async () => {
  for (const failedPath of ['/pending-approvals', '/notifications?']) {
    for (const refreshButton of ['refresh-all-btn', 'inbox-refresh-btn']) {
      const ui = setup();
      const fetch = ui.context.fetch;
      ui.context.fetch = async path => path.endsWith('/pending-approvals')
        ? jsonResponse({ items: [approval('client')] })
        : jsonResponse(notificationPage());
      await ui.context.loadPendingApprovals();
      await ui.context.loadNotifications();
      assert.equal(ui.get('inbox-badge').textContent, '1');
      assert.equal(ui.get('notifications-unread-tag').textContent, '1 未读');
      ui.context.fetch = (path, options) => {
        if (path.includes(failedPath)) throw new Error('offline');
        return fetch(path, options);
      };
      await ui.get(refreshButton).events.click();
      assert.equal(ui.get('global-msg').className, 'message error');
      assert.match(ui.get('global-msg').textContent, /网络请求失败/);
      assert.doesNotMatch(ui.get('global-msg').textContent, /所有数据已刷新|待办与通知已刷新/);
      if (failedPath === '/pending-approvals') {
        assert.equal(ui.get('inbox-badge').hidden, true);
        assert.equal(ui.get('inbox-badge').textContent, '');
        assert.equal(ui.get('pending-count-tag').textContent, '? 待办');
        await assert.rejects(ui.context.loadPendingApprovals(), /网络请求失败/);
      } else {
        assert.equal(ui.get('notifications-unread-tag').textContent, '? 未读');
        assert.equal(ui.get('notifications-pagination-info').textContent, '—');
        assert.equal(ui.get('notifications-next-btn').disabled, true);
        await assert.rejects(ui.context.loadNotifications(), /网络请求失败/);
      }
      assert.equal(ui.get('refresh-all-btn').disabled, false);
    }
  }
});

test('inbox loaders reject malformed lists and counts before committing pagination state', async () => {
  const ui = setup();
  for (const items of [undefined, null, {}, 'items']) {
    ui.context.fetch = async () => jsonResponse({ items });
    await assert.rejects(ui.context.loadPendingApprovals(), /列表数据格式异常/);
    await assert.rejects(ui.context.loadNotifications(15), /列表数据格式异常/);
    assert.equal(ui.context.notificationsState().offset, 0);
  }
  for (const field of ['total', 'unreadCount']) {
    for (const value of [undefined, null, '30', -1, NaN, Infinity]) {
      ui.context.fetch = async () => jsonResponse({ items: [], total: 30, unreadCount: 1, [field]: value });
      await assert.rejects(ui.context.loadNotifications(15), /统计数据格式异常/);
      assert.equal(ui.context.notificationsState().offset, 0);
      assert.equal(ui.get('notifications-prev-btn').disabled, true);
      assert.equal(ui.get('notifications-next-btn').disabled, true);
      assert.doesNotMatch(ui.get('notifications-pagination-info').textContent, /NaN/);
    }
  }
  ui.context.fetch = async () => jsonResponse({ items: [], total: 0, unreadCount: 0 });
  await ui.context.loadNotifications();
  assert.match(ui.get('notifications-pagination-info').textContent, /0–0 \/ 共 0 条/);
});

test('only the latest pending-approval request can update cards and badge, including late failures', async () => {
  for (const lateFailure of [false, true]) {
    const ui = setup();
    const oldResponse = deferred();
    ui.context.fetch = () => oldResponse.promise;
    const older = ui.context.loadPendingApprovals();
    ui.context.fetch = async () => jsonResponse({ items: [approval('new-client')] });
    await ui.context.loadPendingApprovals();
    const currentCards = ui.get('pending-approvals-container').children;
    if (lateFailure) oldResponse.reject(new Error('offline'));
    else oldResponse.resolve(jsonResponse({ items: [] }));
    await older;
    assert.equal(ui.get('pending-approvals-container').children, currentCards);
    assert.equal(ui.get('inbox-badge').hidden, false);
    assert.equal(ui.get('inbox-badge').textContent, '1');
  }
});

test('an older successful inbox response cannot erase a newer load error', async () => {
  for (const loader of ['loadPendingApprovals', 'loadNotifications']) {
    const ui = setup();
    const oldResponse = deferred();
    ui.context.fetch = () => oldResponse.promise;
    const older = ui.context[loader]();
    ui.context.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(ui.context[loader](), /网络请求失败/);
    const container = ui.get(loader === 'loadPendingApprovals' ? 'pending-approvals-container' : 'notifications-table-body');
    const errorContent = container.children;
    oldResponse.resolve(jsonResponse(loader === 'loadPendingApprovals' ? { items: [approval('stale-client')] } : notificationPage('stale page')));
    await older;
    assert.equal(container.children, errorContent);
    assert.equal(ui.get('inbox-badge').textContent, '');
  }
});

const backgroundRefreshes = {
  poll: ui => ui.intervals.get(30000)(),
  visibility: ui => ui.document.events.visibilitychange(),
  push: ui => ui.serviceWorker.events.message({ data: { type: 'PUSH_RECEIVED' } }),
};

test('late background notification responses cannot overwrite a newer page or its controls', async () => {
  for (const trigger of Object.values(backgroundRefreshes)) {
    for (const lateFailure of [false, true]) {
      const ui = setup();
      const fetch = ui.context.fetch;
      ui.context.fetch = async () => jsonResponse(notificationPage('first page'));
      await ui.context.loadNotifications();
      const oldResponse = deferred();
      const offsets = [];
      ui.context.fetch = (path, options) => {
        if (!path.includes('/notifications?')) return fetch(path, options);
        offsets.push(path);
        return path.endsWith('offset=0') ? oldResponse.promise : Promise.resolve(jsonResponse(notificationPage('second page', 30, 2)));
      };
      trigger(ui);
      assert.equal(ui.get('notifications-next-btn').disabled, false, 'background reads must not block page navigation');
      await ui.get('notifications-next-btn').events.click();
      if (lateFailure) oldResponse.reject(new Error('offline'));
      else oldResponse.resolve(jsonResponse(notificationPage('stale first page', 90, 9)));
      await setImmediate();
      assert.equal(offsets.length, 2);
      assert.ok(offsets[1].endsWith('offset=15'));
      assert.equal(ui.get('notifications-table-body').children[0].children[2].textContent, 'second page');
      assert.equal(ui.get('notifications-unread-tag').textContent, '2 未读');
      assert.match(ui.get('notifications-pagination-info').textContent, /16–30 \/ 共 30 条/);
      assert.equal(ui.context.notificationsState().offset, 15);
      assert.equal(ui.context.notificationsState().total, 30);
      assert.equal(ui.get('notifications-prev-btn').disabled, false);
      assert.equal(ui.get('notifications-next-btn').disabled, true);
      assert.equal(ui.get('global-msg').textContent, '');
    }
  }
});

test('background inbox refreshes report failures without unhandled rejections', async () => {
  for (const trigger of Object.values(backgroundRefreshes)) {
    for (const failedPath of ['/pending-approvals', '/notifications?']) {
      const ui = setup();
      const fetch = ui.context.fetch;
      ui.context.fetch = (path, options) => {
        if (path.includes(failedPath)) throw new Error('offline');
        return fetch(path, options);
      };
      trigger(ui);
      await setImmediate();
      assert.equal(ui.get('global-msg').className, 'message error');
      assert.match(ui.get('global-msg').textContent, /网络请求失败/);
    }
  }
});

test('marking a notification read awaits reloading and reports reload failures', async () => {
  const ui = setup();
  ui.context.fetch = async () => jsonResponse(notificationPage());
  await ui.context.loadNotifications();
  const reload = deferred();
  ui.context.fetch = path => path.includes('/notifications?') ? reload.promise : Promise.resolve(jsonResponse({}));
  const markRead = ui.get('notifications-table-body').children[0].children[4].children[0];
  const click = markRead.events.click();
  await setImmediate();
  assert.equal(ui.get('dashboard-main')['aria-busy'], 'true');
  assert.equal(ui.get('refresh-all-btn').disabled, true);
  reload.reject(new Error('offline'));
  await click;
  assert.equal(ui.get('global-msg').className, 'message error');
  assert.match(ui.get('global-msg').textContent, /网络请求失败/);
  assert.equal(ui.get('refresh-all-btn').disabled, false);
});

test('test notifications lock actions during lookup and sending, and announce success in the live region', async () => {
  const ui = setup({ permission: 'granted', active: true, subscribed: true, lang: 'en-US' });
  await ui.context.loadPushSettings();
  const lookup = deferred();
  const sent = deferred();
  const fetch = ui.context.fetch;
  let lookups = 0, sends = 0;
  ui.context.fetch = (path, options) => {
    if (path.endsWith('/push/subscription')) { lookups++; return lookup.promise; }
    if (path.endsWith('/push/test')) { sends++; return sent.promise; }
    return fetch(path, options);
  };
  const click = ui.get('push-test-btn').events.click();
  await ui.get('push-test-btn').events.click();
  await setImmediate();
  assert.equal(lookups, 1);
  assert.equal(ui.get('push-test-btn').disabled, true);
  lookup.resolve(jsonResponse({ subscription: { id: 'current', active: true } }));
  await setImmediate();
  await ui.get('push-test-btn').events.click();
  assert.equal(sends, 1);
  assert.equal(ui.get('dashboard-main')['aria-busy'], 'true');
  sent.resolve(jsonResponse({}));
  await click;
  assert.equal(ui.get('global-msg').textContent, 'Test notification sent!');
  assert.equal(ui.get('global-msg').className, 'message');
  assert.equal(ui.get('global-msg').hidden, false);
  assert.equal(ui.get('push-test-btn').disabled, false);
  assert.match(html, /id="global-msg"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('test notification errors and inactive-device messages are localized and release the busy state', async () => {
  const ui = setup({ permission: 'granted', active: true, subscribed: true, lang: 'en-US' });
  await ui.context.loadPushSettings();
  ui.state.active = false;
  await ui.get('push-test-btn').events.click();
  assert.equal(ui.get('global-msg').textContent, 'No active push device found. Enable push notifications on this device first.');
  assert.equal(ui.get('global-msg').className, 'message error');
  assert.equal(ui.calls.filter(call => call.path.endsWith('/push/test')).length, 0);
  ui.state.active = true;
  const fetch = ui.context.fetch;
  ui.context.fetch = (path, options) => path.endsWith('/push/test')
    ? Promise.resolve({ ok: false, status: 503, json: async () => ({ error: { code: 'PUSH_UNAVAILABLE', message: 'unavailable' } }) })
    : fetch(path, options);
  await ui.get('push-test-btn').events.click();
  assert.match(ui.get('global-msg').textContent, /^Failed to send test notification: unavailable \[PUSH_UNAVAILABLE\]/);
  assert.equal(ui.get('global-msg').className, 'message error');
  assert.equal(ui.get('push-test-btn').disabled, false);
});
