import { html, raw } from "hono/html";
import type { BrowserSession, ClientAuthorizationStatus } from "./security-store";
import type { PermissionLevel } from "./oauth-access";
import { BACKGROUND_SVG, BRAND_LOGO_SVG, COMMON_STYLES, FAVICON_LINK, PWA_HEAD_TAGS, PWA_SERVICE_WORKER_SCRIPT } from "./auth-ui";
import { formatString, getDictionary, getSecurityClientI18n, type I18nDictionary, LANG_DROPDOWN_SCRIPT, renderLangDropdown, resolveLang, type SupportedLang } from "./i18n";

// Native WebAuthn only; no framework, CDN or browser bearer token.
const SCRIPT = `
function t(k, fallback = '') { return (typeof i18n !== 'undefined' && i18n[k]) || fallback; }
const status = document.querySelector('#status');
const csrf = document.querySelector('meta[name="csrf"]').content;
const data = JSON.parse(document.querySelector('#page-data').textContent);
const enc = b => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const dec = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
async function api(path, body) {
  const r = await fetch('/security/api/' + path, {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body)});
  const v = await r.json();
  if (!r.ok || v.error) throw new Error(v.error?.message || t('error', '验证失败，请刷新页面重试。'));
  return v;
}
async function ceremony(v) {
  let o;
  if (v.registration) {
    if (typeof PublicKeyCredential !== 'undefined' && typeof PublicKeyCredential.parseCreationOptionsFromJSON === 'function') {
      try { o = PublicKeyCredential.parseCreationOptionsFromJSON(v.options); } catch {}
    }
    if (!o) {
      o = {...v.options, challenge: dec(v.options.challenge), user: {...v.options.user, id: dec(v.options.user.id)}};
      o.excludeCredentials = (v.options.excludeCredentials || []).map(c => ({...c, id: dec(c.id)}));
    }
  } else {
    if (typeof PublicKeyCredential !== 'undefined' && typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'function') {
      try { o = PublicKeyCredential.parseRequestOptionsFromJSON(v.options); } catch {}
    }
    if (!o) {
      o = {...v.options, challenge: dec(v.options.challenge)};
      o.allowCredentials = (v.options.allowCredentials || []).map(c => ({...c, id: dec(c.id)}));
    }
  }
  const c = await navigator.credentials[v.registration ? 'create' : 'get']({publicKey:o});
  if (!c) throw new Error(t('scriptCancelledOrTimeout', '验证已取消，订单保持未批准。'));
  if (typeof c.toJSON === 'function') {
    return c.toJSON();
  }
  const response = {clientDataJSON:enc(c.response.clientDataJSON)};
  if (v.registration) {
    response.attestationObject = enc(c.response.attestationObject);
    if (c.response.getTransports) response.transports = c.response.getTransports();
  } else {
    response.authenticatorData = enc(c.response.authenticatorData);
    response.signature = enc(c.response.signature);
    if (c.response.userHandle) response.userHandle = enc(c.response.userHandle);
  }
  const ext = c.getClientExtensionResults ? c.getClientExtensionResults() : {};
  return {id:c.id,rawId:enc(c.rawId),type:c.type,response,clientExtensionResults:ext,authenticatorAttachment:c.authenticatorAttachment};
}
let busy = false;
async function act(operation, target) {
  if (busy) return;
  busy = true;
  const enabledButtons = [...document.querySelectorAll('button')].filter(b => !b.disabled);
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  if (status) status.textContent = t('scriptVerifyingPrompt', '请在系统提示中完成 Passkey 验证…');
  try {
    const name = document.querySelector('#credential-name')?.value || 'Passkey';
    const v = await api('options', {operation,target,name,proposalId:data.proposalId,resetConfirmation:document.querySelector('#reset-confirmation')?.value});
    const response = await ceremony(v);
    const result = await api('verify', {challengeId:v.challengeId,response});
    if (result.redirectTo) { location.assign(result.redirectTo); return; }
    if (result.recovered) { location.assign('/security'); return; }
    if (result.registrationTicket) {
      if (status) status.textContent = t('scriptVerifySuccess', '已有 Passkey 验证成功。点击“注册新 Passkey”继续。');
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
    if (status) status.textContent = e.name === 'NotAllowedError' ? t('scriptCancelledOrTimeout', '操作已取消或超时，订单保持未批准。') : e.message;
  } finally {
    busy = false;
    enabledButtons.forEach(b => b.disabled = false);
  }
}

document.querySelectorAll('[data-operation]').forEach(b => b.addEventListener('click', () => act(b.dataset.operation, b.dataset.target)));
document.querySelector('#reject-order')?.addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  const enabledButtons = [...document.querySelectorAll('button')].filter(b => !b.disabled);
  enabledButtons.forEach(b => b.disabled = true);
  try {
    const result = await api('reject-proposal', {proposalId:data.proposalId});
    location.assign(result.redirectTo);
  } catch(e) {
    if (status) status.textContent = e.message;
  } finally {
    busy = false;
    enabledButtons.forEach(b => b.disabled = false);
  }
});
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
  let resumePromise = null;
  let poller = null;
  let polling = false;
  function resumeAuthorization() {
    if (resumePromise) return resumePromise;
    clearInterval(poller);
    document.querySelector('#action-buttons-container')?.remove();
    if (status) status.textContent = t('scriptAuthResume', 'Passkey 核准成功，正在完成授权并交付结果…');
    resumePromise = api('authorization-resume', { authorizationId: authId }).then(result => {
      if (result.redirectTo) location.replace(result.redirectTo);
    }).catch(e => {
      if (status) status.textContent = e.message;
    });
    return resumePromise;
  }

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
    if (busy || resumePromise || !stagedAuth) return;
    busy = true;
    if (status) status.textContent = '请在系统提示中验证生物识别或硬件密钥…';
    try {
      const response = await ceremony(stagedAuth);
      await api('authorization-verify', { challengeId: stagedAuth.challengeId, response });
      if (data.isOriginalSession) {
        await resumeAuthorization();
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

  if (data.isOriginalSession && data.status === 'APPROVED') {
    void resumeAuthorization();
  } else if (data.isOriginalSession && data.status === 'PENDING') {
    poller = setInterval(async () => {
      if (busy || polling || resumePromise) return;
      polling = true;
      try {
        const r = await fetch('/security/api/authorization-status/' + encodeURIComponent(authId), { credentials: 'same-origin' });
        if (!r.ok) return;
        const s = await r.json();
        // Local verification may have completed while this request was pending.
        if (busy || resumePromise) return;
        if (s.status === 'APPROVED') {
          await resumeAuthorization();
        } else if (['FINISHING', 'COMPLETED', 'CANCELLED', 'INVALIDATED', 'FAILED', 'EXPIRED'].includes(s.status)) {
          clearInterval(poller);
          const badge = document.querySelector('#auth-status-badge');
          if (badge) badge.textContent = s.status;
          if (status) status.textContent = '授权状态已变更为: ' + s.status;
        }
      } catch {} finally { polling = false; }
    }, 2000);
  }
}

if (!window.PublicKeyCredential || !navigator.credentials) {
  if (status) status.textContent = t('scriptUnsupported', '此浏览器不支持 WebAuthn。请在支持 Passkey 的外部浏览器中打开；操作保持未批准。');
  document.querySelectorAll('button').forEach(b => { if (b.id !== 'reject-order') b.disabled = true; });
}
`;
const FINGERPRINT_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-8.5 15.3"/><path d="M20.5 17.3A10 10 0 0 0 12 2"/><path d="M12 6a6 6 0 0 0-6 6c0 3.3 1.7 6.2 4.3 7.8"/><path d="M14 19.8A6 6 0 0 0 18 12a6 6 0 0 0-3-5.2"/><path d="M12 10a2 2 0 0 0-2 2c0 2 1 3.5 2 4.5"/></svg>`;

const KEY_ICON_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 3-9.5 9.5M15.5 7.5l3 3M13 10l2 2"/></svg>`;

const SHIELD_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`;

const LOCK_ICON_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

const INFO_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`;

const SECURITY_STYLES = `
${COMMON_STYLES}

#reject-order {
  margin-top: 8px;
  background: #be123c;
  border-color: #fb7185;
  color: #fff;
}
#reject-order:hover { background: #9f1239; }

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

function orderSummary(preview: unknown, s: I18nDictionary["security"]) {
  if (!preview || typeof preview !== "object") return html`<p class="policy-desc">${s.seeJson}</p>`;
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
          symbol: instrument && typeof instrument === "object" ? Reflect.get(instrument, "symbol") as unknown : s.seeJson,
          instruction: Reflect.get(leg, "instruction") as unknown, quantity: Reflect.get(leg, "quantity") as unknown,
          type: record.orderType, price: record.price ?? record.stopPrice ?? s.seeJson, duration: record.duration,
        });
      }
    }
    if (Array.isArray(record.childOrderStrategies)) for (const child of record.childOrderStrategies as unknown[]) visit(child);
  }
  visit(order);
  const display = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : s.seeJson;
  return html`
    <div class="info-row"><span class="info-label">${s.accountLabel}</span><span class="info-value"><span class="tag-badge">${display(account)}</span></span></div>
    <div class="info-row" style="margin-top: 6px;"><span class="info-label">${s.actionLabel}</span><span class="info-value">${display(action)} · ${display(mode)}</span></div>
    <table class="order-table">
      <thead><tr><th>${s.symbolSide}</th><th>${s.quantity}</th><th>${s.priceType}</th><th>${s.duration}</th></tr></thead>
      <tbody>${legs.map(leg => html`<tr><td>${display(leg.symbol)} / ${display(leg.instruction)}</td><td>${display(leg.quantity)}</td><td>${display(leg.type)} / ${display(leg.price)}</td><td>${display(leg.duration)}</td></tr>`)}</tbody>
    </table>
  `;
}

export function renderSecurityPage(
  session: BrowserSession,
  credentials: { id: string; name: string }[],
  proposal?: { proposalId: string; status: string; preview: unknown; intentDigest: string; expiresAt: string; outcome: unknown },
  langCandidate?: SupportedLang
) {
  const lang = resolveLang(langCandidate);
  const dict = getDictionary(lang);
  const s = dict.security;
  const c = dict.common;

  // JSON script content is escaped for the HTML parser as well as the JS parser.
  const data = JSON.stringify({ proposalId: proposal?.proposalId }).replaceAll("<", "\\u003c");

  const policyListHtml = html`
    <div class="policy-list">
      <div class="policy-item">
        <div class="policy-icon blue">${raw(SHIELD_ICON_SVG)}</div>
        <div class="policy-content">
          <div class="policy-title">${s.keyProtectionTitle}</div>
          <div class="policy-desc">${s.keyProtectionDesc}</div>
        </div>
      </div>
      <div class="policy-item">
        <div class="policy-icon green">${raw(LOCK_ICON_SVG)}</div>
        <div class="policy-content">
          <div class="policy-title">${s.tamperProofTitle}</div>
          <div class="policy-desc">${s.tamperProofDesc}</div>
        </div>
      </div>
    </div>
  `;

  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="csrf" content="${session.csrf}">
  <title>${s.securityManagerTitle} · Schwab MCP</title>
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
        <span class="brand-title">${c.brandTitle}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${raw(renderLangDropdown(lang))}
        <a href="/dashboard" class="action-btn" style="text-decoration:none;padding:8px 14px;font-size:13px;width:auto;">&larr; ${c.backToDashboard}</a>
      </div>
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
        ${s.zeroKnowledgeNotice}
      </div>
      <h1 class="page-title">${s.orderApprovalTitle}</h1>
      <p class="page-subtitle">${s.orderApprovalSubtitle}</p>
      <div class="approval-layout">
        <div class="approval-cockpit">
          <div class="auth-card">
            <div class="info-row">
              <span class="info-label">${s.proposalStatus}</span>
              <span class="info-value">
                <span class="tag-badge ${proposal.status === "PENDING" ? "" : "green"}">${proposal.status}</span>
              </span>
            </div>
            <div class="info-row">
              <span class="info-label">${s.approvalDeadline}</span>
              <span class="info-value timestamp">${proposal.expiresAt}</span>
            </div>
            <div class="info-row column">
              <span class="info-label">${s.intentDigest}</span>
              <div class="uri-box">${proposal.intentDigest}</div>
            </div>
            <div class="card-divider"></div>
            ${orderSummary(proposal.preview, s)}
            <div class="card-divider"></div>
            ${policyListHtml}
            ${proposal.status === "PENDING" ? html`
              <div class="approval-sticky-bar">
                <button id="approve" class="pill-btn full-width primary-glow" data-operation="approve">
                  ${raw(FINGERPRINT_ICON_SVG)}
                  <span>${s.approveSubmitBtn}</span>
                </button>
                <button id="reject-order" class="pill-btn full-width">${s.rejectOrderBtn}</button>
              </div>
              <div class="action-hint">${s.approveHint}</div>
            ` : html`
              <div class="policy-title" style="margin: 12px 0 4px;">${s.executionOutcome}</div>
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
              <span class="terminal-title">${s.frozenTitle}</span>
              <span class="tag-badge">IMMUTABLE</span>
            </div>
            <div class="terminal-desc">${s.frozenDesc}</div>
            <pre class="code-preview">${JSON.stringify(proposal.preview, null, 2)}</pre>
            <div class="inspector-badge-row">
              <span class="tag-badge green">✓ Level 3 UV Required</span>
              <span class="tag-badge">RFC 7636 S256 Bound</span>
            </div>
          </div>
          <div class="auth-card" style="padding:12px 14px;background:var(--surface-container);border-color:var(--outline-variant);">
            <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--text-main);font-weight:600;">
              <span class="status-pulse-dot"></span>
              <span>${s.authenticatorReady}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:4px;">
              ${s.authenticatorMeta}
            </div>
          </div>
          <div class="terminal-hotkeys" style="margin-top:10px;font-size:11px;color:var(--text-muted);display:flex;justify-content:center;gap:10px;letter-spacing:0.04em;text-align:center;">
            <span>[ENTER] Passkey</span>
            <span>&bull;</span>
            <span>[ESC] ${c.cancel}</span>
            <span>&bull;</span>
            <span>ENCLAVE AIRGAP CERTIFIED</span>
          </div>
        </div>
      </div>
    ` : session.recovery ? html`
      <div class="terminal-prompt-tag">&gt;_ DISASTER RECOVERY PROTOCOL</div>
      <h1 class="page-title">${s.recoverTitle}</h1>
      <p class="page-subtitle">${s.recoverSubtitle}</p>
      <div class="auth-card">
        <div class="security-notice amber">
          ${raw(INFO_ICON_SVG)}
          <div>${s.recoverNotice}</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reset-confirmation">
            <span>${s.resetConfirmLabel}</span>
            <span class="form-label-hint">${s.resetConfirmHint}</span>
          </label>
          <div class="input-wrapper">
            <input id="reset-confirmation" class="text-input no-icon" autocomplete="off" placeholder="${s.resetConfirmPlaceholder}">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="credential-name">
            <span>${s.replacementKeyLabel}</span>
            <span class="form-label-hint">Passkey</span>
          </label>
          <div class="input-wrapper">
            <span class="input-icon">${raw(KEY_ICON_SVG)}</span>
            <input id="credential-name" class="text-input" maxlength="80" value="${s.replacementKeyDefault}">
          </div>
        </div>
        <button class="pill-btn full-width" data-operation="recover">
          ${raw(FINGERPRINT_ICON_SVG)}
          <span>${s.resetSubmitBtn}</span>
        </button>
      </div>
    ` : html`
      <div class="terminal-prompt-tag">&gt;_ CREDENTIAL SECURITY MANAGER</div>
      <h1 class="page-title">${s.securityManagerTitle}</h1>
      <p class="page-subtitle">${s.securityManagerSubtitle}</p>
      <div class="auth-card">
        ${credentials.length ? html`
          <div class="info-row">
            <span class="info-label">${s.registeredPasskeys}</span>
            <span class="info-value"><span class="tag-badge green">${formatString(s.activeCount, { n: credentials.length })}</span></span>
          </div>
          <ul class="credential-list">
            ${credentials.map(cr => html`
              <li class="credential-item">
                <div class="credential-info">
                  <span class="credential-name">${cr.name}</span>
                  <span class="credential-id mono">${cr.id.slice(0, 16)}…</span>
                </div>
                <div class="credential-actions">
                  <button class="action-btn" data-operation="rename" data-target="${cr.id}">${s.rename}</button>
                  ${credentials.length > 1 ? html`<button class="action-btn danger" data-operation="delete" data-target="${cr.id}">${s.delete}</button>` : ""}
                </div>
              </li>
            `)}
          </ul>
          <div class="form-group">
            <label class="form-label" for="credential-name"><span>${s.keyNameLabel}</span></label>
            <div class="input-wrapper"><input id="credential-name" class="text-input" value="${s.keyNameDefault}" maxlength="80"></div>
          </div>
          <button class="pill-btn secondary full-width" data-operation="add">
            ${raw(KEY_ICON_SVG)}
            <span>${s.addKeyBtn}</span>
          </button>
          <button id="register-add" class="pill-btn primary full-width" hidden style="margin-top:8px;">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>${s.addKeyBtn}</span>
          </button>
        ` : html`
          <div class="security-notice">
            ${raw(INFO_ICON_SVG)}
            <div>${s.noKeysNotice}</div>
          </div>
          <div class="form-group">
            <label class="form-label" for="credential-name"><span>${s.keyNameLabel}</span></label>
            <div class="input-wrapper"><input id="credential-name" class="text-input" value="${s.keyNameDefault}" maxlength="80"></div>
          </div>
          <button class="pill-btn primary full-width" data-operation="register">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>${s.registerFirstKeyBtn}</span>
          </button>
        `}
      </div>
    `}
    <p id="status" role="status" aria-live="polite"></p>
    <div class="action-hint">${s.sessionExpiryHint}</div>
    <div class="auth-footer">
      <a href="/security">${s.keyManagement}</a>
      <span class="footer-dot">·</span>
      <a href="/security/recover">${s.lostKeyRecovery}</a>
      <span class="footer-dot">·</span>
      <span>${c.brandTitle}</span>
    </div>
    <div class="security-disclaimer">
      ${s.disclaimer}
    </div>
    <script id="page-data" type="application/json">${raw(data)}</script>
    <script>
const i18n = ${raw(JSON.stringify(getSecurityClientI18n(lang)))};
${raw(SCRIPT)}
    </script>
  </main>
  ${raw(LANG_DROPDOWN_SCRIPT)}
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
    allowedAccountHashes?: string[];
    permissionLevel: PermissionLevel;
    advancedSecurity: boolean;
    redirectUri: string;
    status: ClientAuthorizationStatus;
    createdAt: number;
    expiresAt: number;
    digest: string;
  },
  credentials: { id: string; name: string }[],
  isOriginalSession: boolean,
  langCandidate?: SupportedLang
) {
  const lang = resolveLang(langCandidate);
  const dict = getDictionary(lang);
  const s = dict.security;
  const c = dict.common;

  const data = JSON.stringify({
    authorizationId: clientAuth.id,
    status: clientAuth.status,
    isOriginalSession,
    expiresAt: clientAuth.expiresAt,
  }).replaceAll("<", "\\u003c");

  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="csrf" content="${session.csrf}">
  <title>${s.clientAuthTitle}</title>
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
        <span class="brand-title">${c.brandTitle}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        ${raw(renderLangDropdown(lang))}
        <a href="/dashboard" class="action-btn" style="text-decoration:none;padding:8px 14px;font-size:13px;width:auto;">&larr; ${c.backToDashboard}</a>
      </div>
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

    <h1 class="page-title">${isOriginalSession && clientAuth.status === "PENDING" ? s.clientAuthAwaitingHeading : s.clientAuthHeading}</h1>
    <p class="page-subtitle">${isOriginalSession && clientAuth.status === "PENDING" ? s.clientAuthAwaitingSubtitle : s.clientAuthSubtitle}</p>

    <div class="auth-card" style="width:100%;max-width:580px;">
      <div class="info-row">
        <span class="info-label">${s.requestingClient}</span>
        <span class="info-value"><strong>${clientAuth.clientName}</strong> <span class="tag-badge mono" style="font-size:10px">${clientAuth.clientId}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">${s.permissionLevel}</span>
        <span class="info-value"><span class="tag-badge ${clientAuth.permissionLevel === "full_access" ? "green" : ""}">${clientAuth.permissionLevel === "full_access" ? s.fullAccessTag : s.readOnlyTag}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">Advanced Security</span>
        <span class="info-value">${clientAuth.advancedSecurity ? s.advancedSecurityOn : s.advancedSecurityOff}</span>
      </div>
      <div class="info-row">
        <span class="info-label">${s.redirectUri}</span>
        <span class="info-value mono" style="font-size:11px">${clientAuth.redirectUri}</span>
      </div>
      <div class="info-row column">
        <span class="info-label">${lang === "en-US" ? "Authorized accounts" : "授权账户"}</span>
        <span class="info-value mono" style="overflow-wrap:anywhere">${(clientAuth.allowedAccountHashes ?? []).join(", ") || (lang === "en-US" ? "Market data only" : "仅行情")}</span>
      </div>
      <div class="info-row">
        <span class="info-label">${c.status}</span>
        <span class="info-value"><span id="auth-status-badge" class="tag-badge ${clientAuth.status === "APPROVED" || clientAuth.status === "COMPLETED" ? "green" : ""}">${clientAuth.status}</span></span>
      </div>
      <div class="info-row">
        <span class="info-label">${s.expiresAt}</span>
        <span class="info-value timestamp">${new Date(clientAuth.expiresAt).toLocaleTimeString()}</span>
      </div>
      <div class="info-row">
        <span class="info-label">${s.digest}</span>
        <div class="uri-box mono">${clientAuth.digest}</div>
      </div>

      <div class="card-divider"></div>

      <div id="status" class="action-hint" role="status" aria-live="polite">${isOriginalSession && clientAuth.status === "PENDING" ? s.statusAwaiting : ""}</div>

      ${clientAuth.status === "PENDING" ? html`
        <div id="action-buttons-container" style="display:flex;flex-direction:column;gap:12px;margin-top:14px;">
          <div class="form-group" style="${credentials.length ? "display:none;" : ""}">
            <label class="form-label" for="credential-name"><span>${s.newPasskeyName}</span></label>
            <div class="input-wrapper"><input id="credential-name" class="text-input" value="${s.keyNameDefault}" maxlength="80"></div>
          </div>
          <button id="stage-auth-btn" class="pill-btn primary full-width" data-action="stage-client-auth">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>${credentials.length ? s.approveRequestBtn : s.registerAndApproveBtn}</span>
          </button>
          <button id="submit-auth-btn" class="pill-btn primary full-width" style="display:none;background:var(--primary);color:#003824;">
            ${raw(FINGERPRINT_ICON_SVG)}
            <span>${s.invokeHardwareBtn}</span>
          </button>
          <button id="cancel-auth-btn" class="pill-btn danger full-width" data-action="cancel-client-auth">${s.cancelRequestBtn}</button>
        </div>
      ` : clientAuth.status === "APPROVED" ? html`
        <div class="security-notice green" style="margin-top:14px;">
          &bull; ${s.approvedNotice}
        </div>
      ` : html`
        <div class="security-notice" style="margin-top:14px;">
          &bull; ${c.status}: ${clientAuth.status}
        </div>
      `}
    </div>

    <div class="auth-footer" style="margin-top:20px;">
      <a href="/security">${s.keyManagement}</a>
      <span class="footer-dot">·</span>
      <a href="/dashboard">${c.backToDashboard}</a>
    </div>

    <script id="page-data" type="application/json">${raw(data)}</script>
    <script>
const i18n = ${raw(JSON.stringify(getSecurityClientI18n(lang)))};
${raw(SCRIPT)}
    </script>
  </main>
  ${raw(LANG_DROPDOWN_SCRIPT)}
  ${PWA_SERVICE_WORKER_SCRIPT}
</body>
</html>`;
}
