import { describe, expect, it } from "vitest";
import { isAllowedGitHubUser } from "../src/auth";
import { renderAuthorizePage, renderSchwabConnectedPage } from "../src/auth-ui";
import { READ_SCOPE } from "../src/oauth-access";

describe("GitHub owner allowlist", () => {
  it("matches only the immutable numeric user ID", () => {
    expect(isAllowedGitHubUser(123456, "123456")).toBe(true);
    expect(isAllowedGitHubUser(123457, "123456")).toBe(false);
  });
});

describe("OAuth access scope", () => {
  it("uses one authentication scope without a separate trading scope", () => {
    expect(READ_SCOPE).toBe("schwab.read");
  });
});

describe("OAuth UI rendering", () => {
  it("renders the authorization page with client details and approval form", async () => {
    const output = await renderAuthorizePage({
      clientName: "Claude",
      redirectUri: "https://claude.ai/api/mcp/auth_callback",
      state: "test-state-123",
    });
    const htmlString = output.toString();
    expect(htmlString).toContain("允许连接 Schwab MCP？");
    expect(htmlString).toContain("Claude");
    expect(htmlString).toContain("https://claude.ai/api/mcp/auth_callback");
    expect(htmlString).toContain('action="/authorize/approve"');
    expect(htmlString).toContain('name="state" value="test-state-123"');
    expect(htmlString).toContain("继续 GitHub 身份验证并授权");
    expect(htmlString).toContain('value="read_only" form="authorize-form" required checked');
    expect(htmlString).toContain('value="full_access" form="authorize-form" required');
    expect(htmlString).toContain('id="authorize-form"');
    expect(htmlString).toContain("Read only");
    expect(htmlString).toContain("Full access");
  });

  it("renders the Schwab connected success page", () => {
    const htmlString = renderSchwabConnectedPage();
    expect(htmlString).toContain("Schwab 账户已成功连接");
    expect(htmlString).toContain("可以安全关闭此浏览器窗口");
  });
});
