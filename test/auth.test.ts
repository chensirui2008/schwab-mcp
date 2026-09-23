import { describe, expect, it } from "vitest";
import { isAllowedGitHubUser } from "../src/auth";
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
