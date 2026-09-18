import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../src/env";
import { isAllowedGitHubUser } from "../src/auth";
import { grantedScopes, isTradeAuthorized, OAUTH_AUTHORIZATION_VERSION, READ_SCOPE, resolveMcpAccess, TRADE_SCOPE } from "../src/oauth-access";

describe("GitHub owner allowlist", () => {
  it("matches only the immutable numeric user ID", () => {
    expect(isAllowedGitHubUser(123456, "123456")).toBe(true);
    expect(isAllowedGitHubUser(123457, "123456")).toBe(false);
  });
});

describe("OAuth trading authorization", () => {
  it("grants read access by default and trade access only when explicitly requested", () => {
    expect(grantedScopes([])).toEqual([READ_SCOPE]);
    expect(grantedScopes([READ_SCOPE])).toEqual([READ_SCOPE]);
    expect(grantedScopes([TRADE_SCOPE])).toEqual([READ_SCOPE, TRADE_SCOPE]);
  });

  it("requires both the current trade scope and the new informed-consent marker", () => {
    const token = (scope: string[], authorizationVersion?: number) => ({
      grant: {
        clientId: "client",
        scope,
        props: { userId: "123", username: "owner", ...(authorizationVersion === undefined ? {} : { authorizationVersion }) },
      },
    });

    expect(isTradeAuthorized(token([TRADE_SCOPE], OAUTH_AUTHORIZATION_VERSION))).toBe(true);
    expect(isTradeAuthorized(token([READ_SCOPE], OAUTH_AUTHORIZATION_VERSION))).toBe(false);
    expect(isTradeAuthorized(token([TRADE_SCOPE]))).toBe(false);
    expect(isTradeAuthorized(null)).toBe(false);
    expect(isTradeAuthorized({ grant: { scope: [TRADE_SCOPE], props: null } })).toBe(false);
  });

  it("derives access from the bearer token's effective scope", async () => {
    const unwrapToken = vi.fn().mockResolvedValue({
      grant: {
        clientId: "client",
        scope: [READ_SCOPE, TRADE_SCOPE],
        props: { userId: "123", username: "owner", authorizationVersion: OAUTH_AUTHORIZATION_VERSION },
      },
    });
    const request = new Request("https://example.com/mcp", { headers: { Authorization: "Bearer current-token" } });
    const access = await resolveMcpAccess(request, { OAUTH_PROVIDER: { unwrapToken } } as unknown as AppEnv);

    expect(unwrapToken).toHaveBeenCalledWith("current-token");
    expect(access).toEqual({ canTrade: true });
    expect(await resolveMcpAccess(new Request("https://example.com/mcp"), { OAUTH_PROVIDER: { unwrapToken } } as unknown as AppEnv)).toEqual({ canTrade: false });
  });
});
