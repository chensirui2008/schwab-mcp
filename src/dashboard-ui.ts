import { html, raw } from "hono/html";
import type { BrowserSession } from "./security-store";
import { BRAND_LOGO_SVG } from "./auth-ui";

export interface DashboardPageProps {
  session: BrowserSession;
  appVersion: string;
  allowedUserId: string;
}

const DASHBOARD_STYLES = `
:root{color-scheme:dark;--bg:#0b0f19;--card:#111827;--line:#293449;--text:#e8eef8;--muted:#a2b0c7;--blue:#64b5ff;--green:#6ee7b7;--red:#fda4af;--amber:#fcd38b;--radius:12px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button,a{ -webkit-tap-highlight-color:transparent}button{cursor:pointer}a{color:var(--blue);text-underline-offset:3px}button:disabled,input:disabled,select:disabled{opacity:.48;cursor:not-allowed}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:3px solid var(--blue);outline-offset:3px}[hidden]{display:none!important}h1,h2,h3,p{margin:0}h1{font-size:21px;letter-spacing:-.5px}h2{font-size:18px;letter-spacing:-.3px}h3{font-size:14px}small,.muted{color:var(--muted)}.mono,code{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.shell{max-width:1440px;padding:28px 28px 16px;margin:auto}.topline,.brand,.actions,.section-head,.pagination{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.topline{justify-content:space-between;padding-bottom:22px}.brand{gap:13px}.brand svg{flex-shrink:0}.eyebrow{text-transform:uppercase;letter-spacing:1.7px;color:var(--blue);font-size:10px;font-weight:700}.brand p{font-size:12px;color:var(--muted)}.owner{text-align:right;font-size:12px}.status-deck{background:var(--card);border:1px solid var(--line);border-top:2px solid #318de6;border-radius:var(--radius);padding:18px 20px;display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:20px}.status-cell+.status-cell{border-left:1px solid var(--line);padding-left:20px}.label{color:var(--muted);font-size:11px;letter-spacing:.8px;text-transform:uppercase;display:block;margin-bottom:7px}.status-cell p{font-size:12px;margin-top:7px;color:var(--muted)}.badge{display:inline-flex;align-items:center;gap:7px;padding:3px 9px;border:1px solid var(--line);border-radius:5px;font-size:12px;font-weight:600}.badge::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}.badge.good{color:var(--green);background:#12302c}.badge.warn{color:var(--amber);background:#32291d}.badge.bad{color:var(--red);background:#341e2a}.badge.neutral{color:var(--muted)}.button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #394963;border-radius:6px;background:#182338;color:var(--text);padding:7px 12px;font-size:12px;font-weight:600;text-decoration:none;white-space:normal}.button:hover:not(:disabled){background:#22324d;border-color:#6685af}.button.primary{background:#1e5fae;border-color:#3987dd;color:#fff}.button.danger{color:var(--red);border-color:#754152;background:#2b1d2b}.button.compact{padding:5px 9px}.message{margin:16px 0 0;padding:12px 15px;border:1px solid #395d8b;border-radius:7px;background:#111e32;white-space:pre-wrap;overflow-wrap:anywhere}.message.error{border-color:#854356;color:#ffd1d8;background:#281c28}.session-link{margin-top:8px}.tabs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px;border-bottom:1px solid var(--line);margin:24px 0 20px}.tab{padding:13px 10px;background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);font-weight:600;text-align:left}.tab span{font-family:"SFMono-Regular",Consolas,monospace;font-size:10px;color:#7186a5;margin-right:9px}.tab[aria-selected=true]{color:var(--text);border-bottom-color:var(--blue);background:linear-gradient(0deg,#14263d,transparent)}.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--card);overflow:hidden}.section-head{justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--line)}.section-head p{font-size:12px;color:var(--muted);margin-top:3px;max-width:780px}.panel-body{padding:20px 22px}.table-scroll{overflow:auto;max-width:100%}table{border-collapse:collapse;width:100%;text-align:left;font-size:12px}caption{text-align:left;padding:0 22px 10px;color:var(--muted)}th{font-size:10px;text-transform:uppercase;letter-spacing:.65px;color:var(--muted);background:#0e1624;font-weight:600}th,td{padding:14px 18px;vertical-align:top;border-bottom:1px solid #253044}tbody tr:last-child td{border-bottom:0}td{overflow-wrap:anywhere}#clients-table{min-width:1030px}#audit-table{min-width:1100px}.client-name{font-size:13px;font-weight:600;margin-bottom:3px}.client-meta{max-width:300px}.redirects{margin-top:8px}.redirects summary{cursor:pointer;color:var(--blue)}.redirects ul{padding-left:16px;margin:6px 0}.field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--muted)}input,select{min-height:36px;max-width:100%;background:#0b1321;border:1px solid #3a4a62;border-radius:6px;color:var(--text);padding:6px 9px}input::placeholder{color:#8494ad}.permission{min-width:145px}.toggle{display:flex;align-items:center;gap:8px;color:var(--text);font-size:12px}.toggle input{accent-color:#369bff;width:17px;height:17px;min-height:0;margin:2px}.policy-note{display:block;margin-top:5px;max-width:185px;font-size:11px;color:var(--muted)}.timestamp{white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}.empty{text-align:center;color:var(--muted);padding:34px 20px}.load-error{color:var(--red)}.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));border-bottom:1px solid var(--line);background:#0f1725}.stat{padding:17px 22px;border-right:1px solid var(--line)}.stat:last-child{border:0}.stat-value{font-size:24px;font-variant-numeric:tabular-nums;font-weight:600;letter-spacing:-.6px}.filters{display:flex;flex-wrap:wrap;align-items:end;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line)}.filters .field{flex:1;min-width:145px}.filters .actions{gap:8px}.pagination{justify-content:space-between;padding:14px 22px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.summary{max-width:330px;white-space:pre-wrap}.request-id{min-width:190px;word-break:break-all}.credentials{list-style:none;margin:0;padding:0}.credential{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:18px 0;border-bottom:1px solid var(--line)}.credential:first-child{padding-top:0}.credential:last-child{border-bottom:0}.credential-id{display:block;color:var(--muted);max-width:640px;margin-top:4px}.add-passkey{border-top:1px solid var(--line);padding-top:20px;margin-top:14px;display:flex;gap:12px;align-items:end;flex-wrap:wrap}.add-passkey .field{flex:1;max-width:380px}.recovery{border-top:1px solid var(--line);margin-top:22px;padding-top:18px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:#8b9bb3;font-size:11px;margin-top:18px}dialog{color:var(--text);background:#111b2b;border:1px solid #496181;border-radius:12px;max-width:480px;width:calc(100% - 32px);padding:26px;box-shadow:0 20px 100px #0008}dialog::backdrop{background:#020610c9}dialog h2{margin-bottom:10px}dialog p{font-size:13px;color:var(--muted);margin-bottom:15px}dialog .actions{justify-content:flex-end;margin-top:20px}.skip{position:absolute;left:16px;top:-60px;z-index:3;background:var(--card);padding:10px}.skip:focus{top:10px}.support-warning{color:var(--amber);border-left:2px solid var(--amber);padding-left:12px;margin-bottom:20px;font-size:13px}
.overview-stats{grid-template-columns:repeat(3,minmax(0,1fr))}
@media(min-width:1100px){.tabs{grid-template-columns:220px 220px 220px}.shell{padding-top:32px}}
@media(max-width:760px){.shell{padding:16px 12px}.owner{text-align:left}.status-deck{grid-template-columns:1fr;gap:14px;padding:16px}.status-cell+.status-cell{border-left:0;border-top:1px solid var(--line);padding:12px 0 0}.tab{font-size:12px;padding:12px 5px;text-align:center}.tab span{display:block;margin:0}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat{padding:12px 16px;border-bottom:1px solid var(--line)}.stat:last-child{grid-column:1/-1}.section-head,.panel-body{padding:16px}.filters{padding:16px}.credential{align-items:flex-start;flex-direction:column;gap:12px}.credential-id{max-width:100%}.pagination{padding:12px 16px}.filters .actions{width:100%}h1{font-size:19px}.button{min-height:36px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

// All server-provided strings are inserted as text, never interpolated into HTML or script.
const DASHBOARD_SCRIPT = String.raw`
'use strict';
(() => {
const $ = id => document.getElementById(id);
const csrf = document.querySelector('meta[name="csrf"]').content;
const sessionExpiresAt = Number(document.querySelector('meta[name="session-expires"]').content);
const supportsPasskeys = !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
let busy = false;
let expired = false;
let credentials = null;
let overview = null;
let auditOffset = 0;
let auditTotal = 0;
const auditLimit = 25;
let auditFilters = {clientId:'',toolName:'',status:''};
let pending = null;
let returnFocus = null;
const dialog = $('passkey-dialog');
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined && text !== null) el.textContent = String(text);
  if (className) el.className = className;
  return el;
}
function badge(text, tone) { return node('span', text, 'badge ' + tone); }
function message(text, error = false) {
  if (expired && !error) return;
  $('global-msg').textContent = text;
  $('global-msg').className = 'message' + (error ? ' error' : '');
  $('global-msg').hidden = false;
}
function disabled(el, value) { el.dataset.disabled = String(value); }
function syncControls() {
  document.querySelectorAll('[data-action]').forEach(el => {
    el.disabled = busy || expired || el.dataset.disabled === 'true';
  });
  $('dashboard-main').setAttribute('aria-busy', String(busy));
}
function markExpired() {
  if (expired) return;
  expired = true;
  $('session-state').textContent = '会话已过期';
  $('session-state').className = 'badge bad';
  $('session-login').hidden = false;
  message('浏览器安全会话已失效。请重新通过 GitHub owner 登录；未完成的 Passkey 操作不会自动继续。', true);
  if (dialog.open && !busy) { pending = null; dialog.close(); }
  syncControls();
}
async function api(path, method = 'GET', body) {
  if (expired || Date.now() >= sessionExpiresAt) { markExpired(); throw new Error('会话已过期，请重新登录。'); }
  let res;
  try {
    res = await fetch(path, {method, credentials:'same-origin', cache:'no-store', redirect:'error', headers:{'Accept':'application/json', ...(method === 'POST' ? {'Content-Type':'application/json','X-CSRF-Token':csrf} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  } catch { throw new Error('网络请求失败或登录状态已变更。请检查连接并刷新；若已提交操作，请核对服务器状态，勿盲目重复。'); }
  let data;
  try { data = await res.json(); } catch { throw new Error('服务器未返回有效 JSON（HTTP ' + res.status + '）。请重新登录或稍后刷新。'); }
  if (res.status === 401 || data.error?.code === 'BROWSER_AUTH_REQUIRED') markExpired();
  if (!res.ok) throw new Error((data.error?.message || data.error_description || '请求失败') + (data.error?.code ? ' [' + data.error.code + ']' : '') + ' (HTTP ' + res.status + ')');
  return data;
}
async function run(action) {
  if (busy || expired) return;
  busy = true;
  syncControls();
  try { await action(); }
  catch (error) {
    if (!expired) message(error.name === 'NotAllowedError' || error.name === 'AbortError' ? 'Passkey 操作已取消或超时，未提交变更。请重新开始；不会降级为普通验证。' : (error.message || '操作失败，请刷新后重试。'), true);
  } finally {
    busy = false;
    syncControls();
    if (expired && dialog.open) { pending = null; dialog.close(); }
    else if (pending && dialog.open) $('ceremony-submit').focus();
  }
}
function requireArray(value) { if (!Array.isArray(value)) throw new Error('服务器列表数据格式异常。'); return value; }
function requireCount(value) { if (!Number.isFinite(value) || value < 0) throw new Error('服务器统计数据格式异常。'); return value; }
function date(value) {
  if (value === null || value === undefined || value === 0) return '暂无记录';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '时间格式异常' : d.toLocaleString();
}
function tableMessage(body, columns, text, error = false) {
  const row = node('tr'); const cell = node('td',text,'empty' + (error ? ' load-error' : ''));
  cell.colSpan = columns; row.append(cell); body.replaceChildren(row);
}
function button(text, action, unavailable = false, tone = '') {
  const el = node('button',text,'button compact ' + tone); el.type = 'button'; el.dataset.action = '';
  disabled(el,unavailable); el.addEventListener('click', () => run(action)); return el;
}
function updateOverviewStatus() {
  if (!overview) return;
  const refresh = overview.schwabStatus?.refreshExpiresAt;
  const soon = overview.schwabConnected && refresh && refresh - Date.now() <= 24 * 60 * 60 * 1000;
  const connected = overview.schwabConnected && (!refresh || refresh > Date.now());
  const status = $('schwab-status-badge');
  status.className = 'badge ' + (!connected ? 'bad' : soon ? 'warn' : 'good');
  status.textContent = !connected ? 'Schwab 需重新授权' : soon ? 'Schwab 授权即将到期' : 'Schwab 已连接';
}
async function loadOverview() {
  try {
    const data = await api('/dashboard/api/overview');
    if (typeof data.schwabConnected !== 'boolean' || typeof data.tradingEnabled !== 'boolean') throw new Error('服务器连接状态格式异常。');
    requireCount(data.clientCount); requireCount(data.toolCallsCount); requireCount(data.passkeyCount);
    overview = data;
    updateOverviewStatus();
    $('trading-status-badge').className = 'badge ' + (data.tradingEnabled ? 'good' : 'neutral');
    $('trading-status-badge').textContent = data.tradingEnabled ? '交易总开关已开启' : '交易总开关已关闭';
    $('access-expiry').textContent = 'Access 到期：' + date(data.schwabStatus?.accessExpiresAt);
    $('refresh-expiry').textContent = 'Refresh 到期：' + date(data.schwabStatus?.refreshExpiresAt);
    $('overview-counts').textContent = data.clientCount + ' 个客户端 / ' + data.toolCallsCount + ' 次调用 / ' + data.passkeyCount + ' 个 Passkey';
    $('stat-clients-count').textContent = data.clientCount;
    $('stat-total-calls').textContent = data.toolCallsCount;
    $('stat-passkeys-count').textContent = data.passkeyCount;
  } catch (error) {
    overview = null;
    $('schwab-status-badge').textContent = '连接状态读取失败'; $('schwab-status-badge').className = 'badge bad';
    $('trading-status-badge').textContent = '交易开关状态未知'; $('trading-status-badge').className = 'badge warn';
    $('overview-counts').textContent = '概览读取失败'; $('access-expiry').textContent = 'Access 到期：未知'; $('refresh-expiry').textContent = 'Refresh 到期：未知';
    ['stat-clients-count','stat-total-calls','stat-passkeys-count'].forEach(id => $(id).textContent = '—');
    throw error;
  }
}
async function loadClients() {
  const body = $('clients-table-body');
  try {
    const data = await api('/dashboard/api/clients');
    const clients = requireArray(data.clients);
    body.replaceChildren();
    $('clients-count').textContent = clients.length + ' 个客户端';
    if (!clients.length) tableMessage(body,6,'暂无已授权客户端。请在 MCP 客户端中发起 OAuth 授权。');
    for (const client of clients) {
      const row = node('tr');
      const identity = node('td',null,'client-meta');
      identity.append(node('div',client.clientName || '未命名客户端','client-name'),node('code',client.clientId));
      const redirects = node('details',null,'redirects'); redirects.append(node('summary','重定向 URI (' + requireArray(client.redirectUris).length + ')'));
      const uris = node('ul'); client.redirectUris.forEach(uri => uris.append(node('li',uri,'mono'))); redirects.append(uris); identity.append(redirects);
      const state = node('td'); state.append(badge(client.revoked ? '已撤销' : '已授权',client.revoked ? 'bad' : 'good'));
      const permissionCell = node('td'); const permission = node('select',null,'permission');
      permission.dataset.action = ''; permission.setAttribute('aria-label',(client.clientName || client.clientId) + ' 权限等级');
      [['read_only','只读'],['full_access','完整交易']].forEach(([value,label]) => { const option = node('option',label); option.value = value; permission.append(option); });
      permission.value = client.permissionLevel; disabled(permission,!!client.revoked);
      permission.addEventListener('change', () => {
        const desired = permission.value; permission.value = client.permissionLevel;
        run(async () => {
          await api('/dashboard/api/clients/permission','POST',{clientId:client.clientId,permissionLevel:desired});
          await refreshAll(); message('客户端权限已更新。后续 MCP 请求使用新权限。');
        });
      });
      permissionCell.append(permission,node('span','权限不会改变部署级交易总开关。','policy-note'));
      const advancedCell = node('td'); const toggleLabel = node('label',null,'toggle'); const toggle = node('input');
      toggle.type = 'checkbox'; toggle.checked = !!client.advancedSecurity; toggle.dataset.action = ''; toggle.setAttribute('aria-label',(client.clientName || client.clientId) + ' Advanced Security');
      disabled(toggle,!!client.revoked || !supportsPasskeys || (client.permissionLevel !== 'full_access' && !client.advancedSecurity));
      toggleLabel.append(toggle,node('span',client.advancedSecurity ? 'Passkey 增强' : '普通模式'));
      toggle.addEventListener('change', () => {
        const desired = toggle.checked; toggle.checked = !!client.advancedSecurity;
        run(async () => {
          const values = {clientId:client.clientId,advancedSecurity:desired};
          const challenge = await api('/dashboard/api/clients/advanced-security','POST',values);
          stageChallenge(challenge,(desired ? '开启' : '关闭') + ' Advanced Security',
            (client.clientName || client.clientId) + '：' + (desired ? '开启后，每笔受保护交易须由 Passkey 批准。' : '关闭后此客户端将使用普通交易确认。') + (challenge.registration ? ' 此操作将同时登记首个 Passkey。' : ''),
            response => api('/dashboard/api/clients/advanced-security','POST',{...values,challengeId:challenge.challengeId,response}), 'Advanced Security 策略已验证并更新。');
        });
      });
      advancedCell.append(toggleLabel,node('span','策略版本 v' + client.version,'policy-note'));
      if (client.permissionLevel !== 'full_access' && !client.advancedSecurity) advancedCell.append(node('span','仅完整访问可开启。','policy-note'));
      const times = node('td'); times.append(node('div','授权：' + date(client.createdAt),'timestamp'),node('div','最后调用：' + date(client.lastInvocationAt),'timestamp muted'));
      const actions = node('td'); actions.append(button('撤销授权',async () => {
        if (!window.confirm('撤销 ' + (client.clientName || client.clientId) + ' 的全部授权及 Token？此客户端需要重新授权才能连接。')) return;
        await api('/dashboard/api/clients/revoke','POST',{clientId:client.clientId}); await refreshAll(); message('客户端已撤销，全部旧 Token 已失效。');
      },!!client.revoked,'danger'));
      row.append(identity,state,permissionCell,advancedCell,times,actions); body.append(row);
    }
  } catch (error) { tableMessage(body,6,'客户端读取失败：' + error.message,true); $('clients-count').textContent = '读取失败'; throw error; }
}
async function loadAudit() {
  const body = $('audit-table-body');
  try {
    let data;
    for (;;) {
      const query = new URLSearchParams({limit:String(auditLimit),offset:String(auditOffset)});
      Object.entries(auditFilters).forEach(([key,value]) => { if (value) query.set(key,value); });
      data = await api('/dashboard/api/audit?' + query);
      requireArray(data.items); requireCount(data.total); requireCount(data.successCount); requireCount(data.errorCount); requireCount(data.active24h);
      if (auditOffset > 0 && auditOffset >= data.total) { auditOffset = data.total ? Math.floor((data.total - 1) / auditLimit) * auditLimit : 0; continue; }
      break;
    }
    auditTotal = data.total;
    $('audit-total-count').textContent = data.total;
    $('audit-success-rate').textContent = data.total ? (data.successCount / data.total * 100).toFixed(1) + '%' : '—';
    $('audit-success-count').textContent = data.successCount;
    $('audit-error-count').textContent = data.errorCount;
    $('audit-active24h').textContent = data.active24h;
    body.replaceChildren();
    if (!data.items.length) tableMessage(body,7,'没有符合当前筛选条件的调用记录。');
    for (const item of data.items) {
      const row = node('tr'); const state = node('td'); state.append(badge(item.status,item.status === 'SUCCESS' ? 'good' : 'bad'));
      const summary = node('td',null,'summary'); summary.append(node('div',item.parametersSummary || '无参数摘要','mono'));
      if (item.errorCode || item.errorMessage) summary.append(node('div',[item.errorCode,item.errorMessage].filter(Boolean).join(' · '),'load-error'));
      row.append(node('td',date(item.createdAt),'timestamp'),node('td',item.clientId,'mono'),node('td',item.toolName,'mono'),state,node('td',item.durationMs + ' ms','timestamp'),summary,node('td',item.requestId,'mono request-id'));
      body.append(row);
    }
    $('audit-pagination-info').textContent = (data.items.length ? auditOffset + 1 : 0) + '–' + (data.items.length ? auditOffset + data.items.length : 0) + ' / ' + data.total + ' 条';
    disabled($('audit-prev-btn'),auditOffset === 0); disabled($('audit-next-btn'),auditOffset + data.items.length >= auditTotal || data.items.length === 0);
  } catch (error) {
    tableMessage(body,7,'审计日志读取失败：' + error.message,true);
    ['audit-total-count','audit-success-rate','audit-success-count','audit-error-count','audit-active24h'].forEach(id => $(id).textContent = '—');
    $('audit-pagination-info').textContent = '分页状态未知'; disabled($('audit-prev-btn'),true); disabled($('audit-next-btn'),true);
    throw error;
  }
}
async function securityOptions(operation, target = '', name = 'Passkey') {
  return api('/security/api/options','POST',{operation,name,...(target ? {target} : {})});
}
async function loadPasskeys() {
  const list = $('passkeys-list');
  try {
    const data = await api('/dashboard/api/session');
    credentials = requireArray(data.credentials);
    list.replaceChildren();
    if (!credentials.length) list.append(node('li','尚未登记 Passkey。可在下方注册首个凭据，或在客户端开启 Advanced Security 时注册。','empty'));
    for (const credential of credentials) {
      const item = node('li',null,'credential'); const identity = node('div'); identity.append(node('h3',credential.name),node('code',credential.id,'credential-id'));
      const actions = node('div',null,'actions');
      actions.append(button('重命名',async () => {
        const name = window.prompt('新的 Passkey 名称（1–80 字符）',credential.name);
        if (name === null) return;
        const trimmed = name.trim(); if (!trimmed || trimmed.length > 80) throw new Error('Passkey 名称须为 1–80 字符。');
        const challenge = await securityOptions('rename',credential.id,trimmed);
        stageChallenge(challenge,'重命名 Passkey','将 “' + credential.name + '” 改为 “' + trimmed + '”。须验证已有 Passkey。',response => api('/security/api/verify','POST',{challengeId:challenge.challengeId,response}),'Passkey 已重命名。');
      },!supportsPasskeys));
      actions.append(button('删除',async () => {
        if (!window.confirm('删除 Passkey “' + credential.name + '”？此操作须先验证已有 Passkey。')) return;
        const challenge = await securityOptions('delete',credential.id);
        stageChallenge(challenge,'删除 Passkey','验证已有 Passkey 后删除 “' + credential.name + '”。其他凭据不受影响。',response => api('/security/api/verify','POST',{challengeId:challenge.challengeId,response}),'Passkey 已删除。');
      },!supportsPasskeys || credentials.length <= 1,'danger'));
      if (credentials.length <= 1) actions.append(node('small','最后一个凭据不可删除'));
      item.append(identity,actions); list.append(item);
    }
    $('passkeys-state').textContent = credentials.length ? credentials.length + ' 个 owner 共享凭据' : '尚未启用 Passkey 防护';
    $('add-passkey-btn').textContent = credentials.length ? '添加 Passkey · 先验证已有凭据' : '注册首个 Passkey';
    disabled($('add-passkey-btn'),!supportsPasskeys);
  } catch (error) {
    credentials = null; list.replaceChildren(node('li','Passkey 读取失败：' + error.message,'empty load-error')); $('passkeys-state').textContent = '凭据状态未知'; disabled($('add-passkey-btn'),true); throw error;
  }
}
async function refreshAll() {
  const results = await Promise.allSettled([loadOverview(),loadClients(),loadAudit(),loadPasskeys()]);
  const failures = results.filter(result => result.status === 'rejected');
  $('last-refresh').textContent = (failures.length ? '最近刷新（部分失败）：' : '最近刷新：') + new Date().toLocaleTimeString();
  syncControls();
  if (failures.length) throw new Error('刷新未完整完成：' + failures.map(result => result.reason.message).join('；'));
}
const enc = value => {
  let binary = ''; for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
};
const dec = value => {
  const normalized = value.replaceAll('-','+').replaceAll('_','/');
  return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)),char => char.charCodeAt(0));
};
async function ceremony(challenge) {
  const options = {...challenge.options,challenge:dec(challenge.options.challenge)};
  if (challenge.registration) {
    options.user = {...options.user,id:dec(options.user.id)};
    options.excludeCredentials = (options.excludeCredentials || []).map(value => ({...value,id:dec(value.id)}));
  } else options.allowCredentials = (options.allowCredentials || []).map(value => ({...value,id:dec(value.id)}));
  // This call runs synchronously from the dedicated dialog button, before any network await.
  const credential = await navigator.credentials[challenge.registration ? 'create' : 'get']({publicKey:options});
  if (!credential) throw new DOMException('Passkey 操作已取消。','NotAllowedError');
  const response = {clientDataJSON:enc(credential.response.clientDataJSON)};
  if (challenge.registration) {
    response.attestationObject = enc(credential.response.attestationObject);
    if (credential.response.getTransports) response.transports = credential.response.getTransports();
  } else {
    response.authenticatorData = enc(credential.response.authenticatorData);
    response.signature = enc(credential.response.signature);
    if (credential.response.userHandle) response.userHandle = enc(credential.response.userHandle);
  }
  const result = {id:credential.id,rawId:enc(credential.rawId),type:credential.type,response,clientExtensionResults:credential.getClientExtensionResults()};
  if (credential.authenticatorAttachment) result.authenticatorAttachment = credential.authenticatorAttachment;
  return result;
}
function stageChallenge(challenge, title, description, verify, success) {
  if (!supportsPasskeys) throw new Error('此浏览器不支持 WebAuthn。请使用支持 Passkey 的安全外部浏览器；不会降级为普通验证。');
  if (!challenge?.options || !challenge.challengeId || typeof challenge.registration !== 'boolean') throw new Error('服务器 Passkey challenge 格式异常。');
  pending = {challenge,verify,success,deadline:Math.min(Date.now() + 120000,sessionExpiresAt)};
  $('ceremony-title').textContent = title;
  $('ceremony-description').textContent = description;
  $('ceremony-submit').textContent = challenge.registration ? '注册 Passkey 并确认' : '验证 Passkey 并确认';
  $('ceremony-state').textContent = '点击下方按钮打开系统 Passkey 提示。操作须在两分钟内完成。';
  disabled($('ceremony-submit'),false);
  if (!dialog.open) { returnFocus = document.activeElement; dialog.showModal(); }
  $('ceremony-submit').focus();
}
$('ceremony-submit').addEventListener('click', () => run(async () => {
  const current = pending;
  if (!current || Date.now() >= current.deadline) { pending = null; dialog.close(); throw new Error('Passkey challenge 已过期，请重新开始。'); }
  pending = null;
  $('ceremony-state').textContent = '等待系统 Passkey 验证；请勿关闭此页面…';
  try {
    const response = await ceremony(current.challenge);
    $('ceremony-state').textContent = '正在校验签名并提交，请勿重复操作…';
    await current.verify(response);
    if (!pending) {
      dialog.close();
      await refreshAll();
      message(current.success);
    }
  } catch (error) {
    dialog.close(); pending = null;
    if (error.name !== 'NotAllowedError' && error.name !== 'AbortError') {
      throw new Error(error.message + ' 操作未确认完成；请刷新核对服务器状态后再重试。');
    }
    throw error;
  }
}));
function cancelCeremony() { pending = null; dialog.close(); message('已取消 Passkey 流程，未提交变更。'); }
$('ceremony-cancel').addEventListener('click',() => { if (!busy) cancelCeremony(); });
dialog.addEventListener('cancel',event => { event.preventDefault(); if (!busy) cancelCeremony(); });
dialog.addEventListener('close',() => { if (returnFocus?.isConnected) returnFocus.focus(); });
$('add-passkey-form').addEventListener('submit',event => {
  event.preventDefault();
  run(async () => {
    if (!credentials) throw new Error('请先成功读取 Passkey 列表。');
    const name = $('credential-name').value.trim();
    if (!name || name.length > 80) throw new Error('Passkey 名称须为 1–80 字符。');
    if (!credentials.length) {
      const challenge = await securityOptions('register','',name);
      stageChallenge(challenge,'注册首个 Passkey','登记 “' + name + '”。注册不会自动更改任何客户端策略。',response => api('/security/api/verify','POST',{challengeId:challenge.challengeId,response}),'首个 Passkey 已注册。');
    } else {
      const challenge = await securityOptions('add','',name);
      stageChallenge(challenge,'添加 Passkey · 1 / 2','先验证已有凭据；成功后需再次点击注册新 Passkey。',async response => {
        const proof = await api('/security/api/verify','POST',{challengeId:challenge.challengeId,response});
        if (!proof.registrationTicket) throw new Error('服务器未返回新凭据注册许可。');
        const registration = await api('/security/api/add-options','POST',{ticket:proof.registrationTicket,name});
        stageChallenge(registration,'添加 Passkey · 2 / 2','已有凭据验证成功。点击下方按钮，为 “' + name + '” 注册新 Passkey。',response => api('/security/api/add-verify','POST',{challengeId:registration.challengeId,response}),'新 Passkey 已注册。');
      },'');
    }
  });
});
$('refresh-all-btn').addEventListener('click',() => run(async () => { await refreshAll(); message('所有数据已刷新。'); }));
$('clients-refresh-btn').addEventListener('click',() => run(async () => { await refreshAll(); message('所有数据已刷新。'); }));
$('audit-refresh-btn').addEventListener('click',() => run(async () => { await refreshAll(); message('所有数据已刷新。'); }));
$('passkeys-refresh-btn').addEventListener('click',() => run(async () => { await refreshAll(); message('所有数据已刷新。'); }));
$('audit-filter-form').addEventListener('submit',event => {
  event.preventDefault(); run(async () => {
    auditFilters = {clientId:$('audit-filter-client').value.trim(),toolName:$('audit-filter-tool').value.trim(),status:$('audit-filter-status').value};
    auditOffset = 0; await loadAudit(); message('审计筛选已应用。');
  });
});
$('audit-clear-btn').addEventListener('click',() => run(async () => {
  $('audit-filter-form').reset(); auditFilters = {clientId:'',toolName:'',status:''}; auditOffset = 0; await loadAudit(); message('已清除审计筛选。');
}));
$('audit-prev-btn').addEventListener('click',() => run(async () => { auditOffset = Math.max(0,auditOffset - auditLimit); await loadAudit(); }));
$('audit-next-btn').addEventListener('click',() => run(async () => { if (auditOffset + auditLimit < auditTotal) { auditOffset += auditLimit; await loadAudit(); } }));
const tabs = [...document.querySelectorAll('[role="tab"]')];
function selectTab(tab) {
  tabs.forEach(item => {
    const selected = item === tab;
    item.setAttribute('aria-selected',String(selected)); item.tabIndex = selected ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !selected;
  });
}
tabs.forEach((tab,index) => {
  tab.addEventListener('click',() => selectTab(tab));
  tab.addEventListener('keydown',event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next]); tabs[next].focus(); }
  });
});
function tick() {
  const remaining = sessionExpiresAt - Date.now();
  if (remaining <= 0) { markExpired(); return; }
  $('session-state').textContent = '会话剩余 ' + Math.ceil(remaining / 60000) + ' 分钟';
  $('session-state').className = 'badge ' + (remaining < 120000 ? 'warn' : 'neutral');
  updateOverviewStatus();
  if (pending && Date.now() >= pending.deadline && !busy) { pending = null; dialog.close(); message('Passkey challenge 已过期，未提交变更。请重新开始。',true); }
}
if (!supportsPasskeys) {
  $('webauthn-warning').hidden = false;
  disabled($('credential-name'),true);
}
tick(); setInterval(tick,1000);
run(refreshAll);
})();
`;

export function renderDashboardPage(props: DashboardPageProps) {
  const { session, appVersion, allowedUserId } = props;
  return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf" content="${session.csrf}">
  <meta name="session-expires" content="${session.expiresAt}">
  <title>Schwab MCP · 控制面板</title>
  <style>${raw(DASHBOARD_STYLES)}</style>
</head>
<body>
<a class="skip" href="#dashboard-main">跳至控制面板</a>
<div class="shell">
  <header class="topline">
    <div class="brand">${raw(BRAND_LOGO_SVG)}<div><div class="eyebrow">Schwab MCP / Control Center</div><h1>客户端与安全控制面板</h1><p>授权策略、调用审计与 owner Passkey</p></div></div>
    <div class="actions"><div class="owner">GitHub owner <strong class="mono">${allowedUserId}</strong><br><span id="last-refresh">尚未刷新</span></div><button id="refresh-all-btn" class="button" data-action type="button">刷新全部</button></div>
  </header>
  <section class="status-deck" aria-label="服务与会话状态">
    <div class="status-cell"><span class="label">01 / Schwab 连接</span><span id="schwab-status-badge" class="badge neutral">正在读取连接状态</span><p id="access-expiry">Access 到期：读取中</p><p id="refresh-expiry">Refresh 到期：读取中</p><p><a href="/auth/schwab/connect">连接 / 重新授权 Schwab</a></p></div>
    <div class="status-cell"><span class="label">02 / 运行状态</span><span id="trading-status-badge" class="badge neutral">正在读取交易总开关</span><p>由部署配置 ENABLE_TRADING 控制；仪表板不能开启交易。</p><p id="overview-counts">正在读取概览</p></div>
    <div class="status-cell"><span class="label">03 / 浏览器安全会话</span><span id="session-state" class="badge neutral">正在检查会话</span><p>GitHub numeric owner 验证 · 15 分钟有效期</p><p><a href="/security">独立安全中心</a> · <a href="/dashboard">重新登录 / 续期</a></p></div>
  </section>
  <div id="global-msg" class="message" role="status" aria-live="polite" aria-atomic="true" hidden></div>
  <p id="session-login" class="session-link" hidden><a class="button primary" href="/dashboard">通过 GitHub owner 重新登录</a></p>
  <p id="webauthn-warning" class="support-warning" style="margin-top:16px" hidden>当前浏览器或连接不支持 WebAuthn。Passkey 与 Advanced Security 操作已禁用。请在支持 Passkey 的安全外部浏览器中打开仪表板；不会使用普通验证代替。</p>
  <main id="dashboard-main" tabindex="-1" aria-busy="false">
    <div class="tabs" role="tablist" aria-label="控制面板模块">
      <button id="clients-tab" class="tab" role="tab" aria-selected="true" aria-controls="tab-clients" type="button"><span>01 / ACCESS</span>授权客户端</button>
      <button id="audit-tab" class="tab" role="tab" aria-selected="false" aria-controls="tab-audit" tabindex="-1" type="button"><span>02 / ACTIVITY</span>调用审计</button>
      <button id="passkeys-tab" class="tab" role="tab" aria-selected="false" aria-controls="tab-passkeys" tabindex="-1" type="button"><span>03 / SECURITY</span>Passkey 管理</button>
    </div>
    <section id="tab-clients" class="panel" role="tabpanel" aria-labelledby="clients-tab" tabindex="0">
      <div class="section-head"><div><h2>已授权 MCP 客户端</h2><p>每个客户端独立授权。权限调整与撤销将在后续 MCP 请求即时生效；Advanced Security 变更须由 Passkey 验证。</p></div><button id="clients-refresh-btn" class="button" data-action type="button">刷新客户端</button></div>
      <div class="table-scroll" role="region" aria-label="客户端列表，可横向滚动" tabindex="0"><table id="clients-table"><caption id="clients-count">正在读取客户端</caption><thead><tr><th scope="col">客户端 / 重定向 URI</th><th scope="col">状态</th><th scope="col">权限等级</th><th scope="col">Advanced Security</th><th scope="col">授权 / 最后调用</th><th scope="col">操作</th></tr></thead><tbody id="clients-table-body"><tr><td colspan="6" class="empty">正在加载客户端…</td></tr></tbody></table></div>
    </section>
    <section id="tab-audit" class="panel" role="tabpanel" aria-labelledby="audit-tab" tabindex="0" hidden>
      <div class="section-head"><div><h2>工具调用审计</h2><p>只读与交易工具的脱敏调用记录。保留最近 30 天，最多 5,000 条；统计依据当前已应用的筛选条件。</p></div><button id="audit-refresh-btn" class="button" data-action type="button">刷新日志</button></div>
      <div class="stats" aria-label="审计统计">
        <div class="stat"><span class="label">匹配调用量</span><div id="audit-total-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">成功率</span><div id="audit-success-rate" class="stat-value">—</div></div>
        <div class="stat"><span class="label">成功</span><div id="audit-success-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">错误</span><div id="audit-error-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">近 24 小时调用</span><div id="audit-active24h" class="stat-value">—</div></div>
      </div>
      <form id="audit-filter-form" class="filters">
        <label class="field" for="audit-filter-client">Client ID（精确匹配）<input id="audit-filter-client" data-action type="text" placeholder="全部客户端" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="audit-filter-tool">工具名称（精确匹配）<input id="audit-filter-tool" data-action type="text" placeholder="例如 get_quotes" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="audit-filter-status">执行状态<select id="audit-filter-status" data-action><option value="">全部状态</option><option value="SUCCESS">成功 SUCCESS</option><option value="ERROR">错误 ERROR</option></select></label>
        <div class="actions"><button class="button primary" data-action type="submit">应用筛选</button><button id="audit-clear-btn" class="button" data-action type="button">清除</button></div>
      </form>
      <div class="table-scroll" role="region" aria-label="调用日志，可横向滚动" tabindex="0"><table id="audit-table"><thead><tr><th scope="col">时间</th><th scope="col">Client ID</th><th scope="col">工具</th><th scope="col">状态</th><th scope="col">耗时</th><th scope="col">脱敏参数 / 错误</th><th scope="col">完整 Request ID</th></tr></thead><tbody id="audit-table-body"><tr><td colspan="7" class="empty">正在加载审计记录…</td></tr></tbody></table></div>
      <div class="pagination"><span id="audit-pagination-info" role="status">正在读取分页</span><div class="actions"><button id="audit-prev-btn" class="button" data-action data-disabled="true" type="button" disabled>上一页</button><button id="audit-next-btn" class="button" data-action data-disabled="true" type="button" disabled>下一页</button></div></div>
    </section>
    <section id="tab-passkeys" class="panel" role="tabpanel" aria-labelledby="passkeys-tab" tabindex="0" hidden>
      <div class="section-head"><div><h2>Owner Passkey 管理</h2><p>凭据由 owner 共享。添加、重命名、删除均需验证已有 Passkey；最后一个凭据不可删除，取消或失败不会降级。</p></div><button id="passkeys-refresh-btn" class="button" data-action type="button">刷新凭据</button></div>
      <div class="stats overview-stats" aria-label="全局概览"><div class="stat"><span class="label">已授权客户端</span><div id="stat-clients-count" class="stat-value">—</div></div><div class="stat"><span class="label">保留调用记录</span><div id="stat-total-calls" class="stat-value">—</div></div><div class="stat"><span class="label">已登记 Passkey</span><div id="stat-passkeys-count" class="stat-value">—</div></div></div>
      <div class="panel-body">
        <h3 id="passkeys-state">正在读取凭据</h3>
        <ul id="passkeys-list" class="credentials"><li class="empty">正在加载 Passkey…</li></ul>
        <form id="add-passkey-form" class="add-passkey"><label class="field" for="credential-name">新 Passkey 名称<input id="credential-name" data-action type="text" maxlength="80" required value="我的 Passkey" autocomplete="off"></label><button id="add-passkey-btn" class="button primary" data-action data-disabled="true" type="submit" disabled>添加 Passkey</button></form>
        <p class="muted" style="font-size:12px;margin-top:10px">添加已有凭据后的新设备分两步：先验证现有凭据，再单独点击注册。系统提示中请选择所需设备。</p>
        <div class="recovery"><p>所有凭据均丢失？通过独立 GitHub owner OAuth 恢复。恢复将使旧会话与待批准提案失效。</p><a class="button danger" href="/security/recover">Passkey 灾难恢复</a></div>
      </div>
    </section>
  </main>
  <footer class="footer"><span>Schwab MCP v${appVersion} · Workers / SQLite / WebAuthn</span><span>此页面不读取账户明文、Secret 或 Token。</span></footer>
</div>
<dialog id="passkey-dialog" aria-labelledby="ceremony-title" aria-describedby="ceremony-description ceremony-state">
  <h2 id="ceremony-title">验证 Passkey</h2><p id="ceremony-description"></p><p id="ceremony-state" role="status" aria-live="polite"></p>
  <div class="actions"><button id="ceremony-cancel" class="button" data-action type="button">取消</button><button id="ceremony-submit" class="button primary" data-action type="button">验证 Passkey 并确认</button></div>
</dialog>
<script>${raw(DASHBOARD_SCRIPT)}</script>
</body>
</html>`;
}
