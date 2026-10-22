import { html, raw } from "hono/html";
import { getDictionary, LANG_DROPDOWN_SCRIPT, renderLangDropdown, resolveLang, type SupportedLang } from "./i18n";

export const FAVICON_LINK = raw('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
export const PWA_HEAD_TAGS = raw(`
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
  <link rel="manifest" href="/manifest.webmanifest">
  <meta name="theme-color" content="#070b12">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Schwab MCP">
`);

export const PWA_SERVICE_WORKER_SCRIPT = raw(`
<script>
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(function(err) {
      console.warn('SW registration failed:', err);
    });
  });
}
</script>
`);

export interface AuthorizePageProps {
  clientName: string;
  redirectUri: string;
  state: string;
  advancedSecurity?: boolean;
  lang?: SupportedLang;
  authorizationQuery?: string;
}

// Finish the same-origin form navigation before starting GitHub OAuth. A 302
// directly from the form POST remains subject to the form-action 'self' CSP.
export function renderClientContinuePage(url: string, langCandidate?: SupportedLang) {
  const lang = resolveLang(langCandidate);
  const zh = lang !== "en-US";
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FAVICON_LINK}<title>${zh ? "返回客户端" : "Return to client"}</title><style>${COMMON_STYLES}</style></head><body><main class="main-wrapper"><p class="page-subtitle">${zh ? "账户授权已完成，正在返回客户端。" : "Account authorization complete. Returning to the client."}</p><a class="pill-btn" id="client-continue" href="${url}">${zh ? "继续返回客户端" : "Continue to client"}</a></main><script>location.replace(document.getElementById('client-continue').href);</script></body></html>`;
}

export function renderGitHubContinuePage(url: string, langCandidate?: SupportedLang) {
  const lang = resolveLang(langCandidate);
  const dict = getDictionary(lang);
  const t = dict.auth;
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FAVICON_LINK}<title>${t.gitHubContinueTitle}</title><style>body{margin:0;min-height:100vh;background:#090d16;color:#f8fafc;font-family:ui-monospace,"SF Mono","JetBrains Mono",Menlo,monospace;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}a{color:#38bdf8;text-underline-offset:4px}p{font-size:14px;color:#94a3b8;margin:8px 0}</style></head><body><p>${t.gitHubContinueNotice}</p><p><a id="github-continue" href="${url}">${t.gitHubContinueLink}</a></p><script>location.replace(document.getElementById('github-continue').href);</script></body></html>`;
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
    accent-color: var(--brand-emerald);
  }

  input:not([type="checkbox"]):not([type="radio"]):user-invalid,
  select:user-invalid {
    border-color: var(--brand-rose) !important;
    background-color: rgba(255, 180, 171, 0.08) !important;
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

  /* Language Dropdown Menu */
  .lang-dropdown {
    position: relative;
    display: inline-block;
    user-select: none;
  }

  .lang-dropdown summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(20, 26, 36, 0.85);
    color: var(--text-sub);
    border: 1px solid var(--card-border);
    border-radius: 4px;
    padding: 3px 8px;
    font-size: 11px;
    font-family: inherit;
    font-weight: 600;
    cursor: pointer;
    list-style: none;
    transition: all 0.15s ease;
    min-height: 24px;
  }

  .lang-dropdown summary::-webkit-details-marker {
    display: none;
  }

  .lang-dropdown summary:hover,
  .lang-dropdown[open] summary {
    color: var(--text-main);
    border-color: var(--card-border-focus);
    background: rgba(34, 44, 61, 0.95);
  }

  .lang-dropdown .lang-icon {
    font-size: 12px;
    line-height: 1;
  }

  .lang-dropdown .lang-caret {
    font-size: 9px;
    opacity: 0.7;
    transition: transform 0.15s ease;
  }

  .lang-dropdown[open] .lang-caret {
    transform: rotate(180deg);
  }

  .lang-dropdown-menu {
    position: absolute;
    top: calc(100% + 5px);
    right: 0;
    min-width: 130px;
    background: #0f131c;
    border: 1px solid var(--card-border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    padding: 4px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .lang-dropdown-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 5px 8px;
    border-radius: 4px;
    color: var(--text-sub);
    text-decoration: none;
    font-size: 11px;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .lang-dropdown-item:hover {
    background: #1a2230;
    color: var(--text-main);
    text-decoration: none;
  }

  .lang-dropdown-item.active {
    color: #4edea3;
    font-weight: 600;
    background: rgba(78, 222, 163, 0.08);
  }

  .lang-dropdown-item .lang-check {
    font-size: 11px;
    color: #4edea3;
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
  const lang = resolveLang(props.lang);
  const dict = getDictionary(lang);
  const t = dict.auth;
  const c = dict.common;

  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t.authorizeTitle}</title>
  ${FAVICON_LINK}
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${raw(BACKGROUND_SVG)}

  <div class="main-wrapper">
    <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
      <div class="telemetry-node">
        <span class="status-pulse-dot"></span>
        <span>${t.gatewayTag}</span>
      </div>
      <div class="telemetry-chips">
        ${raw(renderLangDropdown(lang, props.authorizationQuery))}
        <span class="tag-badge green">&bull; RFC 7636 S256</span>
        <span class="tag-badge">ENCLAVE_ISOLATED</span>
      </div>
    </div>
    <div class="brand-header">
      ${raw(BRAND_LOGO_SVG)}
      <span class="brand-title">${c.brandTitle}</span>
    </div>

    <div class="terminal-prompt-tag">${t.incomingChallengeTag}</div>

    <h1 class="page-title">${t.consentHeading}</h1>
    <p class="page-subtitle">${t.consentSubtitle}</p>

    <div class="auth-card">
      <div class="info-row">
        <span class="info-label">${t.clientLabel}</span>
        <span class="info-value">
          ${props.clientName}
          <span class="tag-badge">OAuth 2.1</span>
          <span class="tag-badge green">RFC 7636 S256</span>
        </span>
      </div>
      <div class="info-row column">
        <span class="info-label">${t.redirectUriLabel}</span>
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
            <div class="policy-title">${t.readAccountTitle}</div>
            <div class="policy-desc">${t.readAccountDesc}</div>
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
            <div class="policy-title">${t.tradingPolicyTitle}</div>
            <div class="policy-desc">${t.tradingPolicyDesc}</div>
          </div>
        </div>
      </div>

      <fieldset class="permission-options">
        <legend>${t.permissionLegend}</legend>
        <label class="permission-option">
          <input type="radio" name="permissionLevel" value="read_only" form="authorize-form" required ${props.advancedSecurity ? "" : "checked"}>
          <span>
            <span class="policy-title">${t.readOnlyTitle}</span><br>
            <span class="policy-desc">${t.readOnlyDesc}</span>
          </span>
        </label>
        <label class="permission-option">
          <input type="radio" name="permissionLevel" value="full_access" form="authorize-form" required ${props.advancedSecurity ? "checked" : ""}>
          <span>
            <span class="policy-title">${t.fullAccessTitle}</span><br>
            <span class="policy-desc">${t.fullAccessDesc}</span>
          </span>
        </label>
      </fieldset>

      <label class="permission-option" id="advanced-option" style="margin-top: 10px;">
        <input type="checkbox" name="advancedSecurity" form="authorize-form" ${props.advancedSecurity ? "checked" : ""}>
        <span>
          <span class="policy-title">${t.advancedSecurityTitle}</span><br>
          <span class="policy-desc">${t.advancedSecurityDesc}</span>
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
          ${raw(t.githubOwnerNotice)}
        </div>
      </div>
    </div>

    <form id="authorize-form" class="action-form" method="post" action="/authorize/approve">
      <input type="hidden" name="state" value="${props.state}">
      <button type="submit" class="pill-btn">
        <svg viewBox="0 0 24 24">
          <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
        </svg>
        <span>${t.continueButton}</span>
      </button>
    </form>

    <div class="auth-footer">
      <span>${t.footerHint}</span>
      <span class="footer-dot">·</span>
      <span>${t.footerBrand}</span>
    </div>
  </div>
  ${raw(LANG_DROPDOWN_SCRIPT)}
</body>
</html>`;
}

export function renderSchwabConnectedPage(langCandidate?: SupportedLang): string {
  return renderCompletionPage(false, langCandidate);
}

export function renderPasskeyAuthorizedPage(langCandidate?: SupportedLang): string {
  return renderCompletionPage(true, langCandidate);
}

function renderCompletionPage(passkey: boolean, langCandidate?: SupportedLang): string {
  const lang = resolveLang(langCandidate);
  const dict = getDictionary(lang);
  const t = dict.auth;
  const c = dict.common;

  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${passkey ? t.passkeyAuthorizedTitle : t.schwabConnectedTitle}</title>
  ${FAVICON_LINK}
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${BACKGROUND_SVG}

  <div class="main-wrapper">
    <div class="telemetry-bar-top" style="width:100%;margin-bottom:12px;">
      <div class="telemetry-node">
        <span class="status-pulse-dot"></span>
        <span>&gt;_ SCHWAB_MCP // ${passkey ? "PASSKEY_VERIFIED" : "BROKERAGE_CONNECTED"}</span>
      </div>
      <div class="telemetry-chips">
        ${renderLangDropdown(lang)}
        <span class="tag-badge green">&bull; ${passkey ? "DONE" : "ONLINE"}</span>
        <span class="tag-badge">${passkey ? "PASSKEY_VERIFIED" : "VAULT_ENCRYPTED"}</span>
      </div>
    </div>
    <div class="brand-header">
      ${BRAND_LOGO_SVG}
      <span class="brand-title">${c.brandTitle}</span>
    </div>

    <div class="terminal-prompt-tag">&gt;_ ${passkey ? "PASSKEY AUTHORIZATION SUCCESS" : "BROKERAGE CONNECTION VERIFIED"}</div>

    <h1 class="page-title">${passkey ? t.passkeyAuthorizedHeading : t.schwabConnectedHeading}</h1>
    <p class="page-subtitle">${passkey ? t.passkeyAuthorizedSubtitle : t.schwabConnectedSubtitle}</p>

    <div class="auth-card">
      <div class="info-row">
        <span class="info-label">${t.statusLabel}</span>
        <span class="info-value">
          ${passkey ? t.passkeyStatusValue : t.schwabStatusValue}
          <span class="tag-badge green">${passkey ? "完成 DONE" : "正常 ONLINE"}</span>
        </span>
      </div>
      <div class="card-divider"></div>
      <div class="info-row">
        <span class="info-label">${t.securityLabel}</span>
        <span class="info-value">
          ${passkey ? t.passkeySecurityValue : t.schwabSecurityValue}
          <span class="tag-badge">${passkey ? "VERIFIED" : "ENCLAVE SEALED"}</span>
        </span>
      </div>

      <div class="security-notice success">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <div>
          ${t.completionNotice}
        </div>
      </div>
    </div>

    <div class="action-form">
      <button type="button" class="pill-btn" onclick="window.close()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>${t.doneCloseButton}</span>
      </button>
      <div class="action-hint">${t.closeTabHint}</div>
    </div>

    <div class="auth-footer">
      <span>${t.completionFooter}</span>
    </div>
  </div>
  ${raw(LANG_DROPDOWN_SCRIPT)}
</body>
</html>`;
}

export function renderAccountSelectionPage(props: {
  state: string;
  clientName: string;
  accounts: { hashValue: string; label: string }[];
  selected: string[];
  connected: boolean;
  lang?: SupportedLang;
}) {
  const lang = resolveLang(props.lang);
  const zh = lang !== "en-US";
  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FAVICON_LINK}
  <title>${zh ? "选择授权账户" : "Select accounts"}</title>
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${raw(BACKGROUND_SVG)}
  <main class="main-wrapper">
    <div class="brand-header">${raw(BRAND_LOGO_SVG)}<span class="brand-title">Schwab MCP</span></div>
    <h1 class="page-title">${zh ? "选择开放的账户" : "Select accounts to share"}</h1>
    <p class="page-subtitle">${props.clientName}</p>
    <form class="auth-card" action="/authorize/accounts" method="post" style="width:100%">
      <input type="hidden" name="state" value="${props.state}">
      <fieldset class="permission-options">
        <legend>${zh ? "此客户端可访问的账户" : "Accounts available to this client"}</legend>
        <p class="policy-desc">${zh ? "可选择多个账户。不选择账户时仅开放行情。新增账户需重新授权。" : "Select any accounts. Leave all unchecked for market data only. New accounts require fresh consent."}</p>
        ${props.accounts.map(account => html`
          <label class="permission-option">
            <input type="checkbox" name="accountHash" value="${account.hashValue}" ${props.selected.includes(account.hashValue) ? "checked" : ""}>
            <span style="min-width:0;overflow-wrap:anywhere">${account.label}<br><small class="policy-desc">${account.hashValue}</small></span>
          </label>
        `)}
      </fieldset>
      ${props.connected ? "" : html`
        <p class="policy-desc">${zh ? "Schwab 尚未连接或需重新连接；当前只能授权行情访问。" : "Reconnect Schwab to select accounts. Market data consent remains available."}</p>
        <p><a href="/auth/schwab/connect">${zh ? "连接 Schwab（完成后重新发起 MCP 授权）" : "Connect Schwab, then restart MCP authorization"}</a></p>
      `}
      <div class="action-form"><button type="submit" class="pill-btn">${zh ? "确认账户并继续授权" : "Confirm accounts and continue"}</button></div>
    </form>
  </main>
</body>
</html>`;
}
