import { html, raw } from "hono/html";
import type { BrowserSession } from "./security-store";

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
  if (!r.ok) throw new Error(v.error?.message || '验证失败，请刷新页面重试。');
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
  status.textContent = '请在系统提示中完成 Passkey 验证…';
  try {
    const name = document.querySelector('#credential-name')?.value || 'Passkey';
    const v = await api('options', {operation,target,name,proposalId:data.proposalId,resetConfirmation:document.querySelector('#reset-confirmation')?.value});
    const response = await ceremony(v);
    const result = await api('verify', {challengeId:v.challengeId,response});
    if (result.redirectTo) { location.assign(result.redirectTo); return; }
    if (result.recovered) { location.assign('/security'); return; }
    if (result.registrationTicket) {
      status.textContent = '已有 Passkey 验证成功。点击“注册新 Passkey”继续。';
      const button = document.querySelector('#register-add');
      button.hidden = false;
      button.dataset.ticket = result.registrationTicket;
      return;
    }
    if (operation === 'approve') {
      status.textContent = JSON.stringify(result, null, 2);
      document.querySelector('#approve').hidden = true;
    } else location.reload();
  } catch(e) { status.textContent = e.name === 'NotAllowedError' ? '操作已取消或超时，订单保持未批准。' : e.message; }
  finally { busy = false; enabledButtons.forEach(b => b.disabled = false); }
}
document.querySelectorAll('[data-operation]').forEach(b => b.addEventListener('click', () => act(b.dataset.operation, b.dataset.target)));
document.querySelector('#register-add')?.addEventListener('click', async e => {
  if (busy) return;
  busy = true;
  try {
    const v = await api('add-options', {ticket:e.currentTarget.dataset.ticket,name:document.querySelector('#credential-name').value});
    const response = await ceremony(v);
    await api('add-verify', {challengeId:v.challengeId,response});
    location.reload();
  } catch(e) { status.textContent = e.message; } finally {busy = false;}
});
if (!window.PublicKeyCredential || !navigator.credentials) {
  status.textContent = '此浏览器不支持 WebAuthn。请在支持 Passkey 的外部浏览器中打开此链接；订单保持未批准。';
  document.querySelectorAll('button').forEach(b => b.disabled = true);
}
`;
const STYLE = `body{font:16px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;padding:24px;color:#172230;background:#f5f7fa}main{overflow-wrap:anywhere;max-width:850px;margin:auto;background:white;padding:24px;border:1px solid #dce2ea;border-radius:16px}button,input{font:inherit;padding:10px;margin:6px 0;max-width:100%;box-sizing:border-box}button{cursor:pointer;border-radius:7px;background:#123d61;color:white;border:0}button:disabled{opacity:.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;background:#f3f5f7}a{color:#13597f}li{overflow-wrap:anywhere;margin:12px 0}label{display:block}#status{white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{text-align:left;border:1px solid #dce2ea;padding:8px;overflow-wrap:anywhere}@media(max-width:500px){body{padding:8px}main{padding:16px}button{width:100%}}`;

function orderSummary(preview: unknown) {
  if (!preview || typeof preview !== "object") return html`<p>订单预览不可用。</p>`;
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
  return html`<p>账户 hash：${display(account)}<br>操作：${display(action)} · 执行方式：${display(mode)}</p><table><thead><tr><th>标的 / 方向</th><th>数量</th><th>价格类型 / 价格</th><th>有效期</th></tr></thead><tbody>${legs.map(leg => html`<tr><td>${display(leg.symbol)} / ${display(leg.instruction)}</td><td>${display(leg.quantity)}</td><td>${display(leg.type)} / ${display(leg.price)}</td><td>${display(leg.duration)}</td></tr>`)}</tbody></table>`;
}

export function renderSecurityPage(session: BrowserSession, credentials: { id: string; name: string }[], proposal?: { proposalId: string; status: string; preview: unknown; intentDigest: string; expiresAt: string; outcome: unknown }) {
  // JSON script content is escaped for the HTML parser as well as the JS parser.
  const data = JSON.stringify({ proposalId: proposal?.proposalId }).replaceAll("<", "\\u003c");
  return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="csrf" content="${session.csrf}"><title>Advanced Security · Schwab MCP</title><style>${raw(STYLE)}</style></head><body><main>
  <h1>${proposal ? "订单 Passkey 批准" : "Advanced Security"}</h1>
  <p>设置按客户端生效。其他未开启的完整访问客户端仍沿用对话确认与 session 直下策略。</p>
  ${proposal ? html`<p>状态：${proposal.status} · 批准截止：${proposal.expiresAt}</p><p>摘要：${proposal.intentDigest}</p>${orderSummary(proposal.preview)}<h2>冻结订单完整预览</h2><p>请核对账户标识、每条订单腿的买卖方向及数量、价格类型、有效期；延迟订单同时核对条件和截止时间。下列完整 JSON 是本次批准并执行的内容。</p><pre>${JSON.stringify(proposal.preview, null, 2)}</pre>${proposal.status === "PENDING" ? html`<button id="approve" data-operation="approve">批准并提交</button><p>验证成功后服务器立即提交即时订单或激活延迟任务。无对话确认降级。</p>` : html`<pre>${JSON.stringify(proposal.outcome, null, 2)}</pre>`}` : session.recovery ? html`<h2>恢复 Passkey</h2><p>本流程已独立完成 GitHub owner OAuth。GitHub 账户是凭据恢复的信任入口。新凭据注册成功前不删除旧凭据。完成后旧凭据、浏览器会话、challenge 和待批准增强提案全部失效；已激活延迟任务保留，Advanced Security 保持开启。</p><label>输入“重置全部 Passkey”<input id="reset-confirmation" autocomplete="off"></label><label>替代凭据名称<input id="credential-name" maxlength="80" value="替代 Passkey"></label><button data-operation="recover">重置全部 Passkey 并注册替代凭据</button>` : session.pending ? html`<h2>确认客户端安全设置</h2><p>此客户端将${session.pending.advancedSecurity ? "开启" : "关闭"} Advanced Security。${credentials.length ? "需要已有 Passkey 验证。" : "请先注册首个 Passkey。"}</p><label>凭据名称<input id="credential-name" maxlength="80" value="我的 Passkey"></label><button data-operation="${credentials.length ? "authorize" : "register"}">${credentials.length ? "使用 Passkey 确认设置并授权" : "注册 Passkey 并完成授权"}</button>` : html`<h2>Owner Passkey</h2><ul>${credentials.map(c => html`<li>${c.name}<br><small>${c.id}</small><br><button data-operation="rename" data-target="${c.id}">验证并重命名</button> <button data-operation="delete" data-target="${c.id}" ${credentials.length <= 1 ? "disabled" : ""}>验证并删除</button></li>`)}</ul><label>新增或修改的凭据名称<input id="credential-name" maxlength="80" value="我的 Passkey"></label><button data-operation="${credentials.length ? "add" : "register"}">${credentials.length ? "验证已有 Passkey 后添加" : "注册首个 Passkey"}</button><button id="register-add" hidden>注册新 Passkey</button>`}
  <p id="status" role="status" aria-live="polite"></p><p>浏览器会话 15 分钟有效；验证 challenge 最长 2 分钟，订单批准提案 5 分钟有效。</p><p><a href="/security">凭据管理</a> · <a href="/security/recover">全部 Passkey 丢失：通过独立 GitHub OAuth 恢复</a></p>
  <p>本功能防御 MCP 令牌或客户端失陷，不承诺抵抗 Worker、批准设备或 GitHub 恢复账户被控制。</p>
  <script id="page-data" type="application/json">${raw(data)}</script><script>${raw(SCRIPT)}</script></main></body></html>`;
}
