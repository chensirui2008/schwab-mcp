import { describe, expect, it } from "vitest";
import source from "../src/vault.ts?raw";

describe("Schwab mutation boundary", () => {
  it("keeps writes behind the dedicated confirmation-aware mutation path", () => {
    expect(source).toContain('private executeMutation(');
    expect(source).toContain('if (method === "GET" && (upstream.status === 429 || upstream.status >= 500)');
    expect(source).toContain('code: method === "GET" ? "UPSTREAM_UNAVAILABLE" : "EXECUTION_UNCERTAIN"');
    expect(source).not.toMatch(/fetch\(url, \{ method: "(?:POST|PUT|DELETE|PATCH)"/);
  });
});
