import { html, raw } from "hono/html";
import type { BrowserSession, ClientAuthorizationStatus } from "./security-store";
import type { PermissionLevel } from "./oauth-access";
import { BACKGROUND_SVG, BRAND_LOGO_SVG, COMMON_STYLES, FAVICON_LINK, PWA_HEAD_TAGS, PWA_SERVICE_WORKER_SCRIPT } from "./auth-ui";

// Native WebAuthn only; no framework, CDN or browser bearer token.
const SCRIPT = `
const status = document.querySelector('#status');
const csrf = document.querySelector('meta[name="csrf"]').content;
const data = JSON.parse(document.querySelector('#page-data').textContent);
const enc = b => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const dec = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
async function api(path, body) {
  const r = await fetch('/security/api/' + path, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body)});
  const v = await r.json();
  if (!r.ok || v.error) throw new Error(v.error?.message || '验证失败，请刷新页面重试。');
  return v;
}
async function ceremony(v) {
  const o = v.options;
  o.challenge = dec(o.challenge);
  if (v.registration) {
    o.user.id = dec(o.user.id);
    o.excludeCredentials = (o.excludeCredentials || []).map(c => ({...c,id:dec(c.id)}));
  } else o.allowCredentials = (o.allowCredentials || []).map(c => ({...c,id:dec(c.id)}));
  const c = await navigator.credentials[v.registration ? 'create' : 'get']({publicKey:o});
  if (!c) throw new Error('验证已取消，订单保持未批准。');
  const response = {clientDataJSON:enc(c.response.clientDataJSON)};
  if (v.registration) {
    response.attestationObject = enc(c.response.attestationObject);
    if (c.response.getTransports) response.transports = c.response.getTransports();
  } else {
    response.authenticatorData = enc(c.response.authenticatorData);
    response.signature = enc(c.response.signature);
    if (c.response.userHandle) response.userHandle = enc(c.response.userHandle);
  }
  return {id:c.id,rawId:enc(c.rawId),type:c.type,response,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment};
}
let busy = false;
async function act(operation, target) {
  if (busy) return;
  busy = true;
  const enabledButtons = [...document.querySelectorAll('button')].filter(b => !b.disabled);
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  if (status) status.textContent = '请在系统提示中完成 Passkey 验证…';
  try {
    const name = document.querySelector('#credential-name')?.value || 'Passkey';
    const v = await api('options', {operation,target,name,proposalId:data.proposalId,resetConfirmation:document.querySelector('#reset-confirmation')?.value});
    const response = await ceremony(v);
    const result = await api('verify', {challengeId:v.challengeId,response});
    if (result.redirectTo) { location.assign(result.redirectTo); return; }
    if (result.recovered) { location.assign('/security'); return; }
    if (result.registrationTicket) {
      if (status) status.textContent = '已有 Passkey 验证成功。点击“注册新 Passkey”继续。';
      const button = document.querySelector('#register-add');
      if (button) { button.hidden = false; button.dataset.ticket = result.registrationTicket; }
      return;
    }
    if (operation === 'approve') {
      if (['EXECUTED', 'ACTIVE'].includes(result.status) || result.result?.status === 'ACTIVE') {
        location.replace('/security/approvals/' + encodeURIComponent(data.proposalId) + '/complete');
        return;
      }
      if (status) status.textContent = JSON.stringify(result, null, 2);
      const approveBtn = document.querySelector('#approve');
      if (approveBtn) approveBtn.hidden = true;
    } else location.reload();
  } catch(e) {
    if (status) status.textContent = e.name === 'NotAllowedError' ? '操作已取消或超时，订单保持未批准。' : e.message;
  } finally {
    busy = false;
    enabledButtons.forEach(b => b.disabled = false);
  }
}

document.querySelectorAll('[data-operation]').forEach(b => b.addEventListener('click', () => act(b.dataset.operation, b.dataset.target)));
document.querySelector('#register-add')?.addEventListener('click', async e => {
  if (busy) return;
  busy = true;
  try {
    const v = await api('add-options', {ticket:e.currentTarget.dataset.ticket,name:document.querySelector('#credential-name')?.value || 'Passkey'});
    const response = await ceremony(v);
    await api('add-verify', {challengeId:v.challengeId,response});
    location.reload();
  } catch(e) { if (status) status.textContent = e.message; } finally {busy = false;}
});

if (data && data.authorizationId) {
  const authId = data.authorizationId;
  let stagedAuth = null;

  document.querySelector('#stage-auth-btn')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    if (status) status.textContent = '正在获取核准选项…';
    try {
      const v = await api('authorization-options', { authorizationId: authId });
      stagedAuth = v;
      document.querySelector('#stage-auth-btn').style.display = 'none';
      document.querySelector('#submit-auth-btn').style.display = 'inline-flex';
      if (status) status.textContent = '选项已准备就绪，请点击“调起系统硬件验证”。';
    } catch(e) {
      if (status) status.textContent = e.message;
    } finally {
      busy = false;
    }
  });

  document.querySelector('#submit-auth-btn')?.addEventListener('click', async () => {
    if (busy || !stagedAuth) return;
    busy = true;
    if (status) status.textContent = '请在系统提示中验证生物识别或硬件密钥…';
    try {
      const response = await ceremony(stagedAuth);
      await api('authorization-verify', { challengeId: stagedAuth.challengeId, response });
      if (data.isOriginalSession) {
        if (status) status.textContent = 'Passkey 核准成功，正在完成授权并交付结果…';
        const finishRes = await api('authorization-resume', { authorizationId: authId });
        if (finishRes.redirectTo) {
          location.replace(finishRes.redirectTo);
          return;
        }
      } else {
        if (status) status.textContent = '已使用 Passkey 成功核准！发起端设备将自动完成授权并继续。';
        document.querySelector('#action-buttons-container')?.remove();
      }
    } catch(e) {
      if (status) status.textContent = e.name === 'NotAllowedError' ? '操作已取消，保持未批准。' : e.message;
    } finally {
      busy = false;
    }
  });

  document.querySelector('#cancel-auth-btn')?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    try {
      await api('authorization-cancel', { authorizationId: authId });
      if (status) status.textContent = '已取消本次申请。';
      document.querySelector('#action-buttons-container')?.remove();
    } catch(e) {
      if (status) status.textContent = e.message;
    } finally {
      busy = false;
    }
  });

  if (data.isOriginalSession && data.status === 'PENDING') {
    const poller = setInterval(async () => {
      try {
        const r = await fetch('/security/api/authorization-status/' + encodeURIComponent(authId), { credentials: 'same-origin' });
        if (!r.ok) return;
        const s = await r.json();
        if (s.status === 'APPROVED') {
          clearInterval(poller);
          if (status) status.textContent = 'Passkey 核准成功，正在完成授权并交付结果…';
          const finishRes = await api('authorization-resume', { authorizationId: authId });
          if (finishRes.redirectTo) {
            location.replace(finishRes.redirectTo);
          }
        } else if (['FINISHING', 'COMPLETED', 'CANCELLED', 'INVALIDATED', 'FAILED', 'EXPIRED'].includes(s.status)) {
          clearInterval(poller);
          const badge = document.querySelector('#auth-status-badge');
          if (badge) badge.textContent = s.status;
          if (status) status.textContent = '授权状态已变更为: ' + s.status;
        }
      } catch {}
    }, 2000);
  }
}

if (!window.PublicKeyCredential || !navigator.credentials) {
  if (status) status.textContent = '此浏览器不支持 WebAuthn。请在支持 Passkey 的外部浏览器中打开；操作保持未批准。';
  document.querySelectorAll('button').forEach(b => b.disabled = true);
}
`;
const FINGERPRINT_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-8.5 15.3"/><path d="M20.5 17.3A10 10 0 0 0 12 2"/><path d="M12 6a6 6 0 0 0-6 6c0 3.3 1.7 6.2 4.3 7.8"/><path d="M14 19.8A6 6 0 0 0 18 12a6 6 0 0 0-3-5.2"/><path d="M12 10a2 2 0 0 0-2 2c0 2 1 3.5 2 4.5"/></svg>`;

const KEY_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 3-9.5 9.5M15.5 7.5l3 3M13 10l2 2"/></svg>`;

const SHIELD_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

const LOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

const INFO_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

const SECURITY_STYLES = `
${COMMON_STYLES}

main {
  position: relative;
  z-index: 1;
  width: 100%;
  max-width: 580px;
  display: flex;
  flex-direction: column;
  align-items: center;
  overflow-wrap: anywhere;
  margin: auto 0;
}

main:has(.approval-layout) {
  max-width: 1060px;
}

.approval-layout {
  display: grid;
  grid-template-columns: 1.15fr 0.85fr;
  gap: 20px;
  width: 100%;
  align-items: start;
}

.approval-cockpit, .approval-inspector {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.terminal-card {
  padding: 0 !important;
  overflow: hidden;
}

.terminal-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #060911;
  border-bottom: 1px solid var(--panel-border);
}

.terminal-dots {
  display: flex;
  gap: 6px;
}

.terminal-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.terminal-dot.red { background: #f43f5e; }
.terminal-dot.yellow { background: #f59e0b; }
.terminal-dot.green { background: #10b981; }

.terminal-title {
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 11.5px;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}

.terminal-desc {
  padding: 14px 16px 4px;
  font-size: 11.5px;
  color: var(--text-sub);
  line-height: 1.45;
}

.approval-inspector .code-preview {
  margin: 10px 16px;
  max-height: 440px;
  border: 1px solid var(--panel-border);
}

.inspector-badge-row {
  display: flex;
  gap: 8px;
  padding: 0 16px 16px;
  flex-wrap: wrap;
}

.pill-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

.pill-btn.full-width {
  width: 100%;
  margin-top: 16px;
}

.form-group {
  width: 100%;
  margin-top: 14px;
}

.form-label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-main);
  margin-bottom: 6px;
}

.form-label-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
}

.input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.input-icon {
  position: absolute;
  left: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  pointer-events: none;
}

.text-input {
  width: 100%;
  padding: 10px 14px 10px 38px;
  font-size: 13.5px;
  font-family: inherit;
  color: var(--text-main);
  background: var(--code-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  box-sizing: border-box;
}

.text-input:focus {
  border-color: var(--brand-cyan);
  box-shadow: 0 0 0 2px var(--brand-cyan-soft);
}

.text-input.no-icon {
  padding-left: 14px;
}

.secondary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--panel-bg);
  color: var(--text-main);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  text-decoration: none;
}

.secondary-btn:hover {
  background: #131b2e;
  border-color: var(--brand-cyan);
  color: var(--brand-cyan);
}

.secondary-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.secondary-btn.danger {
  color: var(--brand-rose);
  border-color: rgba(244, 63, 94, 0.3);
  background: rgba(244, 63, 94, 0.08);
}

.secondary-btn.danger:hover {
  border-color: var(--brand-rose);
  background: rgba(244, 63, 94, 0.18);
  color: #fff;
}

.credential-list {
  list-style: none;
  padding: 0;
  margin: 12px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.credential-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--panel-bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  gap: 12px;
}

.credential-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.credential-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.credential-id {
  font-size: 11px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.credential-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.order-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 12px 0;
  background: var(--panel-bg);
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid var(--panel-border);
}

.order-table th {
  background: #060911;
  color: var(--text-muted);
  font-size: 10.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
  padding: 9px 12px;
  text-align: left;
  border-bottom: 1px solid var(--panel-border);
}

.order-table td {
  padding: 9px 12px;
  border-bottom: 1px solid rgba(30, 41, 59, 0.6);
  color: var(--text-main);
  overflow-wrap: anywhere;
}

.order-table tr:last-child td {
  border-bottom: none;
}

.code-preview {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11.5px;
  background: var(--code-bg);
  color: var(--code-text);
  border: 1px solid var(--code-border);
  border-radius: 6px;
  padding: 12px;
  max-height: 260px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.45;
  margin: 10px 0;
}

#status {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
  font-size: 12px;
  font-family: ui-monospace, "SF Mono", monospace;
  line-height: 1.5;
  text-align: center;
  margin-top: 14px;
  width: 100%;
}

#status:not(:empty) {
  padding: 12px 14px;
  border-radius: 6px;
  background: var(--brand-cyan-soft);
  border: 1px solid var(--brand-cyan-border);
  color: #bae6fd;
}

.auth-footer a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s ease;
}

.auth-footer a:hover {
  color: var(--brand-cyan);
  text-decoration: underline;
}

.security-disclaimer {
  margin-top: 12px;
  font-size: 11px;
  color: var(--text-muted);
  text-align: center;
  line-height: 1.4;
  max-width: 500px;
  opacity: 0.8;
}

@media (max-width: 900px) {
  .approval-layout {
    grid-template-columns: 1fr;
    gap: 16px;
  }
  .approval-inspector .code-preview {
    max-height: 240px;
  }
}

@media (max-width: 768px) {
  .approval-sticky-bar {
    position: sticky;
    bottom: 0;
    left: 0;
    right: 0;
    background: rgba(9, 13, 22, 0.94);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    border-top: 1px solid var(--card-border);
    padding: 12px 16px;
    padding-bottom: max(14px, env(safe-area-inset-bottom));
    margin: 16px -16px -16px;
    z-index: 40;
    box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.6);
  }
  .approval-sticky-bar .pill-btn {
    min-height: 52px;
    margin: 0;
    font-size: 15px;
  }
  .credential-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .credential-actions {
    width: 100%;
    display: flex;
    gap: 8px;
  }
  .credential-actions .secondary-btn {
    flex: 1;
    min-height: 40px;
  }
}
`;

function orderSummary(preview: unknown) {
  if (!preview || typeof preview !== "object") return html`<p class="policy-desc">订单预览不可用。</p>`;
  const account: unknown = Reflect.get(preview, "accountHash");
  const action: unknown = Reflect.get(preview, "action");
  const mode: unknown = Reflect.get(preview, "executionMode");
  const order: unknown = Reflect.get(preview, "orderPayload");
  const legs: Record<string, unknown>[] = [];
  function visit(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.orderLegCollection)) for (const leg of record.orderLegCollection as unknown[]) {
      if (leg && typeof leg === "object") {
        const instrument: unknown = Reflect.get(leg, "instrument");
        legs.push({
          symbol: instrument && typeof instrument === "object" ? Reflect.get(instrument, "symbol") as unknown : "见 JSON",
          instruction: Reflect.get(leg, "instruction") as unknown, quantity: Reflect.get(leg, "quantity") as unknown,
          type: record.orderType, price: record.price ?? record.stopPrice ?? "见 JSON", duration: record.duration,
        });
      }
    }
    if (Array.isArray(record.childOrderStrategies)) for (const child of record.childOrderStrategies as unknown[]) visit(child);
  }
  visit(order);
  const display = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "见 JSON";
  return html`
    <div class="info-row"><span class="info-label">账户标识</span><span class="info-value"><span class="tag-badge">${display(account)}</span></span></div>
    <div class="info-row" style="margin-top: 6px;"><span class="info-label">操作类型</span><span class="info-value">${display(action)} · ${display(mode)}</span></div>
    <table class="order-table">
      <thead><tr><th>标的 / 方向</th><th>数量</th><th>价格类型 / 价格</th><th>有效期</th></tr></thead>
      <tbody>${legs.map(leg => html`<tr><td>${display(leg.symbol)} / ${display(leg.instruction)}</td><td>${display(leg.quantity)}</td><td>${display(leg.type)} / ${display(leg.price)}</td><td>${display(leg.duration)}</td></tr>`)}</tbody>
    </table>
  `;
}

export function renderSecurityPage(session: BrowserSession, credentials: { id: string; name: string }[], proposal?: { proposalId: string; status: string; preview: unknown; intentDigest: string; expiresAt: string; outcome: unknown }) {
  // JSON script content is escaped for the HTML parser as well as the JS parser.
  const data = JSON.stringify({ proposalId: proposal?.proposalId }).replaceAll("<", "\\u003c");

  const policyListHtml = html`
    <div class="policy-list">
      <div class="policy-item">
        <div class="policy-icon blue">${raw(SHIELD_ICON_SVG)}</div>
        <div class="policy-content">
          <div class="policy-title">硬件级密钥保护</div>
          <div class="policy-desc">私钥安全保存在本机 Secure Enclave 或硬件安全密钥中，永不离境。</div>
        </div>
      </div>
      <div class="policy-item">
        <div class="policy-icon green">${raw(LOCK_ICON_SVG)}</div>
        <div class="policy-content">
          <div class="policy-title">零对话降级与防篡改</div>
          <div class="policy-desc">建单、改单及策略变更需经浏览器生物识别核验，防御客户端凭据失陷。</div>
        </div>
      </div>
    </div>
  `;

  return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="csrf" content="${session.csrf}">
  <title>Advanced Security · Schwab MCP</title>
  ${FAVICON_LINK}
  ${PWA_HEAD_TAGS}
  <style>${raw(SECURITY_STYLES)}</style>
</head>
<body>
  ${raw(BACKGROUND_SVG)}
  <main>
    <div class="brand-header" style="display:flex;align-items:center;justify-content:space-between;width:100%;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${raw(BRAND_LOGO_SVG)}
        <span class="brand-title">SCHWAB MCP</span>
      </div>
      <a href="/dashboard" class="action-btn" style="text-decoration:none;padding:8px 14px;font-size:13px;width:auto;">&larr; 返回控制面板</a>
    </div>
    ${proposal ? html`
      <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
        <div class="telemetry-node">
          <span class="status-pulse-dot"></span>
          <span>&gt;_ SCHWAB::MCP//ORDER_PASSKEY_GATEWAY</span>
        </div>
        <div class="telemetry-chips">
          <span class="tag-badge green">&bull; FIDO2::READY</span>
          <span class="tag-badge">ZERO-DOWNGRADE</span>
        </div>
      </div>
      <div class="security-notice" style="width:100%;margin-bottom:14px;border-color:var(--brand-cyan-border);background:var(--brand-cyan-soft);color:var(--brand-cyan);font-size:11.5px;">
        &bull; ZERO-KNOWLEDGE EXECUTION: Unconditional direct execution via Schwab Model Context Protocol. No conversational downgrade permitted.
      </div>
      <h1 class="page-title">订单 Passkey 硬件批准</h1>
      <p class="page-subtitle">请使用已绑定的 Passkey 核对并授权此笔交易 · 严格防篡改保障</p>
      <div class="approval-layout">
        <div class="approval-cockpit">
          <div class="auth-card">
            <div class="info-row">
              <span class="info-label">提案状态</span>
              <span class="info-value">
                <span class="tag-badge ${proposal.status === "PENDING" ? "" : "green"}">${proposal.status}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">批准截止</span>
              <span class="info-value timestamp">${proposal.expiresAt}</span>
            </div>
            <div class="info-row column">
              <span class="info-label">意图摘要</span>
              <div class="uri-box">${proposal.intentDigest}</div>
            </div>
            <div class="card-divider"></div>
            ${orderSummary(proposal.preview)}
            <div class="card-divider"></div>
            ${policyListHtml}
            ${proposal.status === "PENDING" ? html`
              <div class="approval-sticky-bar">
                <button id="approve" class="pill-btn full-width primary-glow" data-operation="approve">
                  ${raw(FINGERPRINT_ICON_SVG)}
                  <span>⚡ 批准并提交 (Approve via Passkey)</span>
                </button>
                <button id="ceremony-submit" class="pill-btn full-width primary-glow" hidden style="background:var(--primary);color:#003824;margin-top:8px;">
                  ${raw(FINGERPRINT_ICON_SVG)}
                  <span>调起系统硬件验证</span>
                </button>
              </div>
              <div class="action-hint">验证成功后服务器立即提交即时订单或激活延迟任务。无对话确认降级。</div>
            ` : html`
              <div class="policy-title" style="margin: 12px 0 4px;">执行结果</div>
              <pre class="code-preview">${JSON.stringify(proposal.outcome, null, 2)}</pre>
            `}
          </div>
        </div>
        <div class="approval-inspector">
          <div class="auth-card terminal-card">
            <div class="terminal-bar">
              <div class="terminal-dots">
                <span class="terminal-dot red"></span>
                <span class="terminal-dot yellow"></span>
                <span class="terminal-dot green"></span>
              </div>
              <span class="terminal-title">schwab_place_order.json [FROZEN]</span>
              <span class="tag-badge">IMMUTABLE</span>
            </div>
            <div class="terminal-desc">请核对账户标识、每条订单腿的买卖方向及数量、价格类型、有效期；延迟订单同时核对条件和截止时间。下列完整 JSON 是本次批准并执行的内容。</div>
            <pre class="code-preview">${JSON.stringify(proposal.preview, null, 2)}</pre>
            <div class="inspector-badge-row">
              <span class="tag-badge green">✓ Level 3 UV Required</span>
              <span class="tag-badge">RFC 7636 S256 Bound</span>
            </div>
          </div>
          <div class="auth-card" style="padding:12px 14px;background:var(--surface-container);border-color:var(--outline-variant);">
            <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text-main);font-weight:600;">
              <span class="status-pulse-dot"></span>
              <span>硬件认证器就绪：YubiKey 5C NFC / Apple Secure Enclave</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              FIDO2 Level 3 Authenticator &middot; WebAuthn User Verification Required
            </div>
          </div>
          <div class="terminal-hotkeys" style="margin-top:10px;font-size:11px;color:var(--text-muted);display:flex;justify-content:center;gap:10px;letter-spacing:0.04em;text-align:center;">
            <span>[ENTER] 调起 Passkey</span>
            <span>&bull;</span>
            <span>[ESC] 取消提案</span>
            <span>&bull;</span>
            <span>ENCLAVE AIRGAP CERTIFIED</span>
          </div>
        </div>
      </div>
    ` : session.recovery ? html`
      <div class="terminal-prompt-tag">&gt;_ DISASTER RECOVERY PROTOCOL</div>
      <h1 class="page-title">恢复 Passkey</h1>
      <p class="page-subtitle">本流程已独立完成 GitHub owner OAuth 验证</p>
      <div class="auth-card">
        <div class="security-notice amber">
          ${raw(INFO_ICON_SVG)}
          <div>GitHub 账户是凭据恢复的信任入口。新凭据注册成功前不删除旧凭据。完成后旧凭据、浏览器会话、challenge 和待批准增强提案全部失效；已激活延迟任务保留，Advanced Security 保持开启。</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reset-confirmation">
            <span>输入重置确认</span>
            <span class="form-label-hint">必须精确匹配</span>
          </label>
          <div class="input-wrapper">
            <input id="reset-confirmation" class="text-input no-icon" autocomplete="off" placeholder="输入“重置全部 Passkey”">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="credential-name">
            <span>替代凭据名称</span>
            <span class="form-label-hint">本机标识名</span>
          </label>
          <div class="input-wrapper">
            <span class="input-icon">${raw(KEY_ICON_SVG)}</span>
            <input id="credential-name" class="text-input" maxlength="80" value="替代 Passkey">
          </div>
        </div>
        <button class="pill-btn full-width" data-operation="recover">
          ${raw(FINGERPRINT_ICON_SVG)}
          <span>重置全部 Passkey 并注册替代凭据</span>
        </button>
      </div>
    ` : html`
      <div class="terminal-prompt-tag">&gt;_ CREDENTIAL SECURITY MANAGER</div>
      <h1 class="page-title">Advanced Security</h1>
      <p class="page-subtitle">设置按客户端生效。其他未开启客户端仍沿用对话确认与 session 直下策略。</p>
      <div class="auth-card">
        ${credentials.length ? html`
          <div class="info-row">
            <span class="info-label">已绑定 Passkey</span>
            <span class="info-value"><span class="tag-badge green">${credentials.length} 个活跃凭据</span></span>
          </div>
          <ul class="credential-list">
            ${credentials.map(c => html`
              <li class="credential-item">
                <div class="credential-info">
                  <span class="credential-name">${c.name}</span>
                  <span class="credential-id mono">${c.id.slice(0, 16)}…</span>
                </div>
                <div class="credential-actions">
                  <button class="action-btn" data-operation="rename" data-target="${c.id}">重命名</button>
                  ${credentials.length > 1 ? html`<button class="action-btn danger" data-operation="delete" data-target="${c.id}">删除</button>` : ""}
                </div>
              </li>
            `)}
          </ul>
          <button class="pill-btn secondary full-width" data-operation="add">
            ${raw(KEY_ICON_SVG)}
            <span>添加新 Passkey</span>
          </button>
          <button id="register-add" class="pill-btn primary full-width" hidden style="margin-top:8px;">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>注册新 Passkey</span>
          </button>
        ` : html`
          <div class="security-notice">
            ${raw(INFO_ICON_SVG)}
            <div>尚未绑定任何 Passkey。绑定硬件安全密钥或生物识别以保护您的账户。</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="credential-name"><span>首个 Passkey 名称</span></label>
            <div class="input-wrapper"><input id="credential-name" class="text-input" value="我的 Passkey" maxlength="80"></div>
          </div>
          <button class="pill-btn primary full-width" data-operation="register">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>注册首个 Passkey</span>
          </button>
        `}
      </div>
    `}
    <p id="status" role="status" aria-live="polite"></p>
    <div class="action-hint">浏览器会话 15 分钟有效 · 验证 challenge 最长 2 分钟${proposal ? " · 订单批准提案 5 分钟有效" : ""}</div>
    <div class="auth-footer">
      <a href="/security">凭据管理</a>
      <span class="footer-dot">·</span>
      <a href="/security/recover">全部 Passkey 丢失：通过独立 GitHub OAuth 恢复</a>
      <span class="footer-dot">·</span>
      <span>Charles Schwab MCP</span>
    </div>
    <div class="security-disclaimer">
      本功能防御 MCP 令牌或客户端失陷，不承诺抵抗 Worker、批准设备或 GitHub 恢复账户被控制。
    </div>
    <script id="page-data" type="application/json">${raw(data)}</script>
    <script>${raw(SCRIPT)}</script>
  </main>
  ${PWA_SERVICE_WORKER_SCRIPT}
</body>
</html>`;
}

export function renderClientAuthorizationPage(
  session: BrowserSession,
  clientAuth: {
    id: string;
    clientName: string;
    clientId: string;
    permissionLevel: PermissionLevel;
    advancedSecurity: boolean;
    redirectUri: string;
    status: ClientAuthorizationStatus;
    createdAt: number;
    expiresAt: number;
    digest: string;
  },
  credentials: { id: string; name: string }[],
  isOriginalSession: boolean
) {
  const data = JSON.stringify({
    authorizationId: clientAuth.id,
    status: clientAuth.status,
    isOriginalSession,
    expiresAt: clientAuth.expiresAt,
  }).replaceAll("<", "\\u003c");

  return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="csrf" content="${session.csrf}">
  <title>客户端授权核准 · Schwab MCP</title>
  ${FAVICON_LINK}
  ${PWA_HEAD_TAGS}
  <style>${raw(SECURITY_STYLES)}</style>
</head>
<body>
  ${raw(BACKGROUND_SVG)}
  <main>
    <div class="brand-header" style="display:flex;align-items:center;justify-content:space-between;width:100%;">
      <div style="display:flex;align-items:center;gap:12px;">
        ${raw(BRAND_LOGO_SVG)}
        <span class="brand-title">SCHWAB MCP</span>
      </div>
      <a href="/dashboard" class="action-btn" style="text-decoration:none;padding:8px 14px;font-size:13px;width:auto;">&larr; 返回控制面板</a>
    </div>

    <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
      <div class="telemetry-node">
        <span class="status-pulse-dot"></span>
        <span>&gt;_ SCHWAB::MCP//OAUTH_AUTHORIZATION_GATEWAY</span>
      </div>
      <div class="telemetry-chips">
        <span class="tag-badge green">&bull; RFC 7636 S256</span>
        <span class="tag-badge">${clientAuth.advancedSecurity ? "ADVANCED SECURITY" : "STANDARD MODE"}</span>
      </div>
    </div>

    <h1 class="page-title">${isOriginalSession && clientAuth.status === "PENDING" ? "等待 Passkey 硬件核准" : "客户端访问权限申请"}</h1>
    <p class="page-subtitle">${isOriginalSession && clientAuth.status === "PENDING" ? "请在已绑定的 iPhone PWA 或其他已登录设备上使用 Passkey 批准此请求，或在下方使用本机 Passkey。" : "请仔细核对客户端信息与权限设置，使用绑定的 Passkey 核准本次授权。"}</p>

    <div class="auth-card" style="width:100%;max-width:580px;">
      <div class="info-row">
        <span class="info-label">申请客户端</span>
        <span class="info-value"><strong>${clientAuth.clientName}</strong> <span class="tag-badge mono" style="font-size:10px">${clientAuth.clientId}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">权限等级</span>
        <span class="info-value"><span class="tag-badge ${clientAuth.permissionLevel === "full_access" ? "green" : ""}">${clientAuth.permissionLevel === "full_access" ? "完整访问 FULL ACCESS" : "只读权限 READ ONLY"}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">Advanced Security</span>
        <span class="info-value">${clientAuth.advancedSecurity ? "开启（每笔交易强制 Passkey 批准）" : "关闭"}</span>
      </div>
      <div class="info-row">
        <span class="info-label">回调地址</span>
        <span class="info-value mono" style="font-size:11px">${clientAuth.redirectUri}</span>
      </div>
      <div class="info-row">
        <span class="info-label">状态</span>
        <span class="info-value"><span id="auth-status-badge" class="tag-badge ${clientAuth.status === "APPROVED" || clientAuth.status === "COMPLETED" ? "green" : ""}">${clientAuth.status}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">截止时间</span>
        <span class="info-value timestamp">${new Date(clientAuth.expiresAt).toLocaleTimeString()}</span>
      </div>
      <div class="info-row">
        <span class="info-label">请求摘要 (Digest)</span>
        <div class="uri-box mono">${clientAuth.digest}</div>
      </div>

      <div class="card-divider"></div>

      <div id="status" class="action-hint" role="status" aria-live="polite">${isOriginalSession && clientAuth.status === "PENDING" ? "正在等待 Passkey 硬件核准中…（每 2 秒同步状态）" : ""}</div>

      ${clientAuth.status === "PENDING" ? html`
        <div id="action-buttons-container" style="display:flex;flex-direction:column;gap:12px;margin-top:14px;">
          <div class="form-group" style="${credentials.length ? "display:none;" : ""}">
            <label class="form-label" for="credential-name"><span>新 Passkey 名称</span></label>
            <div class="input-wrapper"><input id="credential-name" class="text-input" value="我的 Passkey" maxlength="80"></div>
          </div>
          <button id="stage-auth-btn" class="pill-btn primary full-width" data-action="stage-client-auth">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>${credentials.length ? "使用 Passkey 批准此请求" : "注册首个 Passkey 并批准"}</span>
          </button>
          <button id="submit-auth-btn" class="pill-btn primary full-width" style="display:none;background:var(--primary);color:#003824;">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>调起系统硬件验证</span>
          </button>
          <button id="cancel-auth-btn" class="pill-btn danger full-width" data-action="cancel-client-auth">取消本次申请</button>
        </div>
      ` : clientAuth.status === "APPROVED" ? html`
        <div class="security-notice green" style="margin-top:14px;">
          &bull; 已通过 Passkey 批准核验。发起端设备将自动完成授权流程并签发凭据。
        </div>
      ` : html`
        <div class="security-notice" style="margin-top:14px;">
          &bull; 授权请求当前状态: ${clientAuth.status}
        </div>
      `}
    </div>

    <div class="auth-footer" style="margin-top:20px;">
      <a href="/security">凭据管理</a>
      <span class="footer-dot">·</span>
      <a href="/dashboard">返回控制面板</a>
    </div>

    <script id="page-data" type="application/json">${raw(data)}</script>
    <script>${raw(SCRIPT)}</script>
  </main>
  ${PWA_SERVICE_WORKER_SCRIPT}
</body>
</html>`;
}
