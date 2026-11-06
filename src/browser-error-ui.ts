import { html, raw } from "hono/html";
import { COMMON_STYLES, FAVICON_LINK } from "./auth-ui";
import { browserErrorMessage } from "./browser-errors";
import { getDictionary, type SupportedLang } from "./i18n";

export function renderBrowserErrorPage(code: unknown, requestId: string, lang: SupportedLang) {
  const dict = getDictionary(lang);
  return html`<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINK}<title>${dict.security.errorPageTitle} · Schwab MCP</title><style>${raw(COMMON_STYLES)}</style></head>
<body><main class="main-wrapper"><h1 class="page-title">${dict.security.errorPageTitle}</h1>
<p role="alert">${browserErrorMessage(code, lang)}</p>
<p>${dict.security.requestIdLabel}: <code>${requestId}</code></p>
<p><a href="/dashboard?lang=${lang}">${dict.common.backToDashboard}</a></p>
${code === "BROWSER_AUTH_REQUIRED" ? html`<p><a href="/dashboard/login?lang=${lang}">${dict.security.scriptRelogin}</a></p>` : ""}
</main></body></html>`;
}
