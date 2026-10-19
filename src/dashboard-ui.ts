import { html, raw } from "hono/html";
import type { BrowserSession } from "./security-store";
import { BACKGROUND_SVG, BRAND_LOGO_SVG, FAVICON_LINK, PWA_HEAD_TAGS, PWA_SERVICE_WORKER_SCRIPT } from "./auth-ui";
import { formatString, getDashboardClientI18n, getDictionary, renderLangDropdown, resolveLang, type SupportedLang } from "./i18n";

export interface DashboardPageProps {
  session: BrowserSession;
  appVersion: string;
  allowedUserId: string;
  highlightNotificationId?: string;
  lang?: SupportedLang;
}

const DASHBOARD_STYLES = `
:root {
  color-scheme: dark;
  --bg: #070b12;
  --surface: #0f131c;
  --surface-lowest: #0a0e17;
  --surface-low: #141a24;
  --surface-container: #1a2230;
  --surface-high: #222c3d;
  --surface-highest: #2c384d;
  --outline: #86948a;
  --outline-variant: #3c4a42;
  --line: #1e2d42;
  --line-focus: #4edea3;
  --text: #dfe2ef;
  --text-bright: #f0ffe9;
  --muted: #86948a;
  --dim: #5c6b61;
  --primary: #4edea3;
  --primary-container: #10b981;
  --on-primary: #003824;
  --primary-glow: 0 0 12px rgba(78, 222, 163, 0.3);
  --secondary: #7bd0ff;
  --secondary-glow: 0 0 12px rgba(123, 208, 255, 0.25);
  --tertiary: #ffb95f;
  --error: #ffb4ab;
  --error-container: #93000a;
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-full: 9999px;
  --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --shadow: 0 4px 24px -2px rgba(0, 0, 0, 0.6), 0 2px 8px -1px rgba(0, 0, 0, 0.4);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding-top: env(safe-area-inset-top, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
  background-color: var(--bg);
  background-image:
    linear-gradient(to right, rgba(60, 74, 66, 0.1) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(60, 74, 66, 0.1) 1px, transparent 1px);
  background-size: 24px 24px;
  color: var(--text);
  font-family: var(--font-mono);
  line-height: 1.5;
  min-height: 100vh;
  position: relative;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.bg-telemetry {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 0;
  opacity: 0.65;
}

button, input, select {
  font-family: inherit;
  font-size: 13px;
}

button, a, input, select {
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}

button {
  cursor: pointer;
}

a {
  color: var(--secondary);
  text-underline-offset: 3px;
  text-decoration: none;
  transition: color 0.15s ease, text-decoration 0.15s ease;
}

a:hover {
  text-decoration: underline;
  color: #a5e0ff;
}

button:disabled, input:disabled, select:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

[hidden] {
  display: none !important;
}

h1, h2, h3, p {
  margin: 0;
}

h1 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.015em;
  color: var(--text-bright);
}

h2 {
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-bright);
  text-transform: uppercase;
}

h3 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

small, .muted {
  color: var(--muted);
}

.mono, code {
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}

.shell {
  position: relative;
  z-index: 1;
  max-width: 1440px;
  padding: 16px 20px max(48px, calc(16px + env(safe-area-inset-bottom, 0px)));
  margin: auto;
}

/* TOP TELEMETRY APP BAR (Obsidian Telemetry Header) */
.telemetry-bar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(10, 14, 23, 0.95);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
  font-size: 11px;
  color: var(--muted);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);
}

.telemetry-node {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--primary);
}

.status-pulse-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--primary);
  box-shadow: var(--primary-glow);
  animation: pulse-dot 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.85); }
}

.telemetry-chips {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.telemetry-chips .chip-badge {
  background: var(--surface-low);
  padding: 2px 8px;
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  color: var(--secondary);
}

/* TOPLINE BRAND & ACTIONS */
.topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 14px 18px;
  background: var(--surface-low);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  margin-bottom: 18px;
  box-shadow: var(--shadow);
}

.brand {
  display: flex;
  align-items: center;
  gap: 14px;
}

.brand-logo {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--primary);
  margin-bottom: 2px;
}

.topline h1 {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-bright);
}

.topline p {
  font-size: 12px;
  color: var(--muted);
}

.topline .actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.owner {
  text-align: right;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted);
}

.owner strong {
  color: var(--secondary);
}

#last-refresh {
  color: var(--dim);
  font-size: 10px;
}

/* TELEMETRY STATUS DECK (3 Cards) */
.status-deck {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}

.status-cell {
  background: var(--surface-low);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  gap: 10px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.status-cell:hover {
  border-color: var(--outline);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.status-cell-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid rgba(60, 74, 66, 0.4);
  padding-bottom: 8px;
}

.status-cell-header .label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--muted);
  text-transform: uppercase;
}

.status-cell-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
}

.status-cell-body p {
  margin: 0;
  font-size: 12px;
}

.telemetry-stat {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

.status-cell-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid rgba(60, 74, 66, 0.3);
  padding-top: 8px;
  font-size: 11px;
}

.card-action-link {
  font-size: 11px;
  font-weight: 600;
  color: var(--primary);
}

.card-action-link.secondary {
  color: var(--secondary);
}

/* BADGES */
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.3;
}

.badge.good {
  background: rgba(78, 222, 163, 0.12);
  color: var(--primary);
  border: 1px solid rgba(78, 222, 163, 0.35);
}

.badge.bad {
  background: rgba(255, 180, 171, 0.12);
  color: var(--error);
  border: 1px solid rgba(255, 180, 171, 0.35);
}

.badge.warn {
  background: rgba(255, 185, 95, 0.12);
  color: var(--tertiary);
  border: 1px solid rgba(255, 185, 95, 0.35);
}

.badge.neutral {
  background: var(--surface-container);
  color: var(--muted);
  border: 1px solid var(--outline-variant);
}

/* BUTTONS */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 14px;
  background: var(--surface-container);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  color: var(--text-bright);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  transition: all 0.15s ease;
}

.button:hover:not(:disabled) {
  background: var(--surface-high);
  border-color: var(--outline);
}

.button.primary {
  background: var(--primary-container);
  border-color: var(--primary);
  color: var(--on-primary);
  box-shadow: 0 0 10px rgba(16, 185, 129, 0.25);
}

.button.primary:hover:not(:disabled) {
  background: var(--primary);
  box-shadow: 0 0 14px rgba(78, 222, 163, 0.4);
}

.button.danger {
  background: rgba(147, 0, 10, 0.4);
  border-color: var(--error);
  color: var(--error);
}

.button.danger:hover:not(:disabled) {
  background: rgba(147, 0, 10, 0.7);
}

.button.compact {
  padding: 3px 8px;
  font-size: 11px;
}

/* TABS */
.tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  border-bottom: 1px solid var(--line);
  margin-bottom: 18px;
  padding-bottom: 2px;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.05em;
  transition: all 0.15s ease;
}

.tab:hover {
  color: var(--text-bright);
  background: var(--surface-low);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}

.tab[aria-selected="true"] {
  color: var(--primary);
  border-bottom-color: var(--primary);
}

.tab span {
  font-size: 10px;
  color: var(--dim);
}

.tab[aria-selected="true"] span {
  color: var(--primary);
}

/* PANELS */
.panel {
  background: var(--surface-low);
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow);
  margin-bottom: 18px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: rgba(10, 14, 23, 0.8);
}

.section-head h2 {
  margin-bottom: 2px;
}

.section-head p {
  font-size: 12px;
  color: var(--muted);
}

/* TABLES */
.table-scroll {
  overflow-x: auto;
  max-width: 100%;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  text-align: left;
}

caption {
  text-align: right;
  padding: 6px 16px;
  font-size: 11px;
  color: var(--muted);
  background: var(--surface-lowest);
  border-bottom: 1px solid var(--line);
}

th {
  padding: 9px 14px;
  background: var(--surface-container);
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

td {
  padding: 10px 14px;
  border-bottom: 1px solid rgba(30, 45, 66, 0.6);
  vertical-align: middle;
}

tr:hover td {
  background: rgba(26, 34, 48, 0.4);
}

td.empty {
  text-align: center;
  padding: 32px 16px;
  color: var(--muted);
  font-size: 12px;
}

td.load-error {
  color: var(--error);
}

.client-meta {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.client-name {
  font-weight: 600;
  color: var(--text-bright);
}

.redirects summary {
  font-size: 11px;
  color: var(--secondary);
  cursor: pointer;
  margin-top: 4px;
}

.redirects ul {
  margin: 4px 0 0;
  padding-left: 14px;
  font-size: 11px;
  color: var(--muted);
}

.policy-note {
  display: block;
  font-size: 10px;
  color: var(--dim);
  margin-top: 3px;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  cursor: pointer;
}

select.permission {
  background: var(--surface-container);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  color: var(--text-bright);
  padding: 3px 8px;
  font-size: 11px;
}

.timestamp {
  font-size: 11px;
  color: var(--text);
  white-space: nowrap;
}

.timestamp.muted {
  color: var(--muted);
  font-size: 10px;
}

/* AUDIT STATS DECK */
.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  background: var(--surface-lowest);
  border-bottom: 1px solid var(--line);
}

.stat {
  padding: 12px 16px;
  border-right: 1px solid var(--line);
}

.stat:last-child {
  border-right: none;
}

.stat .label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--primary);
}

/* FILTERS FORM */
.filters {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 12px 18px;
  background: rgba(10, 14, 23, 0.5);
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}

.filters .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--muted);
  min-width: 180px;
  flex: 1;
}

.filters input, .filters select {
  background: var(--surface-container);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  color: var(--text-bright);
  padding: 6px 10px;
  font-size: 12px;
}

.filters .actions {
  display: flex;
  gap: 8px;
}

.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 18px;
  background: var(--surface-lowest);
  border-top: 1px solid var(--line);
  font-size: 11px;
  color: var(--muted);
}

.pagination .actions {
  display: flex;
  gap: 8px;
}

/* PASSKEYS PANEL */
.panel-body {
  padding: 18px;
}

.credentials {
  list-style: none;
  margin: 12px 0 18px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.credential {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--surface-container);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-md);
}

.credential h3 {
  margin-bottom: 3px;
  color: var(--text-bright);
}

.credential-id {
  font-size: 11px;
  color: var(--secondary);
}

.credential .actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.add-passkey {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 18px;
  max-width: 460px;
}

.add-passkey .field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  font-size: 11px;
  color: var(--muted);
}

.add-passkey input {
  background: var(--surface-container);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  color: var(--text-bright);
  padding: 6px 10px;
  font-size: 12px;
}

.recovery {
  margin-top: 24px;
  padding: 14px 18px;
  background: rgba(147, 0, 10, 0.15);
  border: 1px solid rgba(255, 180, 171, 0.3);
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.recovery p {
  font-size: 12px;
  color: var(--text);
}

/* MESSAGES & ALERTS */
.message {
  padding: 10px 16px;
  border-radius: var(--radius-sm);
  background: rgba(78, 222, 163, 0.12);
  border: 1px solid rgba(78, 222, 163, 0.4);
  color: var(--primary);
  font-size: 12px;
  margin-bottom: 16px;
}

.message.error {
  background: rgba(255, 180, 171, 0.12);
  border-color: rgba(255, 180, 171, 0.4);
  color: var(--error);
}

/* DIALOG */
dialog {
  background: var(--surface-low);
  color: var(--text);
  border: 1px solid var(--primary);
  border-radius: var(--radius-lg);
  padding: 24px;
  max-width: 480px;
  width: 90vw;
  box-shadow: 0 0 32px rgba(0, 0, 0, 0.8), 0 0 16px rgba(78, 222, 163, 0.2);
}

dialog::backdrop {
  background: rgba(6, 10, 16, 0.85);
  backdrop-filter: blur(4px);
}

dialog h2 {
  margin-bottom: 8px;
  color: var(--text-bright);
}

dialog p {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
  margin-bottom: 14px;
}

dialog .actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}

/* CRT STATUS FOOTER DOCK */
.footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: rgba(10, 14, 23, 0.95);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-md);
  margin-top: 18px;
  font-size: 11px;
  color: var(--muted);
  box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.5);
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: 0.04em;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
  letter-spacing: 0.04em;
  color: var(--dim);
}

.skip {
  position: absolute;
  left: 16px;
  top: -60px;
  z-index: 100;
  background: var(--surface-container);
  padding: 10px 16px;
  border: 1px solid var(--primary);
  border-radius: var(--radius-sm);
  color: var(--primary);
}

.skip:focus {
  top: 10px;
}

.support-warning {
  color: var(--tertiary);
  background: rgba(255, 185, 95, 0.08);
  border: 1px solid rgba(255, 185, 95, 0.3);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 12px;
}

.overview-stats {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

/* MOBILE RESPONSIVE DOCK & ERGONOMICS */
@media (max-width: 768px) {
  .shell {
    padding: 10px 12px 64px;
  }
  .telemetry-bar-top {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .topline {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  .topline .actions {
    width: 100%;
    justify-content: space-between;
  }
  .owner {
    text-align: left;
  }
  .status-deck {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .tabs {
    width: 100%;
    gap: 4px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    flex-wrap: nowrap;
    padding-bottom: 2px;
  }
  .tab {
    flex: 0 0 auto;
    min-width: 90px;
    font-size: 11px;
    padding: 8px 6px;
    min-height: 44px;
    min-width: 44px;
    flex-direction: column;
    text-align: center;
    gap: 2px;
  }
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .stats.overview-stats {
    grid-template-columns: 1fr;
  }
  .stat {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
  }
  .stat:last-child {
    grid-column: 1 / -1;
  }
  .filters {
    padding: 12px;
    flex-direction: column;
    align-items: stretch;
  }
  .filters .field {
    min-width: 100%;
  }
  .filters .actions {
    width: 100%;
  }
  .filters .actions .button {
    flex: 1;
  }
  .credential {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }
  .footer {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .button, input, select {
    min-height: 44px;
    min-width: 44px;
  }
  .button.compact {
    min-height: 44px;
  }
}
@media (max-width: 480px) {
  .shell {
    padding: 8px 8px max(72px, calc(32px + env(safe-area-inset-bottom, 0px)));
  }
  .telemetry-bar-top {
    font-size: 10px;
    padding: 6px 10px;
  }
  .topline .brand .brand-title {
    font-size: 14px;
  }
  .card-action-link {
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
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
  background: var(--surface-container);
  color: var(--text);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-sm);
  padding: 4px 10px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  list-style: none;
  transition: all 0.15s ease;
  min-height: 26px;
}

.lang-dropdown summary::-webkit-details-marker {
  display: none;
}

.lang-dropdown summary:hover,
.lang-dropdown[open] summary {
  color: var(--text-bright);
  border-color: var(--primary);
  background: var(--surface-high);
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
  background: var(--surface);
  border: 1px solid var(--outline-variant);
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-sm);
  color: var(--text);
  text-decoration: none;
  font-size: 11px;
  transition: background 0.12s ease, color 0.12s ease;
}

.lang-dropdown-item:hover {
  background: var(--surface-container);
  color: var(--text-bright);
  text-decoration: none;
}

.lang-dropdown-item.active {
  color: var(--primary);
  font-weight: 600;
  background: rgba(78, 222, 163, 0.08);
}

.lang-dropdown-item .lang-check {
  font-size: 11px;
  color: var(--primary);
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
`;

// All server-provided strings are inserted as text, never interpolated into HTML or script.
const DASHBOARD_SCRIPT = String.raw`
'use strict';
(() => {
const $ = id => document.getElementById(id);
const i18n = (typeof globalThis !== 'undefined' && globalThis.__I18N__) || (typeof window !== 'undefined' && window.__I18N__) || {};
function t(k, fallback = '') { return i18n[k] !== undefined ? i18n[k] : fallback; }
function format(str, vars) {
  let res = str;
  if (!vars) return res;
  for (const [key, val] of Object.entries(vars)) res = res.replaceAll('{' + key + '}', val);
  return res;
}
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
let notificationsOffset = 0;
let notificationsTotal = 0;
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
  $('session-state').textContent = t('sessionExpired', '会话已过期');
  $('session-state').className = 'badge bad';
  $('session-login').hidden = false;
  message(t('sessionExpiredMessage', '浏览器安全会话已失效。请重新通过 GitHub owner 登录；未完成的 Passkey 操作不会自动继续。'), true);
  if (dialog.open && !busy) { pending = null; dialog.close(); }
  syncControls();
}
async function api(path, method = 'GET', body) {
  if (expired || Date.now() >= sessionExpiresAt) { markExpired(); throw new Error(t('sessionExpiredError', '会话已过期，请重新登录。')); }
  let res;
  try {
    res = await fetch(path, {method, credentials:'same-origin', cache:'no-store', redirect:'error', headers:{'Accept':'application/json', ...(method === 'POST' ? {'Content-Type':'application/json','X-CSRF-Token':csrf} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  } catch { throw new Error(t('networkError', '网络请求失败或登录状态已变更。请检查连接并刷新；若已提交操作，请核对服务器状态，勿盲目重复。')); }
  let data;
  try { data = await res.json(); } catch { throw new Error(format(t('invalidJsonError', '服务器未返回有效 JSON（HTTP {status}）。请重新登录或稍后刷新。'), { status: res.status })); }
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
    if (!expired) message(error.name === 'NotAllowedError' || error.name === 'AbortError' ? t('passkeyCancelledOrTimeout', 'Passkey 操作已取消或超时，未提交变更。请重新开始；不会降级为普通验证。') : (error.message || '操作失败，请刷新后重试。'), true);
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
  if (value === null || value === undefined || value === 0) return t('neverInvoked', '暂无记录');
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? t('unknown', '时间格式异常') : d.toLocaleString();
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
  status.textContent = !connected ? t('schwabReauth', 'Schwab 需重新授权') : soon ? t('schwabExpiringSoon', 'Schwab 授权即将到期') : t('schwabConnected', 'Schwab 已连接');
}
async function loadOverview() {
  try {
    const data = await api('/dashboard/api/overview');
    if (typeof data.schwabConnected !== 'boolean' || typeof data.tradingEnabled !== 'boolean') throw new Error('服务器连接状态格式异常。');
    requireCount(data.clientCount); requireCount(data.toolCallsCount); requireCount(data.passkeyCount); requireCount(data.legacyGrantCount);
    overview = data;
    updateOverviewStatus();
    $('trading-status-badge').className = 'badge ' + (data.tradingEnabled ? 'good' : 'neutral');
    $('trading-status-badge').textContent = data.tradingEnabled ? t('tradingEnabled', '交易总开关已开启') : t('tradingDisabled', '交易总开关已关闭');
    $('access-expiry').textContent = t('accessExpiry', 'Access 到期：') + date(data.schwabStatus?.accessExpiresAt);
    $('refresh-expiry').textContent = t('refreshExpiry', 'Refresh 到期：') + date(data.schwabStatus?.refreshExpiresAt);
    $('overview-counts').textContent = format(t('overviewCounts', '{clients} 个客户端 / {calls} 次调用 / {passkeys} 个 Passkey'), { clients: data.clientCount, calls: data.toolCallsCount, passkeys: data.passkeyCount }) + (data.legacyGrantCount ? format(t('legacyGrantNotice', '；{count} 条旧版 MCP 授权需在客户端重新授权'), { count: data.legacyGrantCount }) : '');
    $('stat-clients-count').textContent = data.clientCount;
    $('stat-total-calls').textContent = data.toolCallsCount;
    $('stat-passkeys-count').textContent = data.passkeyCount;
  } catch (error) {
    overview = null;
    $('schwab-status-badge').textContent = t('schwabReadFailed', '连接状态读取失败'); $('schwab-status-badge').className = 'badge bad';
    $('trading-status-badge').textContent = t('tradingUnknown', '交易开关状态未知'); $('trading-status-badge').className = 'badge warn';
    $('overview-counts').textContent = '概览读取失败'; $('access-expiry').textContent = t('accessExpiry', 'Access 到期：') + '未知'; $('refresh-expiry').textContent = t('refreshExpiry', 'Refresh 到期：') + '未知';
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
    $('clients-count').textContent = clients.length + (t('colClient') === 'Client / Redirect URI' ? ' clients' : ' 个客户端');
    if (!clients.length) tableMessage(body,6,t('noClients', '暂无已授权客户端。请在 MCP 客户端中发起 OAuth 授权。'));
    for (const client of clients) {
      const row = node('tr');
      const identity = node('td',null,'client-meta');
      identity.append(node('div',client.clientName || '未命名客户端','client-name'),node('code',client.clientId));
      const redirects = node('details',null,'redirects'); redirects.append(node('summary',(t('colClient') === 'Client / Redirect URI' ? 'Redirect URIs (' : '重定向 URI (') + requireArray(client.redirectUris).length + ')'));
      const uris = node('ul'); client.redirectUris.forEach(uri => uris.append(node('li',uri,'mono'))); redirects.append(uris); identity.append(redirects);
      const state = node('td'); state.append(badge(client.revoked ? t('revoked', '已撤销') : t('authorized', '已授权'),client.revoked ? 'bad' : 'good'));
      const permissionCell = node('td'); const permission = node('select',null,'permission');
      permission.dataset.action = ''; permission.setAttribute('aria-label',(client.clientName || client.clientId) + ' ' + t('colPermission', '权限等级'));
      [['read_only',t('permReadOnly', '只读')],['full_access',t('permFullAccess', '完整交易')]].forEach(([value,label]) => { const option = node('option',label); option.value = value; permission.append(option); });
      permission.value = client.permissionLevel; disabled(permission,!!client.revoked);
      permission.addEventListener('change', () => {
        const desired = permission.value; permission.value = client.permissionLevel;
        run(async () => {
          await api('/dashboard/api/clients/permission','POST',{clientId:client.clientId,permissionLevel:desired});
          await refreshAll(); message(t('permissionUpdated', '客户端权限已更新。后续 MCP 请求使用新权限。'));
        });
      });
      permissionCell.append(permission,node('span',t('permPolicyNote', '权限不会改变部署级交易总开关。'),'policy-note'));
      const advancedCell = node('td'); const toggleLabel = node('label',null,'toggle'); const toggle = node('input');
      toggle.type = 'checkbox'; toggle.checked = !!client.advancedSecurity; toggle.dataset.action = ''; toggle.setAttribute('aria-label',(client.clientName || client.clientId) + ' Advanced Security');
      disabled(toggle,!!client.revoked || !supportsPasskeys || (client.permissionLevel !== 'full_access' && !client.advancedSecurity));
      toggleLabel.append(toggle,node('span',client.advancedSecurity ? t('modeEnhanced', 'Passkey 增强') : t('modeStandard', '普通模式')));
      toggle.addEventListener('change', () => {
        const desired = toggle.checked; toggle.checked = !!client.advancedSecurity;
        run(async () => {
          const values = {clientId:client.clientId,advancedSecurity:desired};
          const challenge = await api('/dashboard/api/clients/advanced-security','POST',values);
          stageChallenge(challenge,(desired ? '开启' : '关闭') + ' Advanced Security',
            (client.clientName || client.clientId) + '：' + (desired ? '开启后，每笔受保护交易须由 Passkey 批准。' : '关闭后此客户端将使用普通交易确认。') + (challenge.registration ? ' 此操作将同时登记首个 Passkey。' : ''),
            response => api('/dashboard/api/clients/advanced-security','POST',{...values,challengeId:challenge.challengeId,response}), t('passkeyOperationSuccess', 'Advanced Security 策略已验证并更新。'));
        });
      });
      advancedCell.append(toggleLabel,node('span',format(t('policyVersion', '策略版本 v{version}'), { version: client.version }),'policy-note'));
      if (client.permissionLevel !== 'full_access' && !client.advancedSecurity) advancedCell.append(node('span',t('fullAccessOnlyNote', '仅完整访问可开启。'),'policy-note'));
      const times = node('td'); times.append(node('div',t('createdAt', '授权：') + date(client.createdAt),'timestamp'),node('div',t('lastInvocationAt', '最后调用：') + date(client.lastInvocationAt),'timestamp muted'));
      const actions = node('td'); actions.append(button(t('revokeBtn', '撤销授权'),async () => {
        if (!window.confirm(format(t('revokeConfirm', '撤销 {name} 的全部授权及 Token？此客户端需要重新授权才能连接。'), { name: client.clientName || client.clientId }))) return;
        await api('/dashboard/api/clients/revoke','POST',{clientId:client.clientId}); await refreshAll(); message(t('revokedSuccess', '客户端已撤销，全部旧 Token 已失效。'));
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
    if (!data.items.length) tableMessage(body,7,t('noAuditItems', '没有符合当前筛选条件的调用记录。'));
    for (const item of data.items) {
      const row = node('tr'); const state = node('td'); state.append(badge(item.status,item.status === 'SUCCESS' ? 'good' : 'bad'));
      const summary = node('td',null,'summary'); summary.append(node('div',item.parametersSummary || t('noSummary', '无参数摘要'),'mono'));
      if (item.errorCode || item.errorMessage) summary.append(node('div',[item.errorCode,item.errorMessage].filter(Boolean).join(' · '),'load-error'));
      row.append(node('td',date(item.createdAt),'timestamp'),node('td',item.clientId,'mono'),node('td',item.toolName,'mono'),state,node('td',item.durationMs + ' ms','timestamp'),summary,node('td',item.requestId,'mono request-id'));
      body.append(row);
    }
    $('audit-pagination-info').textContent = format(t('paginationInfo', '显示 {start}–{end} / 共 {total} 条'), { start: data.items.length ? auditOffset + 1 : 0, end: data.items.length ? auditOffset + data.items.length : 0, total: data.total });
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
    if (!credentials.length) list.append(node('li',t('noPasskeysRegistered', '尚未登记 Passkey。可在下方注册首个凭据，或在客户端开启 Advanced Security 时注册。'),'empty'));
    for (const credential of credentials) {
      const item = node('li',null,'credential'); const identity = node('div'); identity.append(node('h3',credential.name),node('code',credential.id,'credential-id'));
      const actions = node('div',null,'actions');
      actions.append(button(t('rename', '重命名'),async () => {
        const name = window.prompt(t('promptNewKeyName', '新的 Passkey 名称（1–80 字符）'),credential.name);
        if (name === null) return;
        const trimmed = name.trim(); if (!trimmed || trimmed.length > 80) throw new Error('Passkey 名称须为 1–80 字符。');
        const challenge = await securityOptions('rename',credential.id,trimmed);
        stageChallenge(challenge,'重命名 Passkey','将 “' + credential.name + '” 改为 “' + trimmed + '”。须验证已有 Passkey。',response => api('/security/api/verify','POST',{challengeId:challenge.challengeId,response}),'Passkey 已重命名。');
      },!supportsPasskeys));
      actions.append(button(t('delete', '删除'),async () => {
        if (!window.confirm(format(t('deleteConfirm', '删除 Passkey “{name}”？此操作须先验证已有 Passkey。'), { name: credential.name }))) return;
        const challenge = await securityOptions('delete',credential.id);
        stageChallenge(challenge,'删除 Passkey','验证已有 Passkey 后删除 “' + credential.name + '”。其他凭据不受影响。',response => api('/security/api/verify','POST',{challengeId:challenge.challengeId,response}),'Passkey 已删除。');
      },!supportsPasskeys || credentials.length <= 1,'danger'));
      if (credentials.length <= 1) actions.append(node('small',t('cannotDeleteLast', '最后一个凭据不可删除')));
      item.append(identity,actions); list.append(item);
    }
    $('passkeys-state').textContent = credentials.length ? format(t('ownerSharedCount', '{n} 个 owner 共享凭据'), { n: credentials.length }) : t('noPasskeyProtection', '尚未启用 Passkey 防护');
    $('add-passkey-btn').textContent = credentials.length ? t('addKeyWithVerify', '添加 Passkey · 先验证已有凭据') : t('registerFirstKey', '注册首个 Passkey');
    disabled($('add-passkey-btn'),!supportsPasskeys);
  } catch (error) {
    credentials = null; list.replaceChildren(node('li','Passkey 读取失败：' + error.message,'empty load-error')); $('passkeys-state').textContent = '凭据状态未知'; disabled($('add-passkey-btn'),true); throw error;
  }
}
async function loadPendingApprovals() {
  const container = $('pending-approvals-container');
  const countTag = $('pending-count-tag');
  const inboxBadge = $('inbox-badge');
  try {
    const data = await api('/dashboard/api/pending-approvals');
    const items = data.items || [];
    if (countTag) countTag.textContent = format(t('pendingCountTag', '{n} 待办'), { n: items.length });
    if (inboxBadge) {
      inboxBadge.textContent = String(items.length);
      inboxBadge.hidden = items.length === 0;
    }
    container.replaceChildren();
    if (!items.length) {
      container.append(node('p', t('noPending', '当前没有待 Passkey 核准的交易或授权请求。'), 'muted'));
      return;
    }
    for (const item of items) {
      const card = node('div', null, 'approval-item-card');
      card.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px;background:var(--surface-container);border-radius:var(--radius-sm);margin-bottom:8px;gap:12px;flex-wrap:wrap;';
      const info = node('div');
      const kindLabel = item.kind === 'trade' ? t('tradeProposalTag', '[交易提案]') : t('clientAuthTag', '[客户端授权]');
      const title = node('div', null);
      title.append(node('span', kindLabel + ' ', 'badge ' + (item.kind === 'trade' ? 'warning' : 'good')));
      title.append(node('strong', item.clientId, 'mono'));
      const timeInfo = node('div', new Date(item.createdAt).toLocaleTimeString() + ' · 截止: ' + new Date(item.expiresAt).toLocaleTimeString(), 'muted');
      timeInfo.style.fontSize = '11px';
      info.append(title, timeInfo);
      const link = node('a', t('proceedToApproval', '前往核准 →'), 'button primary compact');
      link.href = item.actionPath;
      card.append(info, link);
      container.append(card);
    }
  } catch (err) {
    container.replaceChildren(node('p', '读取待办失败: ' + err.message, 'empty load-error'));
  }
}
async function loadNotifications(offset = 0) {
  notificationsOffset = offset;
  const tbody = $('notifications-table-body');
  const unreadTag = $('notifications-unread-tag');
  const infoEl = $('notifications-pagination-info');
  try {
    const data = await api('/dashboard/api/notifications?limit=15&offset=' + offset);
    notificationsTotal = data.total;
    if (unreadTag) unreadTag.textContent = format(t('unreadCountTag', '{n} 未读'), { n: data.unreadCount });
    if (infoEl) infoEl.textContent = format(t('paginationInfo', '显示 {start}–{end} / 共 {total} 条'), { start: data.total ? offset + 1 : 0, end: Math.min(offset + 15, data.total), total: data.total });
    disabled($('notifications-prev-btn'), offset <= 0);
    disabled($('notifications-next-btn'), offset + 15 >= data.total);
    tbody.replaceChildren();
    if (!data.items.length) {
      tableMessage(tbody, 5, t('noNotifications', '暂无通知记录。'));
      return;
    }
    for (const item of data.items) {
      const tr = node('tr');
      if (!item.readAt) tr.style.fontWeight = '600';
      const timeTd = node('td', new Date(item.createdAt).toLocaleString(), 'mono');
      timeTd.style.fontSize = '11px';
      const typeTd = node('td');
      typeTd.append(node('span', item.type, 'badge'));
      const summaryTd = node('td', item.summary);
      const statusTd = node('td', item.readAt ? t('read', '已读') : t('unread', '未读'), item.readAt ? 'muted' : 'badge warning');
      const actionTd = node('td');
      if (item.actionPath) {
        const link = node('a', t('viewDetails', '查看详情 →'), 'card-action-link');
        link.href = item.actionPath;
        actionTd.append(link);
      } else if (!item.readAt) {
        actionTd.append(button(t('markAsRead', '标为已读'), async () => {
          await api('/dashboard/api/notifications/read', 'POST', { id: item.id });
          loadNotifications(notificationsOffset);
        }, false, 'compact'));
      }
      tr.append(timeTd, typeTd, summaryTd, statusTd, actionTd);
      tbody.append(tr);
    }
  } catch (err) {
    tableMessage(tbody, 5, '读取通知失败: ' + err.message, true);
  }
}
async function loadHighlightedNotification() {
  const id = document.querySelector('meta[name="highlight-notification"]').content;
  if (!id) return;
  const banner = $('notification-detail-banner');
  banner.style.display = '';
  banner.replaceChildren(node('p', '正在读取所选通知…'));
  try {
    const item = await api('/dashboard/api/notifications/' + encodeURIComponent(id));
    banner.replaceChildren(node('strong', item.summary), node('p', item.type + ' · ' + new Date(item.createdAt).toLocaleString(), 'muted'));
    if (item.actionPath) {
      const link = node('a', t('proceedToApproval', '前往核准 →'), 'card-action-link');
      link.href = item.actionPath;
      banner.append(link);
    }
    if (!item.readAt) {
      await api('/dashboard/api/notifications/read', 'POST', { id: item.id });
      await loadNotifications(notificationsOffset);
    }
  } catch (err) {
    banner.replaceChildren(node('p', '所选通知不存在或读取失败：' + err.message, 'load-error'));
  }
}
// Browser push promises can remain pending while the push service is unreachable.
// Bound each wait; a late subscription must never continue into server registration.
let pendingPushSubscription = null;
async function pushWait(promise, step, timeoutMs = 20000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(step + '超时。请检查网络后重试；Chrome 还需能连接 Google 推送服务。')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
function pushProgress(text, error = false) {
  const status = $('push-action-status');
  status.textContent = text;
  status.className = error ? 'load-error' : 'muted';
}
async function pushApi(path, method = 'GET', body) {
  return pushWait(api(path, method, body), '推送设备服务请求');
}
async function pushRegistration() {
  if (!('serviceWorker' in navigator)) throw new Error('此浏览器不支持 Service Worker。');
  const reg = await pushWait(navigator.serviceWorker.getRegistration(), '读取 Service Worker');
  if (!reg?.active || !reg.pushManager) throw new Error('推送服务尚未就绪，请稍后刷新重试。');
  return reg;
}
async function currentPushDevice() {
  const reg = await pushRegistration();
  const sub = await pushWait(reg.pushManager.getSubscription(), '读取本机推送订阅');
  const data = sub ? await pushApi('/dashboard/api/push/subscription', 'POST', { endpoint: sub.endpoint }) : null;
  const device = data?.subscription;
  return { reg, sub, device };
}
function renderNotificationPermission() {
  const badge = $('push-permission-badge');
  const permission = 'Notification' in window ? Notification.permission : null;
  badge.textContent = permission === 'granted' ? t('permGranted', '通知权限：已允许') : permission === 'denied' ? t('permDenied', '通知权限：已禁止') : permission === 'default' ? t('permDefault', '通知权限：未授权') : t('permUnsupported', '通知权限：不支持');
  badge.className = 'badge ' + (permission === 'granted' ? 'good' : 'neutral');
  return permission;
}
async function loadPushSettings() {
  const badge = $('push-status-badge');
  const toggleBtn = $('push-toggle-btn');
  const testBtn = $('push-test-btn');
  toggleBtn.dataset.pushActive = 'false';
  toggleBtn.textContent = t('enablePushBtn', '开启本机通知推送');
  toggleBtn.className = 'button primary';
  const devicesBody = $('push-devices-table-body');
  disabled(toggleBtn, true); disabled(testBtn, true);
  const supported = ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
  renderNotificationPermission();
  if (!supported) {
    if (badge) { badge.textContent = t('pushBadgeUnsupported', '环境不支持'); badge.className = 'badge neutral'; }
    disabled(toggleBtn, true); disabled(testBtn, true);
    return;
  }
  try {
    const { device } = await currentPushDevice();
    const permission = renderNotificationPermission();
    if (permission === 'denied') {
      if (badge) { badge.textContent = t('pushBadgePermDenied', '通知权限已禁止'); badge.className = 'badge neutral'; }
      disabled(toggleBtn, true); disabled(testBtn, true);
    } else if (permission === 'granted' && device?.active) {
      if (badge) { badge.textContent = t('pushBadgeEnabled', '本机已开启推送'); badge.className = 'badge good'; }
      toggleBtn.dataset.pushActive = 'true';
      toggleBtn.textContent = t('disablePushBtn', '停用本机推送');
      toggleBtn.className = 'button danger';
      disabled(toggleBtn, false); disabled(testBtn, false);
    } else {
      if (badge) { badge.textContent = permission === 'granted' ? t('pushBadgePermGrantedUnsubscribed', '权限已允许，尚未开启推送') : t('pushBadgeDisabled', '未开启推送'); badge.className = 'badge warning'; }
      disabled(toggleBtn, false); disabled(testBtn, true);
    }
    const devData = await pushApi('/dashboard/api/push/subscriptions');
    const items = devData.items || [];
    devicesBody.replaceChildren();
    if (!items.length) {
      tableMessage(devicesBody, 5, '暂无已登记的推送设备。');
      return;
    }
    for (const dev of items) {
      const tr = node('tr');
      tr.append(
        node('td', dev.id.slice(0, 8) + '…', 'mono'),
        node('td', dev.label),
        node('td', dev.active ? t('active', '活跃') : t('pushBadgeDisabled', '已停用'), 'badge ' + (dev.active ? 'good' : 'neutral')),
        node('td', new Date(dev.createdAt).toLocaleDateString(), 'mono'),
        node('td')
      );
      if (dev.active) {
        tr.lastChild.append(button('解绑', async () => {
          if (!confirm(format(t('unsubscribeDeviceConfirm', '确定解绑设备 “{name}”？该设备将不再接收新提醒。'), { name: dev.label }))) return;
          await api('/dashboard/api/push/unsubscribe', 'POST', { id: dev.id });
          loadPushSettings();
        }, false, 'danger compact'));
      }
      devicesBody.append(tr);
    }
  } catch (err) {
    renderNotificationPermission();
    if (badge) { badge.textContent = t('pushBadgeServiceUnavailable', '推送暂不可用') + '：' + err.message; badge.className = 'badge neutral'; }
    disabled(toggleBtn, Notification.permission === 'denied'); disabled(testBtn, true);
  } finally {
    syncControls();
  }
}
function checkPwaDisplayMode() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const badge = $('pwa-install-badge');
  const statusEl = $('pwa-install-status');
  const iosGuideEl = $('pwa-ios-guide');
  const installBtn = $('pwa-install-btn');
  if (isStandalone) {
    if (badge) { badge.textContent = 'STANDALONE'; badge.className = 'badge good'; }
    if (statusEl) statusEl.textContent = t('pwaStandalone', '已作为独立应用运行 (独立全屏运行模式)');
    if (iosGuideEl) iosGuideEl.style.display = 'none';
    if (installBtn) installBtn.hidden = true;
  } else {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIos) {
      if (badge) { badge.textContent = t('pwaBrowser', '浏览器运行中'); badge.className = 'badge warning'; }
      if (statusEl) statusEl.textContent = '当前通过 Safari 打开。建议添加至主屏幕以获得完整 PWA 与锁屏推送能力。';
      if (iosGuideEl) iosGuideEl.style.display = 'block';
      if (installBtn) installBtn.hidden = true;
    } else {
      if (badge) { badge.textContent = t('pwaBrowser', '浏览器标签页模式'); badge.className = 'badge neutral'; }
      if (statusEl) statusEl.textContent = '可在支持的浏览器（如 Chrome / Edge）中安装为独立桌面应用。';
      if (iosGuideEl) iosGuideEl.style.display = 'none';
    }
  }
}
async function refreshAll() {
  const results = await Promise.allSettled([
    loadOverview(),
    loadClients(),
    loadAudit(),
    loadPasskeys(),
    loadPendingApprovals(),
    loadNotifications(notificationsOffset),
    loadPushSettings(),
  ]);
  const failures = results.filter(result => result.status === 'rejected');
  $('last-refresh').textContent = (failures.length ? '最近刷新（部分失败）：' : '最近刷新：') + new Date().toLocaleTimeString();
  syncControls();
  checkPwaDisplayMode();
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
$('inbox-refresh-btn')?.addEventListener('click',() => run(async () => { await Promise.all([loadPendingApprovals(), loadNotifications(notificationsOffset)]); message('待办与通知已刷新。'); }));
$('settings-refresh-btn')?.addEventListener('click',() => run(async () => { await loadPushSettings(); message('设备状态已刷新。'); }));
$('notifications-prev-btn')?.addEventListener('click',() => run(async () => { notificationsOffset = Math.max(0, notificationsOffset - 15); await loadNotifications(notificationsOffset); }));
$('notifications-next-btn')?.addEventListener('click',() => run(async () => { if (notificationsOffset + 15 < notificationsTotal) { notificationsOffset += 15; await loadNotifications(notificationsOffset); } }));
$('push-toggle-btn')?.addEventListener('click', () => run(async () => {
  try {
    if ($('push-toggle-btn').dataset.pushActive === 'true') {
      pushProgress(t('pushBadgePendingUnsubscribe', '正在停用本机推送…'));
      const { sub, device } = await currentPushDevice();
      if (device?.active) await api('/dashboard/api/push/unsubscribe', 'POST', { id: device.id });
      if (sub) await pushWait(sub.unsubscribe(), '停用本机推送订阅');
      pushProgress(t('disablePushSuccess', '已停用本机推送通知。'));
      message(t('disablePushSuccess', '已停用本机推送通知。'));
      return;
    }
    pushProgress(t('permChecking', '正在检查通知权限…'));
    const perm = Notification.permission === 'granted' ? 'granted' : await pushWait(Notification.requestPermission(), '等待通知权限', 60000);
    if (perm !== 'granted') throw new Error('未授权通知权限，无法开启推送。');
    renderNotificationPermission();
    pushProgress('正在读取推送配置…');
    const config = await pushApi('/dashboard/api/push/config');
    const reg = await pushRegistration();
    let sub = await pushWait(reg.pushManager.getSubscription(), '读取本机推送订阅');
    if (!sub) {
      pushProgress(t('connectingPushService', '正在连接浏览器推送服务（最长等待 20 秒）…'));
      // Reuse an in-flight browser operation when retrying after a timeout.
      if (!pendingPushSubscription) {
        pendingPushSubscription = reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: dec(config.publicKey) });
        pendingPushSubscription.then(() => { pendingPushSubscription = null; }, () => { pendingPushSubscription = null; });
      }
      sub = await pushWait(pendingPushSubscription, '连接浏览器推送服务');
    }
    const subJson = sub.toJSON();
    pushProgress(t('pushBadgePendingRegistration', '正在登记本机推送设备…'));
    await pushApi('/dashboard/api/push/subscribe', 'POST', {
      subscription: { endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: { p256dh: subJson.keys.p256dh, auth: subJson.keys.auth } },
      label: $('push-device-label').value.trim() || (navigator.userAgent.includes('iPhone') ? 'iPhone' : '桌面 Chrome'),
    });
    pushProgress(t('enablePushSuccess', '已成功开启本机推送！'));
    message(t('enablePushSuccess', '已成功开启本机推送！'));
  } catch (error) {
    const detail = ($('push-toggle-btn').dataset.pushActive === 'true' ? t('disablePushFailed', '停用通知失败：') : '开启推送失败：') + (error.message || '请刷新后重试。');
    pushProgress(detail, true);
    message(detail, true);
  } finally { await loadPushSettings(); }
}));
$('push-test-btn')?.addEventListener('click', async () => {
  try {
    const { device } = await currentPushDevice();
    if (!device?.active) { alert('未找到活跃的本机推送设备，请先开启推送。'); return; }
    await api('/dashboard/api/push/test', 'POST', { id: device.id });
    alert(t('testPushSent', '测试通知已发送！请观察设备通知栏。'));
  } catch (err) { alert(t('testPushFailed', '发送测试通知失败: ') + err.message); }
});
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); deferredPrompt = e;
  const btn = $('pwa-install-btn'); if (btn) btn.hidden = false;
});
$('pwa-install-btn')?.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('pwa-install-btn').hidden = true;
    checkPwaDisplayMode();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !expired) {
    loadPendingApprovals();
    loadNotifications(notificationsOffset);
    refreshPushSettings();
  }
});
function refreshPushSettings() {
  if (!expired && !busy) void loadPushSettings();
}
window.addEventListener('focus', refreshPushSettings);
// Permissions API is optional; focus/visibility remain the fallback on unsupported browsers.
if (navigator.permissions?.query && 'Notification' in window) {
  navigator.permissions.query({ name: 'notifications' }).then(status => {
    status.addEventListener('change', refreshPushSettings);
  }).catch(() => {});
}
setInterval(() => {
  if (document.visibilityState === 'visible' && !expired && !busy) {
    loadPendingApprovals();
    loadNotifications(notificationsOffset);
  }
}, 30000);
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'PUSH_RECEIVED') {
    loadPendingApprovals();
    loadNotifications(notificationsOffset);
  }
});
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
run(async () => { await refreshAll(); await loadHighlightedNotification(); });
})();
`;

export function renderDashboardPage(props: DashboardPageProps) {
  const { session, appVersion, allowedUserId, highlightNotificationId } = props;
  const lang = resolveLang(props.lang);
  const dict = getDictionary(lang);
  const d = dict.dashboard;
  const c = dict.common;

  return html`<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="csrf" content="${session.csrf}">
  <meta name="session-expires" content="${session.expiresAt}">
  <meta name="highlight-notification" content="${highlightNotificationId ?? ""}">
  <title>${d.pageTitle}</title>
  ${FAVICON_LINK}
  ${PWA_HEAD_TAGS}
  <style>${raw(DASHBOARD_STYLES)}</style>
</head>
<body>
${raw(BACKGROUND_SVG)}
<a class="skip" href="#dashboard-main">${d.skipLink}</a>
<div class="shell">
  <div class="telemetry-bar-top" role="region" aria-label="系统运行遥测">
    <div class="telemetry-node">
      <span class="status-pulse-dot" aria-hidden="true"></span>
      <span>&gt;_ SCHWAB_MCP // CORE_SYS MCP NODE-01 [EDGE ENCLAVE]</span>
    </div>
    <div class="telemetry-chips">
      <span class="chip-badge">TLS 1.3 / mTLS ENCLAVE</span>
      <span class="chip-badge">STREAMABLE HTTP</span>
      <span class="chip-badge">SQLITE DO</span>
      <span class="chip-badge">RFC 7636 S256</span>
    </div>
  </div>
  <header class="topline">
    <div class="brand">
      ${raw(BRAND_LOGO_SVG)}
      <div>
        <div class="eyebrow">&gt;_ SCHWAB MCP // v${appVersion}</div>
        <h1>${d.sysTitle}</h1>
        <p>${d.sysSubtitle}</p>
      </div>
    </div>
    <div class="actions">
      <div class="owner">GitHub owner <strong class="mono">${allowedUserId}</strong> <span class="badge good" style="font-size:10px;padding:1px 5px">${c.verified}</span><br><span id="last-refresh">${d.notRefreshed}</span></div>
      ${raw(renderLangDropdown(lang))}
      <button id="refresh-all-btn" class="button primary" data-action type="button">&#x21bb; ${d.refreshAllBtn}</button>
    </div>
  </header>
  <section class="status-deck" aria-label="服务与会话状态">
    <div class="status-cell card-schwab">
      <div class="status-cell-header">
        <span class="label">${d.schwabLink}</span>
        <span id="schwab-status-badge" class="badge neutral">${d.schwabReading}</span>
      </div>
      <div class="status-cell-body">
        <p id="access-expiry" class="telemetry-stat">${d.accessExpiry}${c.loading}</p>
        <p id="refresh-expiry" class="telemetry-stat">${d.refreshExpiry}${c.loading}</p>
        <p class="telemetry-stat">${d.securityProtocol}</p>
      </div>
      <div class="status-cell-footer">
        <a class="card-action-link" href="/auth/schwab/connect">${d.reconnectSchwab}</a>
      </div>
    </div>
    <div class="status-cell card-runtime">
      <div class="status-cell-header">
        <span class="label">${d.runtimeEngine}</span>
        <span id="trading-status-badge" class="badge neutral">${d.tradingReading}</span>
      </div>
      <div class="status-cell-body">
        <p>${d.tradingSwitchDesc}</p>
        <p id="overview-counts" class="telemetry-stat">${d.overviewReading}</p>
        <p class="telemetry-stat">安全策略：IMMUTABLE_ENCLAVE</p>
      </div>
    </div>
    <div class="status-cell card-session">
      <div class="status-cell-header">
        <span class="label">${d.browserEnclave}</span>
        <span id="session-state" class="badge neutral">${d.sessionState}</span>
      </div>
      <div class="status-cell-body">
        <p>${d.sessionDesc}</p>
        <p class="telemetry-stat">沙箱状态：EPHEMERAL_ISOLATION</p>
      </div>
      <div class="status-cell-footer">
        <a class="card-action-link" href="/security">${d.securityCenter}</a>
        <a class="card-action-link secondary" href="/dashboard/login">${d.reloginRenew}</a>
      </div>
    </div>
  </section>
  <div id="global-msg" class="message" role="status" aria-live="polite" aria-atomic="true" hidden></div>
  <p id="session-login" class="session-link" hidden><a class="button primary" href="/dashboard/login">${d.sessionReloginBtn}</a></p>
  <p id="webauthn-warning" class="support-warning" style="margin-top:16px" hidden>${d.webauthnUnsupported}</p>
  <main id="dashboard-main" tabindex="-1" aria-busy="false">
    <div class="tabs" role="tablist" aria-label="控制面板模块">
      <button id="inbox-tab" class="tab" role="tab" aria-selected="${Boolean(highlightNotificationId)}" aria-controls="tab-inbox" tabindex="${highlightNotificationId ? "0" : "-1"}" type="button"><span>[01/INBOX]</span> ${d.tabInbox} <span id="inbox-badge" class="badge warning" style="font-size:10px;padding:1px 5px" hidden>0</span></button>
      <button id="clients-tab" class="tab" role="tab" aria-selected="${highlightNotificationId ? "false" : "true"}" aria-controls="tab-clients" tabindex="${highlightNotificationId ? "-1" : "0"}" type="button"><span>[02/ACCESS]</span> ${d.tabClients}</button>
      <button id="audit-tab" class="tab" role="tab" aria-selected="false" aria-controls="tab-audit" tabindex="-1" type="button"><span>[03/ACTIVITY]</span> ${d.tabAudit}</button>
      <button id="passkeys-tab" class="tab" role="tab" aria-selected="false" aria-controls="tab-passkeys" tabindex="-1" type="button"><span>[04/SECURITY]</span> ${d.tabPasskeys}</button>
      <button id="settings-tab" class="tab" role="tab" aria-selected="false" aria-controls="tab-settings" tabindex="-1" type="button"><span>[05/DEVICE]</span> ${d.tabSettings}</button>
    </div>
    <section id="tab-inbox" class="panel" role="tabpanel" aria-labelledby="inbox-tab" tabindex="0" ${highlightNotificationId ? "" : "hidden"}>
      <div class="section-head">
        <div>
          <h2>${d.inboxTitle}</h2>
          <p>${d.inboxSubtitle}</p>
        </div>
        <button id="inbox-refresh-btn" class="button" data-action type="button">&#x21bb; ${d.refreshInbox}</button>
      </div>
      <div class="panel-body" style="display:flex;flex-direction:column;gap:16px;">
        <div style="background:var(--surface-lowest);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="font-size:13px;color:var(--text-bright);display:flex;align-items:center;gap:8px;">
              <span>${d.pendingApprovals}</span>
              <span id="pending-count-tag" class="badge neutral" style="font-size:10px">${formatString(d.pendingCountTag, { n: 0 })}</span>
            </h3>
          </div>
          <div id="pending-approvals-container">
            <p class="muted" style="font-size:12px;">${d.checkingPending}</p>
          </div>
        </div>
        <div style="background:var(--surface-lowest);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="font-size:13px;color:var(--text-bright);">${d.notificationHistory}</h3>
            <span id="notifications-unread-tag" class="badge neutral" style="font-size:10px">${formatString(d.unreadCountTag, { n: 0 })}</span>
          </div>
          <div id="notification-detail-banner" class="security-notice" style="display:none;margin-bottom:12px;"></div>
          <div class="table-scroll" role="region" aria-label="通知列表，可横向滚动" tabindex="0">
            <table id="notifications-table">
              <thead>
                <tr>
                  <th scope="col">${d.colTime}</th>
                  <th scope="col">${d.colType}</th>
                  <th scope="col">${d.colSummary}</th>
                  <th scope="col">${d.colStatus}</th>
                  <th scope="col">${d.colAction}</th>
                </tr>
              </thead>
              <tbody id="notifications-table-body">
                <tr><td colspan="5" class="empty">${d.loadingNotifications}</td></tr>
              </tbody>
            </table>
          </div>
          <div class="pagination" style="margin-top:12px;">
            <span id="notifications-pagination-info" role="status">${c.loading}</span>
            <div class="actions">
              <button id="notifications-prev-btn" class="button" data-action data-disabled="true" type="button" disabled>${c.prevPage}</button>
              <button id="notifications-next-btn" class="button" data-action data-disabled="true" type="button" disabled>${c.nextPage}</button>
            </div>
          </div>
        </div>
      </div>
    </section>
    <section id="tab-clients" class="panel" role="tabpanel" aria-labelledby="clients-tab" tabindex="0" ${highlightNotificationId ? "hidden" : ""}>
      <div class="section-head">
        <div>
          <h2>${d.clientsTitle}</h2>
          <p>${d.clientsSubtitle}</p>
        </div>
        <button id="clients-refresh-btn" class="button" data-action type="button">&#x21bb; ${d.refreshClients}</button>
      </div>
      <div class="table-scroll" role="region" aria-label="客户端列表，可横向滚动" tabindex="0">
        <table id="clients-table">
          <caption id="clients-count">${c.loading}</caption>
          <thead>
            <tr>
              <th scope="col">${d.colClient}</th>
              <th scope="col">${d.colStatus}</th>
              <th scope="col">${d.colPermission}</th>
              <th scope="col">${d.colAdvancedSecurity}</th>
              <th scope="col">${d.colTimestamps}</th>
              <th scope="col">${d.colActions}</th>
            </tr>
          </thead>
          <tbody id="clients-table-body">
            <tr><td colspan="6" class="empty">${c.loading}</td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section id="tab-audit" class="panel" role="tabpanel" aria-labelledby="audit-tab" tabindex="0" hidden>
      <div class="section-head">
        <div>
          <h2>${d.auditTitle}</h2>
          <p>${d.auditSubtitle}</p>
        </div>
        <button id="audit-refresh-btn" class="button" data-action type="button">&#x21bb; ${d.refreshAudit}</button>
      </div>
      <div class="stats" aria-label="审计统计">
        <div class="stat"><span class="label">${d.statMatchedCalls}</span><div id="audit-total-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statSuccessRate}</span><div id="audit-success-rate" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statSuccess}</span><div id="audit-success-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statError}</span><div id="audit-error-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statActive24h}</span><div id="audit-active24h" class="stat-value">—</div></div>
      </div>
      <form id="audit-filter-form" class="filters">
        <label class="field" for="audit-filter-client">${d.filterClientLabel}<input id="audit-filter-client" data-action type="text" placeholder="${d.filterClientPlaceholder}" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="audit-filter-tool">${d.filterToolLabel}<input id="audit-filter-tool" data-action type="text" placeholder="${d.filterToolPlaceholder}" autocomplete="off" spellcheck="false"></label>
        <label class="field" for="audit-filter-status">${d.filterStatusLabel}<select id="audit-filter-status" data-action><option value="">${d.filterAllStatus}</option><option value="SUCCESS">${d.filterSuccess}</option><option value="ERROR">${d.filterError}</option></select></label>
        <div class="actions"><button class="button primary" data-action type="submit">${d.applyFilter}</button><button id="audit-clear-btn" class="button" data-action type="button">${d.clearFilter}</button></div>
      </form>
      <div class="table-scroll" role="region" aria-label="调用日志，可横向滚动" tabindex="0">
        <table id="audit-table">
          <thead>
            <tr>
              <th scope="col">${d.colTime}</th>
              <th scope="col">Client ID</th>
              <th scope="col">${d.colTool}</th>
              <th scope="col">${d.colStatus}</th>
              <th scope="col">${d.colDuration}</th>
              <th scope="col">${d.colSummaryParams}</th>
              <th scope="col">${d.colRequestId}</th>
            </tr>
          </thead>
          <tbody id="audit-table-body">
            <tr><td colspan="7" class="empty">${c.loading}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="audit-pagination-info" role="status">${c.loading}</span>
        <div class="actions">
          <button id="audit-prev-btn" class="button" data-action data-disabled="true" type="button" disabled>${c.prevPage}</button>
          <button id="audit-next-btn" class="button" data-action data-disabled="true" type="button" disabled>${c.nextPage}</button>
        </div>
      </div>
    </section>
    <section id="tab-passkeys" class="panel" role="tabpanel" aria-labelledby="passkeys-tab" tabindex="0" hidden>
      <div class="section-head">
        <div>
          <h2>${d.passkeysTitle}</h2>
          <p>${d.passkeysSubtitle}</p>
        </div>
        <button id="passkeys-refresh-btn" class="button" data-action type="button">&#x21bb; ${d.refreshPasskeys}</button>
      </div>
      <div class="stats overview-stats" aria-label="全局概览">
        <div class="stat"><span class="label">${d.statClientsCount}</span><div id="stat-clients-count" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statTotalCalls}</span><div id="stat-total-calls" class="stat-value">—</div></div>
        <div class="stat"><span class="label">${d.statPasskeysCount}</span><div id="stat-passkeys-count" class="stat-value">—</div></div>
      </div>
      <div class="panel-body">
        <h3 id="passkeys-state">${c.loading}</h3>
        <ul id="passkeys-list" class="credentials"><li class="empty">${c.loading}</li></ul>
        <form id="add-passkey-form" class="add-passkey">
          <label class="field" for="credential-name">${d.addKeyLabel}<input id="credential-name" data-action type="text" maxlength="80" required value="${d.addKeyDefaultValue}" autocomplete="off"></label>
          <button id="add-passkey-btn" class="button primary" data-action data-disabled="true" type="submit" disabled>+ ${d.addKeyWithVerify}</button>
        </form>
        <p class="muted" style="font-size:12px;margin-top:10px">${d.addKeyStepHint}</p>
        <div class="recovery">
          <p>${d.recoveryNotice}</p>
          <a class="button danger" href="/security/recover">${d.disasterRecoveryBtn}</a>
        </div>
      </div>
    </section>
    <section id="tab-settings" class="panel" role="tabpanel" aria-labelledby="settings-tab" tabindex="0" hidden>
      <div class="section-head">
        <div>
          <h2>${d.settingsTitle}</h2>
          <p>${d.settingsSubtitle}</p>
        </div>
        <button id="settings-refresh-btn" class="button" data-action type="button">&#x21bb; ${d.refreshSettings}</button>
      </div>
      <div class="panel-body" style="display:flex;flex-direction:column;gap:16px;">
        <div style="background:var(--surface-lowest);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="font-size:13px;color:var(--text-bright);">${d.pushTitle}</h3>
            <span id="push-status-badge" class="badge neutral">${d.pushBadgeChecking}</span>
          </div>
          <p style="margin-bottom:10px;"><span id="push-permission-badge" class="badge neutral" role="status">${d.permChecking}</span></p>
          <p class="muted" style="font-size:12px;margin-bottom:12px;">${d.pushHint1}</p>
          <p class="muted" style="font-size:12px;margin-bottom:12px;">${d.pushHint2}</p>
          <p><label for="push-device-label">${d.deviceLabel}</label> <input id="push-device-label" type="text" maxlength="80" placeholder="${d.devicePlaceholder}"></p>
          <div id="push-action-buttons" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
            <button id="push-toggle-btn" class="button primary" data-action data-disabled="true" type="button" disabled>${d.enablePushBtn}</button>
            <button id="push-test-btn" class="button" data-action data-disabled="true" type="button" disabled>${d.sendTestBtn}</button>
          </div>
          <p id="push-action-status" class="muted" role="status" aria-live="polite"></p>
          <h4 style="font-size:12px;color:var(--text);margin-bottom:8px;text-transform:uppercase;">${d.registeredDevices}</h4>
          <div class="table-scroll" role="region" aria-label="推送设备列表" tabindex="0">
            <table id="push-devices-table">
              <thead>
                <tr>
                  <th scope="col">${d.colDeviceId}</th>
                  <th scope="col">${d.colDeviceName}</th>
                  <th scope="col">${c.status}</th>
                  <th scope="col">${d.colDeviceTime}</th>
                  <th scope="col">${c.action}</th>
                </tr>
              </thead>
              <tbody id="push-devices-table-body">
                <tr><td colspan="5" class="empty">${c.loading}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div style="background:var(--surface-lowest);border:1px solid var(--outline-variant);border-radius:var(--radius-md);padding:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="font-size:13px;color:var(--text-bright);">${d.pwaTitle}</h3>
            <span id="pwa-install-badge" class="badge neutral">${d.pwaChecking}</span>
          </div>
          <div id="pwa-install-container">
            <p id="pwa-install-status" class="muted" style="font-size:12px;margin-bottom:12px;">${c.loading}</p>
            <button id="pwa-install-btn" class="button primary" type="button" hidden>${d.pwaInstallBtn}</button>
            <div id="pwa-ios-guide" class="security-notice" style="display:none;margin-top:10px;">
              <div style="font-weight:600;margin-bottom:4px;">${d.pwaIosGuideTitle}</div>
              <ol style="margin-left:20px;line-height:1.6;font-size:12px;">
                <li>${d.pwaIosStep1}</li>
                <li>${d.pwaIosStep2}</li>
                <li>${d.pwaIosStep3}</li>
                <li>${d.pwaIosStep4}</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <footer class="footer">
    <div class="footer-left">
      <span>${d.footerStatus} v${appVersion}</span>
      <span>&bull;</span>
      <span>WORKERS / SQLITE / WEBAUTHN</span>
    </div>
    <div class="footer-right">
      <span>${d.footerSecurity}</span>
    </div>
  </footer>
</div>
<dialog id="passkey-dialog" aria-labelledby="ceremony-title" aria-describedby="ceremony-description ceremony-state">
  <h2 id="ceremony-title">${d.dialogTitle}</h2><p id="ceremony-description"></p><p id="ceremony-state" role="status" aria-live="polite"></p>
  <div class="actions"><button id="ceremony-cancel" class="button" data-action type="button">${d.dialogCancel}</button><button id="ceremony-submit" class="button primary" data-action type="button">${d.dialogConfirm}</button></div>
</dialog>
<script>
globalThis.__I18N__ = ${raw(JSON.stringify(getDashboardClientI18n(lang)))};
${raw(DASHBOARD_SCRIPT)}
</script>
<script>document.addEventListener('click',e=>{if(!e.target.closest('.lang-dropdown'))document.querySelectorAll('.lang-dropdown[open]').forEach(d=>d.removeAttribute('open'));});</script>
${PWA_SERVICE_WORKER_SCRIPT}
</body>
</html>`;
}
