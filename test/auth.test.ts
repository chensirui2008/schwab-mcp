import { describe, expect, it } from "vitest";
import { isAllowedGitHubUser } from "../src/auth";

describe("GitHub owner allowlist", () => {
  it("matches only the immutable numeric user ID", () => {
    expect(isAllowedGitHubUser(123456, "123456")).toBe(true);
    expect(isAllowedGitHubUser(123457, "123456")).toBe(false);
  });
});
