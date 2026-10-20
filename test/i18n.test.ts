import { describe, expect, it } from "vitest";
import {
  DEFAULT_LANG,
  formatString,
  getDashboardClientI18n,
  getDictionary,
  getRequestLang,
  getSecurityClientI18n,
  LANG_DROPDOWN_SCRIPT,
  renderLangDropdown,
  resolveLang,
} from "../src/i18n";
import { renderAuthorizePage, renderSchwabConnectedPage } from "../src/auth-ui";
import { renderSecurityPage } from "../src/security-ui";
import { renderDashboardPage } from "../src/dashboard-ui";

describe("i18n language resolution", () => {
  it("resolves default language for empty candidates", () => {
    expect(resolveLang()).toBe(DEFAULT_LANG);
    expect(resolveLang(null)).toBe(DEFAULT_LANG);
    expect(resolveLang("")).toBe(DEFAULT_LANG);
  });

  it("resolves English correctly", () => {
    expect(resolveLang("en")).toBe("en-US");
    expect(resolveLang("en-US")).toBe("en-US");
    expect(resolveLang("en-GB")).toBe("en-US");
    expect(resolveLang("EN")).toBe("en-US");
  });

  it("resolves Chinese correctly", () => {
    expect(resolveLang("zh")).toBe("zh-CN");
    expect(resolveLang("zh-CN")).toBe("zh-CN");
    expect(resolveLang("zh-TW")).toBe("zh-CN");
    expect(resolveLang("ZH")).toBe("zh-CN");
  });

  it("falls back to default for unsupported languages", () => {
    expect(resolveLang("fr")).toBe(DEFAULT_LANG);
    expect(resolveLang("ja")).toBe(DEFAULT_LANG);
    expect(resolveLang("es")).toBe(DEFAULT_LANG);
  });
});

describe("i18n getRequestLang", () => {
  it("prioritizes query parameter ?lang=", () => {
    const req = new Request("https://example.com/dashboard?lang=en");
    expect(getRequestLang(req)).toBe("en-US");
  });

  it("reads cookie when query parameter is not present", () => {
    const req = new Request("https://example.com/dashboard", {
      headers: { Cookie: "foo=bar; schwab_lang=en-US; other=1" },
    });
    expect(getRequestLang(req)).toBe("en-US");
  });

  it("reads __Host- prefixed cookie", () => {
    const req = new Request("https://example.com/dashboard", {
      headers: { Cookie: "__Host-schwab_lang=en" },
    });
    expect(getRequestLang(req)).toBe("en-US");
  });

  it("reads Accept-Language header when cookie and query are absent", () => {
    const req = new Request("https://example.com/dashboard", {
      headers: { "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8" },
    });
    expect(getRequestLang(req)).toBe("en-US");
  });

  it.each([
    ["fr-FR,fr;q=0.9,en-US;q=0.8", "en-US"],
    ["zh-CN;q=0.2,en-US;q=0.9", "en-US"],
    ["en-US;q=0,zh-CN;q=0.5", "zh-CN"],
    ["en-US;q=0,fr;q=1,en-GB;q=0.4", "en-US"],
    ["en-US;q=bad,zh-CN;q=0.8", "zh-CN"],
    ["zh-CN;q=2,en-US;q=0.8", "en-US"],
    ["en-US;q=0.8,zh-CN;q=0.8", "en-US"],
  ])("negotiates supported preferences from %s", (header, expected) => {
    const req = new Request("https://example.com/dashboard", { headers: { "Accept-Language": header } });
    expect(getRequestLang(req)).toBe(expected);
  });

  it("works with Hono Context-like object", () => {
    const fakeContext = {
      req: {
        query: (name: string) => (name === "lang" ? "en" : undefined),
        header: () => undefined,
      },
    };
    expect(getRequestLang(fakeContext)).toBe("en-US");
  });

  it("falls back to DEFAULT_LANG when nothing is set", () => {
    const req = new Request("https://example.com/dashboard");
    expect(getRequestLang(req)).toBe(DEFAULT_LANG);
  });
});

describe("i18n dictionaries and helpers", () => {
  it("provides comprehensive dictionaries for both zh-CN and en-US", () => {
    const zh = getDictionary("zh-CN");
    const en = getDictionary("en-US");

    expect(zh.common.brandTitle).toBeDefined();
    expect(en.common.brandTitle).toBeDefined();

    expect(zh.auth.authorizeTitle).toBeDefined();
    expect(en.auth.authorizeTitle).toBeDefined();

    expect(zh.security.orderApprovalTitle).toBeDefined();
    expect(en.security.orderApprovalTitle).toBeDefined();

    expect(zh.dashboard.pageTitle).toBeDefined();
    expect(en.dashboard.pageTitle).toBeDefined();

    // Verify key counts between Chinese and English dictionaries match
    expect(Object.keys(zh.common).sort()).toEqual(Object.keys(en.common).sort());
    expect(Object.keys(zh.auth).sort()).toEqual(Object.keys(en.auth).sort());
    expect(Object.keys(zh.security).sort()).toEqual(Object.keys(en.security).sort());
    expect(Object.keys(zh.dashboard).sort()).toEqual(Object.keys(en.dashboard).sort());
  });

  it("formats template strings with variables", () => {
    expect(formatString("Hello {name}!", { name: "Alice" })).toBe("Hello Alice!");
    expect(formatString("Count: {n}, Status: {status}", { n: 5, status: "OK" })).toBe("Count: 5, Status: OK");
    expect(formatString("No vars", {})).toBe("No vars");
  });

  it("preserves OAuth query values while replacing only the language", () => {
    const params = new URLSearchParams({
      client_id: "client-123",
      redirect_uri: "https://client.example/callback?foo=1&bar=2",
      state: "state + / & \" < >",
      code_challenge: "a".repeat(43),
      code_challenge_method: "S256",
      lang: "zh-CN",
    });
    params.append("lang", "zh");
    const dropdown = renderLangDropdown("zh-CN", params.toString());
    const links = [...dropdown.matchAll(/href="([^"]+)"/g)];
    expect(links).toHaveLength(2);
    for (const [index, match] of links.entries()) {
      const url = new URL((match[1] ?? "").replaceAll("&amp;", "&"), "https://example.com/authorize");
      expect(url.pathname).toBe("/authorize");
      expect(url.searchParams.getAll("lang")).toEqual([index === 0 ? "zh-CN" : "en-US"]);
      for (const key of ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method"]) {
        expect(url.searchParams.get(key)).toBe(params.get(key));
      }
    }
  });

  it("provides client i18n payload for dashboard and security", () => {
    const dashClientZh = getDashboardClientI18n("zh-CN");
    expect(Object.keys(dashClientZh).length).toBeGreaterThan(20);
    expect(dashClientZh.pageTitle).toBe("Schwab MCP · 控制面板");

    const dashClientEn = getDashboardClientI18n("en-US");
    expect(Object.keys(dashClientEn).length).toBeGreaterThan(20);
    expect(dashClientEn.pageTitle).toBe("Schwab MCP · Control Center");

    const secClientZh = getSecurityClientI18n("zh-CN");
    expect(Object.keys(secClientZh).length).toBeGreaterThan(10);
    expect(secClientZh.orderApprovalTitle).toBe("订单 Passkey 硬件批准");

    const secClientEn = getSecurityClientI18n("en-US");
    expect(Object.keys(secClientEn).length).toBeGreaterThan(10);
    expect(secClientEn.orderApprovalTitle).toBe("Order Passkey Hardware Approval");

    expect(LANG_DROPDOWN_SCRIPT).toContain("lang-dropdown");
    expect(LANG_DROPDOWN_SCRIPT).toContain("Escape");
  });
});

describe("UI rendering with localization", () => {
  it("renders authorize page in both zh-CN and en-US", async () => {
    const zhOutput = await renderAuthorizePage({
      clientName: "Claude Desktop",
      redirectUri: "https://claude.ai/callback",
      state: "state-123",
      lang: "zh-CN",
    });
    const zhHtml = zhOutput.toString();
    expect(zhHtml).toContain("允许连接 Schwab MCP？");
    expect(zhHtml).toContain('lang="zh-CN"');

    const enOutput = await renderAuthorizePage({
      clientName: "Claude Desktop",
      redirectUri: "https://claude.ai/callback",
      state: "state-123",
      lang: "en-US",
    });
    const enHtml = enOutput.toString();
    expect(enHtml).toContain("Allow connection to Schwab MCP?");
    expect(enHtml).toContain('lang="en-US"');
    expect(enHtml).toContain("Read only");
  });

  it("renders Schwab connected page in both zh-CN and en-US", () => {
    const zhOutput = renderSchwabConnectedPage("zh-CN");
    expect(zhOutput).toContain("Schwab 账户已成功连接");

    const enOutput = renderSchwabConnectedPage("en-US");
    expect(enOutput).toContain("Schwab Account Connected");
  });

  it("renders security page in both zh-CN and en-US", async () => {
    const session = {
      expiresAt: Date.now() + 900000,
      csrf: "csrf-token-123",
      credentialVersion: 1,
      recovery: false,
    };
    const credentials = [{ id: "key-1", name: "YubiKey 5" }];

    const zhOutput = await renderSecurityPage(session, credentials, undefined, "zh-CN");
    const zhHtml = zhOutput.toString();
    expect(zhHtml).toContain("Advanced Security");
    expect(zhHtml).toContain('lang="zh-CN"');
    expect(zhHtml).toContain("已绑定 Passkey");

    const enOutput = await renderSecurityPage(session, credentials, undefined, "en-US");
    const enHtml = enOutput.toString();
    expect(enHtml).toContain("Advanced Security");
    expect(enHtml).toContain('lang="en-US"');
    expect(enHtml).toContain("Registered Passkeys");
  });

  it("renders dashboard page in both zh-CN and en-US", async () => {
    const session = {
      expiresAt: Date.now() + 900000,
      csrf: "csrf-token-123",
      credentialVersion: 1,
      recovery: false,
    };

    const zhOutput = await renderDashboardPage({
      session,
      appVersion: "0.2.0",
      allowedUserId: "123456",
      lang: "zh-CN",
    });
    const zhHtml = zhOutput.toString();
    expect(zhHtml).toContain("控制面板");
    expect(zhHtml).toContain('lang="zh-CN"');
    expect(zhHtml).toContain("待办与通知");

    const enOutput = await renderDashboardPage({
      session,
      appVersion: "0.2.0",
      allowedUserId: "123456",
      lang: "en-US",
    });
    const enHtml = enOutput.toString();
    expect(enHtml).toContain("Control Center");
    expect(enHtml).toContain('lang="en-US"');
    expect(enHtml).toContain("Inbox &amp; Alerts");
    expect(enHtml).toContain("Authorized Clients");
  });
});
