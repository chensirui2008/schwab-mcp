import { html, raw } from "hono/html";

export const FAVICON_LINK = raw('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');

export interface AuthorizePageProps {
  clientName: string;
  redirectUri: string;
  state: string;
  advancedSecurity?: boolean;
}

// Finish the same-origin form navigation before starting GitHub OAuth. A 302
// directly from the form POST remains subject to the form-action 'self' CSP.
export function renderGitHubContinuePage(url: string) {
  return html`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FAVICON_LINK}<title>继续 GitHub 身份验证 · Schwab MCP</title><style>body{margin:0;min-height:100vh;background:#090d16;color:#f8fafc;font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}a{color:#38bdf8;text-underline-offset:4px}p{font-size:14px;color:#94a3b8;margin:8px 0}</style></head><body><p>&gt;_ 正在跳转至 GitHub 身份验证…</p><p><a id="github-continue" href="${url}">若未自动跳转，点击继续验证</a></p><script>location.replace(document.getElementById('github-continue').href);</script></body></html>`;
}

export const BACKGROUND_SVG = `<svg class="bg-telemetry" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="radial-glow" cx="50%" cy="30%" r="65%">
      <stop offset="0%" stop-color="#4edea3" stop-opacity="0.08"/>
      <stop offset="50%" stop-color="#7bd0ff" stop-opacity="0.03"/>
      <stop offset="100%" stop-color="#070b12" stop-opacity="0"/>
    </radialGradient>
    <pattern id="terminal-grid" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#3c4a42" stroke-width="0.75" stroke-opacity="0.35"/>
      <circle cx="24" cy="24" r="0.75" fill="#4edea3" fill-opacity="0.25"/>
    </pattern>
  </defs>
  <rect width="1440" height="900" fill="#070b12"/>
  <rect width="1440" height="900" fill="url(#terminal-grid)"/>
  <rect width="1440" height="900" fill="url(#radial-glow)"/>
</svg>`;

export const BRAND_LOGO_SVG = `<svg class="brand-logo" width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="logo-left" x1="18" y1="4.5" x2="5.5" y2="27.5" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#38bdf8" />
      <stop offset="100%" stop-color="#0284c7" />
    </linearGradient>
    <linearGradient id="logo-right" x1="18" y1="4.5" x2="30.5" y2="27.5" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0284c7" />
      <stop offset="100%" stop-color="#6366f1" />
    </linearGradient>
    <linearGradient id="logo-bottom" x1="5.5" y1="27.5" x2="30.5" y2="27.5" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#10b981" />
      <stop offset="50%" stop-color="#f59e0b" />
      <stop offset="100%" stop-color="#f43f5e" />
    </linearGradient>
    <filter id="logo-glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="2" flood-color="#10b981" flood-opacity="0.35"/>
    </filter>
  </defs>
  <g filter="url(#logo-glow)">
    <path d="M18 4.5L5.5 27.5L18 20.5Z" fill="url(#logo-left)" />
    <path d="M18 4.5L30.5 27.5L18 20.5Z" fill="url(#logo-right)" />
    <path d="M5.5 27.5L30.5 27.5L18 20.5Z" fill="url(#logo-bottom)" />
  </g>
</svg>`;

export const COMMON_STYLES = `
  :root {
    color-scheme: dark;
    --bg: #070b12;
    --card-bg: #0f131c;
    --card-border: #1e2d42;
    --card-border-focus: #4edea3;
    --card-shadow: 0 4px 24px -2px rgba(0, 0, 0, 0.6), 0 2px 8px -1px rgba(0, 0, 0, 0.4);

    --text-main: #dfe2ef;
    --text-sub: #86948a;
    --text-muted: #5c6b61;

    --panel-bg: #141a24;
    --panel-border: #1e2d42;
    --divider: #1e2d42;

    --btn-primary-bg: #10b981;
    --btn-primary-hover: #4edea3;
    --btn-primary-active: #003824;
    --btn-primary-text: #003824;

    --brand-cyan: #7bd0ff;
    --brand-cyan-soft: rgba(123, 208, 255, 0.08);
    --brand-cyan-border: rgba(123, 208, 255, 0.25);

    --brand-emerald: #4edea3;
    --brand-emerald-soft: rgba(78, 222, 163, 0.1);
    --brand-emerald-border: rgba(78, 222, 163, 0.25);

    --brand-amber: #ffb95f;
    --brand-amber-soft: rgba(255, 185, 95, 0.1);
    --brand-amber-border: rgba(255, 185, 95, 0.25);

    --brand-rose: #ffb4ab;

    --code-bg: #060a10;
    --code-border: #1e2d42;
    --code-text: #7bd0ff;
    --radius: 8px;
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  body {
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background-color: var(--bg);
    background-image:
      linear-gradient(to right, rgba(60, 74, 66, 0.1) 1px, transparent 1px),
      linear-gradient(to bottom, rgba(60, 74, 66, 0.1) 1px, transparent 1px);
    background-size: 24px 24px;
    color: var(--text-main);
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    line-height: 1.5;
    position: relative;
    overflow-x: hidden;
  }

  .bg-telemetry {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 0;
    opacity: 0.85;
  }

  .main-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 540px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .brand-header {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 12px;
  }

  .brand-logo {
    flex-shrink: 0;
  }

  .brand-title {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--text-main);
    font-family: ui-monospace, "SF Mono", "JetBrains Mono", monospace;
  }

  .terminal-prompt-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--brand-emerald);
    background: var(--brand-emerald-soft);
    border: 1px solid var(--brand-emerald-border);
    padding: 3px 8px;
    border-radius: 9999px;
    margin-bottom: 14px;
    letter-spacing: 0.05em;
  }

  .terminal-prompt-tag::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--brand-emerald);
    box-shadow: 0 0 6px var(--brand-emerald);
  }

  .page-title {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.015em;
    color: var(--text-main);
    margin-bottom: 6px;
    text-align: center;
  }

  .page-subtitle {
    font-size: 13px;
    color: var(--text-sub);
    margin-bottom: 22px;
    text-align: center;
    line-height: 1.45;
  }

  .auth-card {
    width: 100%;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: var(--radius);
    box-shadow: var(--card-shadow);
    padding: 22px 24px;
    text-align: left;
  }

  .info-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }

  .info-row.column {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin-top: 12px;
  }

  .info-label {
    color: var(--text-muted);
    font-weight: 500;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .info-value {
    color: var(--text-main);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .tag-badge {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 4px;
    background: var(--brand-cyan-soft);
    color: var(--brand-cyan);
    border: 1px solid var(--brand-cyan-border);
    letter-spacing: 0.02em;
  }

  .tag-badge.green {
    background: var(--brand-emerald-soft);
    color: var(--brand-emerald);
    border-color: var(--brand-emerald-border);
  }

  .tag-badge.amber {
    background: var(--brand-amber-soft);
    color: var(--brand-amber);
    border-color: var(--brand-amber-border);
  }

  .uri-box {
    width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    color: var(--code-text);
    word-break: break-all;
    background: var(--code-bg);
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid var(--code-border);
    line-height: 1.45;
  }

  .card-divider {
    height: 1px;
    background: var(--divider);
    margin: 16px 0;
  }

  .policy-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .policy-item {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .policy-icon {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }

  .policy-icon.blue {
    background: var(--brand-cyan-soft);
    color: var(--brand-cyan);
    border: 1px solid var(--brand-cyan-border);
  }

  .policy-icon.green {
    background: var(--brand-emerald-soft);
    color: var(--brand-emerald);
    border: 1px solid var(--brand-emerald-border);
  }

  .policy-icon svg {
    width: 15px;
    height: 15px;
  }

  .policy-content {
    flex: 1;
    font-size: 12.5px;
    line-height: 1.5;
  }

  .policy-title {
    font-weight: 600;
    color: var(--text-main);
    margin-bottom: 2px;
  }

  .policy-desc {
    color: var(--text-sub);
    font-size: 12px;
    line-height: 1.45;
  }

  .security-notice {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    padding: 10px 12px;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    font-size: 12px;
    color: var(--text-sub);
    margin-top: 16px;
    line-height: 1.45;
  }

  .security-notice.success {
    background: var(--brand-emerald-soft);
    border-color: var(--brand-emerald-border);
    color: var(--text-main);
  }

  .security-notice.amber {
    background: var(--brand-amber-soft);
    border-color: var(--brand-amber-border);
    color: #fde68a;
  }

  .security-notice svg {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--brand-amber);
  }

  .security-notice.success svg {
    color: var(--brand-emerald);
  }

  .security-notice strong {
    color: var(--text-main);
    font-weight: 600;
  }

  .action-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    margin-top: 20px;
  }

  .permission-options {
    border: 0;
    margin-top: 16px;
  }

  .permission-options legend {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .permission-option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    padding: 12px 14px;
    margin-top: 8px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    background: var(--panel-bg);
    cursor: pointer;
    font-size: 13px;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }

  .permission-option:hover {
    border-color: #334155;
    background: #0d1527;
  }

  .permission-option:has(input:checked) {
    border-color: var(--brand-cyan);
    background: rgba(56, 189, 248, 0.04);
    box-shadow: 0 0 0 1px var(--brand-cyan-border);
  }

  .permission-option:focus-within {
    outline: 2px solid var(--brand-cyan);
    outline-offset: 2px;
  }

  .permission-option input {
    margin-top: 3px;
    accent-color: var(--brand-cyan);
    width: 16px;
    height: 16px;
  }

  .pill-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--btn-primary-bg);
    color: var(--btn-primary-text);
    border: none;
    border-radius: 6px;
    padding: 13px 28px;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
    box-shadow: 0 0 12px var(--brand-emerald-soft);
    transition: transform 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
    text-decoration: none;
    width: 100%;
    min-height: 48px;
    letter-spacing: 0.02em;
  }

  .pill-btn:hover {
    background: var(--btn-primary-hover);
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.4);
  }

  .pill-btn:active {
    background: var(--btn-primary-active);
    transform: translateY(1px);
  }

  .pill-btn svg {
    width: 17px;
    height: 17px;
    fill: currentColor;
    flex-shrink: 0;
  }

  .pill-btn.secondary {
    background: var(--panel-bg);
    color: var(--text-main);
    border: 1px solid var(--card-border);
    box-shadow: none;
  }

  .pill-btn.secondary:hover {
    background: #1e293b;
    border-color: #334155;
    color: #ffffff;
  }

  .action-hint {
    margin-top: 10px;
    font-size: 11.5px;
    color: var(--text-muted);
    text-align: center;
  }

  .auth-footer {
    margin-top: 24px;
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .footer-dot {
    opacity: 0.4;
  }

  /* Mobile-first touch adaptations */
  @media (max-width: 640px) {
    body {
      padding: 16px 12px;
    }
    .auth-card {
      padding: 18px 16px;
    }
    .permission-option {
      padding: 14px 12px;
      min-height: 48px;
    }
    .pill-btn {
      min-height: 52px;
      font-size: 14px;
    }
  }
`;

export function renderAuthorizePage(props: AuthorizePageProps) {
  return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>客户端授权 · Schwab MCP</title>
  ${FAVICON_LINK}
  <style>${COMMON_STYLES}</style>
  <div class="main-wrapper">
    <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
      <div class="telemetry-node">
        <span class="status-pulse-dot"></span>
        <span>&gt;_ SCHWAB_MCP // OAUTH_CONSENT_GATEWAY</span>
      </div>
      <div class="telemetry-chips">
        <span class="tag-badge green">&bull; RFC 7636 S256</span>
        <span class="tag-badge">ENCLAVE_ISOLATED</span>
      </div>
    </div>
    <div class="brand-header">
      ${raw(BRAND_LOGO_SVG)}
      <span class="brand-title">SCHWAB MCP</span>
    </div>

    <div class="terminal-prompt-tag">&gt;_ OAUTH 2.1 INCOMING CLIENT CHALLENGE</div>

    <h1 class="page-title">允许连接 Schwab MCP？</h1>
    <p class="page-subtitle">客户端正在申请接入您的个人 Charles Schwab MCP 实例</p>

    <div class="auth-card">
      <div class="info-row">
        <span class="info-label">客户端标识</span>
        <span class="info-value">
          ${props.clientName}
          <span class="tag-badge">OAuth 2.1</span>
          <span class="tag-badge green">RFC 7636 S256</span>
        </span>
      </div>
      <div class="info-row column">
        <span class="info-label">重定向回调地址</span>
        <div class="uri-box">${props.redirectUri}</div>
      </div>

      <div class="card-divider"></div>

      <div class="policy-list">
        <div class="policy-item">
          <div class="policy-icon blue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="20" x2="18" y2="10"/>
              <line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/>
            </svg>
          </div>
          <div class="policy-content">
            <div class="policy-title">账户与行情读取</div>
            <div class="policy-desc">允许查询实时报价、历史 K 线、期权链、账户资产与交易历史流水。</div>
          </div>
        </div>
        <div class="policy-item">
          <div class="policy-icon green">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              <path d="m9 12 2 2 4-4"/>
            </svg>
          </div>
          <div class="policy-content">
            <div class="policy-title">受控交易工具与安全防护</div>
            <div class="policy-desc">仅完整访问客户端可看到交易工具。真实交易仍受部署总开关、明确用户指令以及二次确认约束；保留显式开启的 session 直下模式和撤单例外。</div>
          </div>
        </div>
      </div>

      <fieldset class="permission-options">
        <legend>选择此客户端的权限等级</legend>
        <label class="permission-option">
          <input type="radio" name="permissionLevel" value="read_only" form="authorize-form" required ${props.advancedSecurity ? "" : "checked"}>
          <span>
            <span class="policy-title">只读 · Read only</span><br>
            <span class="policy-desc">允许读取账户与行情；不向模型暴露交易工具。</span>
          </span>
        </label>
        <label class="permission-option">
          <input type="radio" name="permissionLevel" value="full_access" form="authorize-form" required ${props.advancedSecurity ? "checked" : ""}>
          <span>
            <span class="policy-title">完整访问 · Full access</span><br>
            <span class="policy-desc">向模型暴露所有工具；保留现有二次确认、session 直下模式和撤单规则。</span>
          </span>
        </label>
      </fieldset>

      <label class="permission-option" id="advanced-option" style="margin-top: 10px;">
        <input type="checkbox" name="advancedSecurity" form="authorize-form" ${props.advancedSecurity ? "checked" : ""}>
        <span>
          <span class="policy-title">Advanced Security · Passkey 订单批准</span><br>
          <span class="policy-desc">仅完整访问可开启。每笔建单、改单及延迟任务创建和修改均需浏览器 Passkey 批准；禁止 session 直下。设置按客户端生效。</span>
        </span>
      </label>

      <script>
        const advanced = document.querySelector('[name="advancedSecurity"]');
        function updateAdvanced() { advanced.disabled = !document.querySelector('[name="permissionLevel"][value="full_access"]').checked; }
        document.querySelectorAll('[name="permissionLevel"]').forEach(input => input.addEventListener('change', updateAdvanced));
        updateAdvanced();
      </script>

      <div class="security-notice amber">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="16" x2="12" y2="12"/>
          <line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>
        <div>
          点击继续将跳转至 <strong>GitHub</strong> 验证您的拥有者身份（匹配预配置的数字 ID 白名单）。
        </div>
      </div>
    </div>

    <form id="authorize-form" class="action-form" method="post" action="/authorize/approve">
      <input type="hidden" name="state" value="${props.state}">
      <button type="submit" class="pill-btn">
        <svg viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
        </svg>
        <span>继续 GitHub 身份验证并授权</span>
      </button>
    </form>

    <div class="auth-footer">
      <span>如非本人操作请直接关闭页面</span>
      <span class="footer-dot">·</span>
      <span>Charles Schwab MCP</span>
    </div>
  </div>
</body>
</html>`;
}

export function renderSchwabConnectedPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schwab 已连接 · Schwab MCP</title>
  ${FAVICON_LINK}
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${BACKGROUND_SVG}

  <div class="main-wrapper">
    <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
      <div class="telemetry-node">
        <span class="status-pulse-dot"></span>
        <span>&gt;_ SCHWAB_MCP // BROKERAGE_HANDSHAKE_PASSED</span>
      </div>
      <div class="telemetry-chips">
        <span class="tag-badge green">&bull; ONLINE</span>
        <span class="tag-badge">VAULT_ENCRYPTED</span>
      </div>
    </div>
    <div class="brand-header">
      ${BRAND_LOGO_SVG}
      <span class="brand-title">SCHWAB MCP</span>
    </div>

    <div class="terminal-prompt-tag">&gt;_ BROKERAGE CONNECTION VERIFIED</div>

    <h1 class="page-title">Schwab 账户已成功连接</h1>
    <p class="page-subtitle">OAuth 凭据已安全持久化至 SQLite 隔离存储 · 守护进程运行中</p>

    <div class="auth-card">
      <div class="info-row">
        <span class="info-label">连接状态</span>
        <span class="info-value">
          已授权绑定
          <span class="tag-badge green">正常 ONLINE</span>
        </span>
      </div>
      <div class="card-divider"></div>
      <div class="info-row">
        <span class="info-label">安全防护</span>
        <span class="info-value">
          SchwabVault DO 加密持久化
          <span class="tag-badge">ENCLAVE SEALED</span>
        </span>
      </div>

      <div class="security-notice success">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <div>
          您现在可以安全关闭此浏览器窗口，并返回您的 MCP 客户端继续使用。
        </div>
      </div>
    </div>

    <div class="action-form">
      <button type="button" class="pill-btn" onclick="window.close()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>完成并关闭页面</span>
      </button>
      <div class="action-hint">若浏览器限制脚本自动关闭，请直接关闭当前标签页</div>
    </div>

    <div class="auth-footer">
      <span>Charles Schwab MCP · 个人专用高安全实例</span>
    </div>
  </div>
</body>
</html>`;
}
