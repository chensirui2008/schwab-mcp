import { html } from "hono/html";

export interface AuthorizePageProps {
  clientName: string;
  redirectUri: string;
  state: string;
}

const COMMON_STYLES = `
  :root {
    --bg: #f8fafc;
    --card-bg: #ffffff;
    --card-border: #e2e8f0;
    --card-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);

    --text-main: #0f172a;
    --text-sub: #475569;
    --text-muted: #64748b;

    --panel-bg: #f8fafc;
    --panel-border: #e2e8f0;
    --divider: #edf2f7;

    --primary-btn: #0f172a;
    --primary-btn-hover: #1e293b;
    --primary-btn-active: #334155;
    --primary-btn-text: #ffffff;

    --brand-blue: #0284c7;
    --brand-blue-soft: #f0f9ff;
    --brand-blue-border: #bae6fd;

    --accent-green: #059669;
    --accent-green-soft: #ecfdf5;
    --accent-green-border: #a7f3d0;

    --code-bg: #f1f5f9;
    --code-border: #e2e8f0;
    --code-text: #0369a1;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #090d16;
      --card-bg: #111726;
      --card-border: #1e293b;
      --card-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.2);

      --text-main: #f8fafc;
      --text-sub: #94a3b8;
      --text-muted: #64748b;

      --panel-bg: #0b111e;
      --panel-border: #1e293b;
      --divider: #1e293b;

      --primary-btn: #f8fafc;
      --primary-btn-hover: #e2e8f0;
      --primary-btn-active: #cbd5e1;
      --primary-btn-text: #0f172a;

      --brand-blue: #38bdf8;
      --brand-blue-soft: rgba(56, 189, 248, 0.08);
      --brand-blue-border: rgba(56, 189, 248, 0.2);

      --accent-green: #34d399;
      --accent-green-soft: rgba(52, 211, 153, 0.08);
      --accent-green-border: rgba(52, 211, 153, 0.2);

      --code-bg: #0a0e1a;
      --code-border: #1e293b;
      --code-text: #7dd3fc;
    }
  }

  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background-color: var(--bg);
    color: var(--text-main);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    line-height: 1.5;
  }

  .auth-card {
    width: 100%;
    max-width: 480px;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    box-shadow: var(--card-shadow);
    padding: 32px 28px 24px;
  }

  .connector-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 22px;
  }

  .node-icon {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--panel-border);
    background: var(--panel-bg);
    flex-shrink: 0;
  }

  .client-node {
    color: #ea580c;
    background: #fff7ed;
    border-color: #ffedd5;
  }

  @media (prefers-color-scheme: dark) {
    .client-node {
      color: #fb923c;
      background: rgba(251, 146, 60, 0.1);
      border-color: rgba(251, 146, 60, 0.2);
    }
  }

  .service-node {
    color: #0284c7;
    background: #f0f9ff;
    border-color: #e0f2fe;
  }

  @media (prefers-color-scheme: dark) {
    .service-node {
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.2);
    }
  }

  .success-node {
    color: #059669;
    background: #ecfdf5;
    border-color: #a7f3d0;
  }

  @media (prefers-color-scheme: dark) {
    .success-node {
      color: #34d399;
      background: rgba(52, 211, 153, 0.1);
      border-color: rgba(52, 211, 153, 0.2);
    }
  }

  .connector-wire {
    display: flex;
    align-items: center;
    position: relative;
    width: 56px;
    justify-content: center;
  }

  .connector-line {
    position: absolute;
    top: 50%;
    left: 0;
    right: 0;
    height: 1px;
    background: var(--card-border);
    z-index: 1;
  }

  .lock-pill {
    position: relative;
    z-index: 2;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    color: var(--text-muted);
    border-radius: 20px;
    padding: 2px 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .title-group {
    text-align: center;
    margin-bottom: 24px;
  }

  .title-group h1 {
    font-size: 20px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--text-main);
    margin-bottom: 6px;
  }

  .title-group p {
    font-size: 13.5px;
    color: var(--text-sub);
  }

  .info-panel {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 18px;
  }

  .info-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }

  .info-row:not(:last-child) {
    padding-bottom: 10px;
    margin-bottom: 10px;
    border-bottom: 1px solid var(--divider);
  }

  .info-row.column {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .info-label {
    color: var(--text-muted);
    font-weight: 500;
    flex-shrink: 0;
    font-size: 12.5px;
  }

  .info-value {
    color: var(--text-main);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tag-badge {
    font-size: 11px;
    font-weight: 500;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--brand-blue-soft);
    color: var(--brand-blue);
    border: 1px solid var(--brand-blue-border);
  }

  .tag-badge.green {
    background: var(--accent-green-soft);
    color: var(--accent-green);
    border-color: var(--accent-green-border);
  }

  .uri-box {
    width: 100%;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 11.5px;
    color: var(--code-text);
    word-break: break-all;
    background: var(--code-bg);
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--code-border);
    line-height: 1.4;
  }

  .policy-card {
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    padding: 14px 16px;
    margin-bottom: 18px;
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
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 1px;
  }

  .policy-icon.blue {
    background: var(--brand-blue-soft);
    color: var(--brand-blue);
    border: 1px solid var(--brand-blue-border);
  }

  .policy-icon.green {
    background: var(--accent-green-soft);
    color: var(--accent-green);
    border: 1px solid var(--accent-green-border);
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
  }

  .policy-divider {
    height: 1px;
    background: var(--divider);
    margin: 0;
  }

  .security-notice {
    background: var(--panel-bg);
    border: 1px solid var(--panel-border);
    border-radius: 10px;
    padding: 10px 12px;
    display: flex;
    gap: 10px;
    align-items: center;
    font-size: 12px;
    color: var(--text-sub);
    margin-bottom: 20px;
    line-height: 1.4;
  }

  .security-notice svg {
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .security-notice strong {
    color: var(--text-main);
    font-weight: 600;
  }

  .action-form {
    margin-bottom: 16px;
  }

  .submit-btn {
    width: 100%;
    height: 44px;
    border: none;
    border-radius: 10px;
    background: var(--primary-btn);
    color: var(--primary-btn-text);
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    cursor: pointer;
    transition: background-color 0.15s ease, opacity 0.15s ease;
    font-family: inherit;
  }

  .submit-btn:hover {
    background: var(--primary-btn-hover);
  }

  .submit-btn:active {
    background: var(--primary-btn-active);
  }

  .submit-btn svg {
    width: 18px;
    height: 18px;
    fill: currentColor;
  }

  .auth-footer {
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .footer-dot {
    opacity: 0.5;
  }
`;

export function renderAuthorizePage(props: AuthorizePageProps) {
  return html`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schwab MCP 授权</title>
  <style>${COMMON_STYLES}</style>
</head>
<body>
  <div class="auth-card">
    <div class="connector-header">
      <div class="node-icon client-node" title="客户端">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
      </div>

      <div class="connector-wire">
        <div class="connector-line"></div>
        <div class="lock-pill">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
        </div>
      </div>

      <div class="node-icon service-node" title="Schwab MCP">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="m9 12 2 2 4-4"/>
        </svg>
      </div>
    </div>

    <div class="title-group">
      <h1>允许连接 Schwab MCP？</h1>
      <p>客户端正在申请接入您的个人 Charles Schwab MCP 实例</p>
    </div>

    <div class="info-panel">
      <div class="info-row">
        <span class="info-label">客户端</span>
        <span class="info-value">
          ${props.clientName}
          <span class="tag-badge">OAuth 2.1</span>
        </span>
      </div>
      <div class="info-row column">
        <span class="info-label">回调地址</span>
        <div class="uri-box">${props.redirectUri}</div>
      </div>
    </div>

    <div class="policy-card">
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
      <div class="policy-divider"></div>
      <div class="policy-item">
        <div class="policy-icon green">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          </svg>
        </div>
        <div class="policy-content">
          <div class="policy-title">受控交易工具与安全防护</div>
          <div class="policy-desc">通过身份校验的客户端将能读取账户数据并看到交易工具。真实交易仍受部署总开关、明确用户指令以及逐单确认或 session 能力约束。</div>
        </div>
      </div>
    </div>

    <div class="security-notice">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <div>
        点击继续将跳转至 <strong>GitHub</strong> 验证您的拥有者身份（匹配预配置的数字 ID 白名单）。
      </div>
    </div>

    <form class="action-form" method="post" action="/authorize/approve">
      <input type="hidden" name="state" value="${props.state}">
      <button type="submit" class="submit-btn">
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
  <style>${COMMON_STYLES}</style>
</head>
<body>
  <div class="auth-card">
    <div class="connector-header">
      <div class="node-icon success-node" title="连接成功">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </div>
    </div>

    <div class="title-group">
      <h1>Schwab 账户已成功连接</h1>
      <p>OAuth 凭据已安全持久化至 SQLite 隔离存储</p>
    </div>

    <div class="info-panel">
      <div class="info-row">
        <span class="info-label">连接状态</span>
        <span class="info-value">
          已授权绑定
          <span class="tag-badge green">正常</span>
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">安全防护</span>
        <span class="info-value">SchwabVault DO 加密持久化</span>
      </div>
    </div>

    <div class="security-notice">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
      <div>
        您现在可以安全关闭此浏览器窗口，并返回您的 MCP 客户端继续使用。
      </div>
    </div>

    <div class="auth-footer">
      <span>Charles Schwab MCP · 个人专用高安全实例</span>
    </div>
  </div>
</body>
</html>`;
}
