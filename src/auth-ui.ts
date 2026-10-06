import { html, raw } from "hono/html";

export interface AuthorizePageProps {
  clientName: string;
  redirectUri: string;
  state: string;
}

function createBackgroundSvg(): string {
  const particles: string[] = [];
  const colors = [
    "#1d4ed8", "#2563eb", "#3b82f6", "#0284c7", "#38bdf8", // blues
    "#4f46e5", "#6366f1", "#7c3aed", "#8b5cf6", "#a855f7", // purples
    "#c026d3", "#d946ef", "#ec4899", "#f43f5e", "#ef4444", // pinks/reds
    "#ea580c", "#f97316", "#f59e0b", "#fbbf24", "#eab308", // oranges/yellows
    "#10b981", "#14b8a6", "#06b6d4"                         // teals
  ];

  let seed = 42819;
  function rnd() {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  }

  const cx = 520;
  const cy = 500;

  const arms = [
    { startTheta: 2.2, endTheta: 6.4, r0: 80, r1: 820, count: 100, colorStart: 0 },
    { startTheta: 3.4, endTheta: 7.8, r0: 95, r1: 890, count: 110, colorStart: 5 },
    { startTheta: 0.7, endTheta: 5.0, r0: 85, r1: 780, count: 90, colorStart: 11 },
    { startTheta: 4.9, endTheta: 8.6, r0: 120, r1: 910, count: 80, colorStart: 17 }
  ];

  for (const arm of arms) {
    for (let i = 0; i < arm.count; i++) {
      const t = i / arm.count;
      const theta = arm.startTheta + t * (arm.endTheta - arm.startTheta) + (rnd() - 0.5) * 0.42;
      const r = arm.r0 + Math.pow(t, 1.32) * (arm.r1 - arm.r0) + (rnd() - 0.5) * 85;

      const x = cx + Math.cos(theta) * r * 1.32;
      const y = cy + Math.sin(theta) * r * 0.95;

      if (x < -30 || x > 1470 || y < -30 || y > 930) continue;
      if (x > 460 && x < 980 && y > 240 && y < 660 && rnd() > 0.08) continue;

      const cIdx = Math.floor(arm.colorStart + t * 14 + rnd() * 2) % colors.length;
      const color = colors[cIdx] ?? "#2563eb";
      const opacity = (0.35 + rnd() * 0.55).toFixed(2);
      const isRect = rnd() > 0.36;

      if (isRect) {
        const w = (2 + rnd() * 1.0).toFixed(1);
        const h = (5 + rnd() * 4).toFixed(1);
        const tangentDeg = ((theta + Math.PI / 2 + (rnd() - 0.5) * 0.35) * 180 / Math.PI).toFixed(1);
        particles.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="1" fill="${color}" opacity="${opacity}" transform="rotate(${tangentDeg} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
      } else {
        const rad = (1.2 + rnd() * 1.3).toFixed(1);
        particles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="${color}" opacity="${opacity}"/>`);
      }
    }
  }

  for (let i = 0; i < 75; i++) {
    const x = rnd() * 1440;
    const y = rnd() * 900;
    if (x > 450 && x < 990 && y > 230 && y < 670) continue;
    const color = colors[Math.floor(rnd() * colors.length)] ?? "#2563eb";
    const opacity = (0.22 + rnd() * 0.42).toFixed(2);
    if (rnd() > 0.5) {
      const rot = (rnd() * 360).toFixed(1);
      particles.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="2.2" height="6" rx="1" fill="${color}" opacity="${opacity}" transform="rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})"/>`);
    } else {
      const rad = (1.2 + rnd() * 1.2).toFixed(1);
      particles.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad}" fill="${color}" opacity="${opacity}"/>`);
    }
  }

  return `<svg class="bg-particles" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none" xmlns="http://www.w3.org/2000/svg"><g>${particles.join("")}</g></svg>`;
}

const BACKGROUND_SVG = createBackgroundSvg();

const BRAND_LOGO_SVG = `<svg class="brand-logo" width="34" height="34" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
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
  </defs>
  <path d="M18 4.5L5.5 27.5L18 20.5Z" fill="url(#logo-left)" />
  <path d="M18 4.5L30.5 27.5L18 20.5Z" fill="url(#logo-right)" />
  <path d="M5.5 27.5L30.5 27.5L18 20.5Z" fill="url(#logo-bottom)" />
</svg>`;

const COMMON_STYLES = `
  :root {
    --bg: #ffffff;
    --card-bg: #f8fafc;
    --card-border: #e2e8f0;
    --card-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 6px 16px 0 rgba(0, 0, 0, 0.02);

    --text-main: #1f2937;
    --text-sub: #4b5563;
    --text-muted: #5f6368;

    --panel-bg: #ffffff;
    --panel-border: #e5e7eb;
    --divider: #edf2f7;

    --btn-bg: #1f1f1f;
    --btn-hover: #374151;
    --btn-active: #111827;
    --btn-text: #ffffff;

    --brand-blue: #0284c7;
    --brand-blue-soft: #f0f9ff;
    --brand-blue-border: #bae6fd;

    --accent-green: #059669;
    --accent-green-soft: #ecfdf5;
    --accent-green-border: #a7f3d0;

    --code-bg: #ffffff;
    --code-border: #e2e8f0;
    --code-text: #0284c7;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #090d16;
      --card-bg: #111726;
      --card-border: #1e293b;
      --card-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.3), 0 8px 24px 0 rgba(0, 0, 0, 0.2);

      --text-main: #f8fafc;
      --text-sub: #94a3b8;
      --text-muted: #64748b;

      --panel-bg: #0b111e;
      --panel-border: #1e293b;
      --divider: #1e293b;

      --btn-bg: #f8fafc;
      --btn-hover: #e2e8f0;
      --btn-active: #cbd5e1;
      --btn-text: #0f172a;

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

  .bg-particles {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    pointer-events: none;
    z-index: 0;
  }

  @media (prefers-color-scheme: dark) {
    .bg-particles {
      opacity: 0.85;
    }
  }

  .main-wrapper {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 520px;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .brand-header {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 8px;
  }

  .brand-logo {
    flex-shrink: 0;
  }

  .brand-title {
    font-size: 26px;
    font-weight: 550;
    letter-spacing: -0.02em;
    color: var(--text-main);
  }

  .page-title {
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--text-main);
    margin-bottom: 6px;
    text-align: center;
  }

  .page-subtitle {
    font-size: 14px;
    color: var(--text-muted);
    margin-bottom: 24px;
    text-align: center;
    line-height: 1.4;
  }

  .auth-card {
    width: 100%;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 16px;
    box-shadow: var(--card-shadow);
    padding: 20px 22px;
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
    margin-top: 10px;
  }

  .info-label {
    color: var(--text-muted);
    font-weight: 500;
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
    padding: 2px 7px;
    border-radius: 9999px;
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
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 11.5px;
    color: var(--code-text);
    word-break: break-all;
    background: var(--code-bg);
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid var(--code-border);
    line-height: 1.4;
  }

  .card-divider {
    height: 1px;
    background: var(--divider);
    margin: 14px 0;
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
    margin-top: 14px;
    line-height: 1.4;
  }

  .security-notice.success {
    background: var(--accent-green-soft);
    border-color: var(--accent-green-border);
    color: var(--text-main);
  }

  .security-notice svg {
    flex-shrink: 0;
    color: var(--text-muted);
  }

  .security-notice.success svg {
    color: var(--accent-green);
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
    margin-top: 24px;
  }

  .pill-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    background: var(--btn-bg);
    color: var(--btn-text);
    border: none;
    border-radius: 9999px;
    padding: 12px 36px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12), 0 3px 8px rgba(0, 0, 0, 0.08);
    transition: transform 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
    text-decoration: none;
  }

  .pill-btn:hover {
    background: var(--btn-hover);
    transform: translateY(-1px);
    box-shadow: 0 3px 6px rgba(0, 0, 0, 0.15), 0 6px 16px rgba(0, 0, 0, 0.1);
  }

  .pill-btn:active {
    background: var(--btn-active);
    transform: translateY(0);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }

  .pill-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
    flex-shrink: 0;
  }

  .action-hint {
    margin-top: 8px;
    font-size: 11.5px;
    color: var(--text-muted);
    text-align: center;
  }

  .auth-footer {
    margin-top: 28px;
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
  ${raw(BACKGROUND_SVG)}

  <div class="main-wrapper">
    <div class="brand-header">
      ${raw(BRAND_LOGO_SVG)}
      <span class="brand-title">Schwab MCP</span>
    </div>

    <h1 class="page-title">允许连接 Schwab MCP？</h1>
    <p class="page-subtitle">客户端正在申请接入您的个人 Charles Schwab MCP 实例</p>

    <div class="auth-card">
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
    </div>

    <form class="action-form" method="post" action="/authorize/approve">
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
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${BACKGROUND_SVG}

  <div class="main-wrapper">
    <div class="brand-header">
      ${BRAND_LOGO_SVG}
      <span class="brand-title">Schwab MCP</span>
    </div>

    <h1 class="page-title">Schwab 账户已成功连接</h1>
    <p class="page-subtitle">OAuth 凭据已安全持久化至 SQLite 隔离存储</p>

    <div class="auth-card">
      <div class="info-row">
        <span class="info-label">连接状态</span>
        <span class="info-value">
          已授权绑定
          <span class="tag-badge green">正常</span>
        </span>
      </div>
      <div class="card-divider"></div>
      <div class="info-row">
        <span class="info-label">安全防护</span>
        <span class="info-value">SchwabVault DO 加密持久化</span>
      </div>

      <div class="security-notice success">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
