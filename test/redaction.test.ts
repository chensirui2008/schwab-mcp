import { describe, expect, it } from "vitest";
import { accountHashes, redact } from "../src/redaction";

describe("redaction", () => {
  it("removes credentials and complete account numbers recursively", () => {
    const input = {
      access_token: "secret",
      nested: [{ accountNumber: "12345678", hashValue: "safe-hash", symbol: "AAPL" }],
      refreshToken: "secret-2",
    };
    expect(redact(input)).toEqual({ nested: [{ hashValue: "safe-hash", symbol: "AAPL" }] });
    expect(JSON.stringify(redact(input))).not.toContain("secret");
    expect(JSON.stringify(redact(input))).not.toContain("12345678");
  });

  it("returns only Schwab account hashes", () => {
    expect(accountHashes([{ accountNumber: "1234", hashValue: "hash-a" }, { hashValue: "hash-b" }])).toEqual([
      { hashValue: "hash-a" },
      { hashValue: "hash-b" },
    ]);
  });

  it("fails when Schwab changes the account-number response shape", () => {
    expect(() => accountHashes([{ accountNumber: "1234" }])).toThrow("hashValue");
    expect(() => accountHashes(null)).toThrow("account-number response");
  });
});
