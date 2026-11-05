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
import { renderAccountSelectionPage, renderAuthorizePage, renderClientContinuePage, renderPasskeyAuthorizedPage, renderSchwabConnectedPage } from "../src/auth-ui";
import { renderSecurityPage } from "../src/security-ui";
import { renderDashboardPage } from "../src/dashboard-ui";
import dashboardSource from "../src/dashboard-ui.ts?raw";
import securitySource from "../src/security-ui.ts?raw";

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
  it("keeps interpolation placeholders aligned in every translation", () => {
    const zh = getDictionary("zh-CN");
    const en = getDictionary("en-US");
    const placeholders = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
    for (const group of ["common", "auth", "security", "dashboard"] as const) {
      for (const [key, value] of Object.entries(zh[group])) {
        expect(placeholders(en[group][key as keyof typeof en[typeof group]]), `${group}.${key}`).toEqual(placeholders(value));
      }
    }
  });

  it("requires dictionary entries for every client translation and prevents hardcoded Chinese", () => {
    for (const [source, translations] of [
      [dashboardSource, getDashboardClientI18n("en-US")],
      [securitySource, getSecurityClientI18n("en-US")],
    ] as const) {
      expect(source).not.toMatch(/\p{Script=Han}/u);
      for (const match of source.matchAll(/\bt\('(\w+)'/g)) {
        expect(translations[match[1] ?? ""], match[1]).toBeTruthy();
      }
    }
    expect(dashboardSource).toContain("document.documentElement.lang");
    expect(dashboardSource).not.toContain("t('colClient') ===");
  });

  it("preserves each high-risk security condition in both languages", () => {
    const zh = getDictionary("zh-CN");
    const en = getDictionary("en-US");
    const cases: [string, string, RegExp, RegExp][] = [
      [zh.auth.fullAccessDesc, en.auth.fullAccessDesc, /session 直下/, /session-direct trading/],
      [zh.auth.fullAccessDesc, en.auth.fullAccessDesc, /二次确认.*撤单/, /secondary confirmation.*cancellation/],
      [zh.auth.advancedSecurityDesc, en.auth.advancedSecurityDesc, /仅完整访问/, /only for full access/],
      [zh.auth.advancedSecurityDesc, en.auth.advancedSecurityDesc, /建单、改单/, /placement or replacement/],
      [zh.auth.advancedSecurityDesc, en.auth.advancedSecurityDesc, /延迟任务创建和修改/, /delayed-task creation or modification/],
      [zh.auth.advancedSecurityDesc, en.auth.advancedSecurityDesc, /禁止 session 直下/, /Session-direct trading is prohibited/],
      [zh.auth.advancedSecurityDesc, en.auth.advancedSecurityDesc, /按客户端生效/, /per client/],
      [zh.security.frozenDesc, en.security.frozenDesc, /条件和截止时间/, /conditions and deadline/],
      [zh.security.approveHint, en.security.approveHint, /立即提交即时订单或激活延迟任务/, /immediately submits instant orders or activates delayed tasks/],
      [zh.security.approveHint, en.security.approveHint, /无对话确认降级/, /No downgrade to conversational confirmation/],
      [zh.security.recoverNotice, en.security.recoverNotice, /新凭据注册成功前不删除旧凭据/, /Old credentials are not deleted until the new credential is successfully registered/],
      [zh.security.recoverNotice, en.security.recoverNotice, /旧凭据、浏览器会话、challenge 和待批准增强提案全部失效/, /old credentials, browser sessions, challenges, and pending enhanced proposals are invalidated/],
      [zh.security.recoverNotice, en.security.recoverNotice, /已激活延迟任务保留/, /Already activated delayed tasks are retained/],
      [zh.security.recoverNotice, en.security.recoverNotice, /Advanced Security 保持开启/, /Advanced Security remains enabled/],
      [zh.security.disclaimer, en.security.disclaimer, /Worker、批准设备或 GitHub 恢复账户/, /Worker, approval device, or GitHub recovery account/],
    ];
    for (const [chinese, english, zhCondition, enCondition] of cases) {
      expect(chinese).toMatch(zhCondition);
      expect(english).toMatch(enCondition);
    }
  });

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
  it.each(["zh-CN", "en-US"] as const)("localizes transient consent pages and completion badges in %s", async lang => {
    const dict = getDictionary(lang);
    const accounts = String(await renderAccountSelectionPage({
      state: "opaque-state", clientName: "Client <name>", accounts: [{ hashValue: "hash", label: "••••1234" }],
      selected: ["hash"], connected: false, lang,
    }));
    expect(accounts).toContain(dict.auth.accountsHeading);
    expect(accounts).toContain(dict.auth.accountsDesc);
    expect(accounts).toContain(dict.auth.accountsDisconnected);
    expect(accounts).toContain(dict.common.brandTitle);
    expect(accounts).toContain('id="auth-language"');
    expect(accounts).toContain('value="opaque-state"');
    expect(accounts).toContain('value="hash" checked');
    expect(accounts).toContain("Client &lt;name&gt;");
    expect(accounts).not.toContain("location.reload");
    const continuation = String(await renderClientContinuePage("https://client.example/cb?code=opaque&state=s", lang));
    expect(continuation).toContain(dict.auth.clientContinueNotice);
    expect(continuation).toContain('id="auth-language"');
    expect(continuation).toContain("code=opaque&amp;state=s");
    const completion = renderPasskeyAuthorizedPage(lang);
    expect(completion).toContain(`>${dict.auth.completionDone}</span>`);
  });

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
    const labels = [...enHtml.matchAll(/aria-label="([^"]+)"/g)].map(match => match[1]);
    expect(labels.length).toBeGreaterThanOrEqual(10);
    labels.forEach(label => { expect(label).not.toMatch(/\p{Script=Han}/u); });
  });
});
