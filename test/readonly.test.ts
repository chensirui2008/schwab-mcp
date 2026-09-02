import { describe, expect, it } from "vitest";
import source from "../src/vault.ts?raw";

describe("read-only Schwab data boundary", () => {
  it("uses GET for every protected-resource request", () => {
    const protectedRequest = source.match(/fetch\(url, \{ method: "([A-Z]+)"/);
    expect(protectedRequest?.[1]).toBe("GET");
    expect(source).not.toMatch(/fetch\(url, \{ method: "(?:POST|PUT|DELETE|PATCH)"/);
  });
});
