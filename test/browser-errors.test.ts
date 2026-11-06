import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthHandler } from "../src/auth";
import { renderBrowserErrorPage } from "../src/browser-error-ui";
import type { AppEnv } from "../src/env";
import { getDictionary, type SupportedLang } from "../src/i18n";

const origin = "https://example.com";
const session = { expiresAt: Date.now() + 900_000, csrf: "test", credentialVersion: 1, recovery: false };

function setup(reply: (url: string) => Response | Promise<Response>) {
  return {
    ...env,
    BROWSER_AUTH_RATE_LIMITER: { limit: () => Promise.resolve({ success: true }) },
    SCHWAB_VAULT: {
      idFromName: () => "test",
      get: () => ({ fetch: (url: string) => reply(url) }),
    },
  } as unknown as AppEnv;
}

function call(appEnv: AppEnv, path: string, lang: SupportedLang = "zh-CN", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Cookie")) headers.set("Cookie", `__Host-schwab-security=test; schwab_lang=${lang}`);
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", "192.0.2.10");
  return AuthHandler.request(origin + path, {
    ...init,
    headers,
  }, appEnv);
}

afterEach(() => vi.restoreAllMocks());

describe.each(["zh-CN", "en-US"] as const)("browser navigation errors in %s", lang => {
  it.each(["/dashboard", "/dashboard/notifications/test", "/security", "/security/authorizations/test"])("renders %s session outages as safe HTML", async path => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const appEnv = setup(() => { throw new Error("private-storage-detail"); });
    const response = await call(appEnv, path, lang);
    expect(response.status).toBe(503);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    const page = await response.text();
    expect(page).toContain(`lang="${lang}"`);
    expect(page).toContain(`href="/dashboard?lang=${lang}"`);
    expect(page).toContain(getDictionary(lang).browserErrors.UPSTREAM_UNAVAILABLE);
    expect(page).not.toContain("private-storage-detail");
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-storage-detail");
    expect(response.headers.get("Location")).toBeNull();
  });

  it.each([
    ["/auth/github/callback", "GET"], ["/auth/schwab/callback", "GET"],
    ["/authorize/approve", "POST"], ["/authorize/accounts", "POST"],
    ["/authorize", "GET"],
  ])("localizes invalid %s navigation and preserves its status", async (path, method) => {
    const response = await call(setup(() => Response.json({})), path, lang, { method });
    expect(response.status).toBe(method === "POST" && path === "/authorize/accounts" ? 403 : 400);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    const page = await response.text();
    expect(page).toContain(getDictionary(lang).security.errorPageTitle);
    expect(page).toContain(getDictionary(lang).common.backToDashboard);
  });

  it("does not expose JSON on a dashboard origin rejection", async () => {
    const appEnv = setup(() => Response.json({}));
    const response = await AuthHandler.request(`https://invalid.example/dashboard?lang=${lang}`, {}, appEnv);
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await response.text()).toContain(getDictionary(lang).browserErrors.SECURITY_VERIFICATION_FAILED);
  });

  it("localizes missing proposals without claiming success", async () => {
    const appEnv = setup(url => url.endsWith("/session")
      ? Response.json({ session, credentials: [] })
      : Response.json({ error: { code: "SECURITY_VERIFICATION_FAILED", message: "private-error", requestId: "test-id" } }, { status: 403 }));
    const response = await call(appEnv, "/security/approvals/missing", lang);
    expect(response.status).toBe(403);
    const page = await response.text();
    expect(page).toContain(getDictionary(lang).browserErrors.SECURITY_VERIFICATION_FAILED);
    expect(page).not.toContain("private-error");
  });
});

it("keeps API authentication errors as JSON regardless of Accept", async () => {
  const response = await AuthHandler.request(origin + "/dashboard/api/session", { headers: { Accept: "text/html" } }, setup(() => Response.json({})));
  expect(response.status).toBe(403);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ error: { code: "BROWSER_AUTH_REQUIRED" } });
});

it("renders an escaped request ID and a localized sign-in entry", async () => {
  const page = String(await renderBrowserErrorPage("BROWSER_AUTH_REQUIRED", "<script>alert(1)</script>", "en-US"));
  expect(page).toContain('href="/dashboard/login?lang=en-US"');
  expect(page).toContain("Sign in again with GitHub");
  expect(page).not.toContain("<script>");
  expect(page).toContain("&lt;script&gt;");
});
