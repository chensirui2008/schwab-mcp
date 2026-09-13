import { describe, expect, it } from "vitest";
import type { AppEnv } from "../src/env";
import { tradingEnabled } from "../src/env";
import { authorizationNotice } from "../src/tools";

const env = {
  SCHWAB_REDIRECT_URI: "https://example.com/auth/schwab/callback",
} as AppEnv;

describe("Schwab authorization notice", () => {
  it("returns a reconnect notice within 24 hours of refresh expiry", () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0);
    expect(authorizationNotice(now + 60 * 60 * 1000, env, now)).toEqual({
      code: "REAUTHORIZATION_DUE_SOON",
      message: "Schwab authorization expires within 24 hours; reconnect to avoid interruption",
      refreshExpiresAt: "2026-09-09T01:00:00.000Z",
      reconnectUrl: "https://example.com/auth/schwab/connect",
    });
  });

  it("does not return a notice outside the reminder window", () => {
    const now = Date.UTC(2026, 8, 9, 0, 0, 0);
    expect(authorizationNotice(now + 24 * 60 * 60 * 1000 + 1, env, now)).toBeUndefined();
    expect(authorizationNotice(now, env, now)).toBeUndefined();
  });
});

describe("trading master switch", () => {
  it("is enabled only by the exact deployment value true", () => {
    expect(tradingEnabled({ ENABLE_TRADING: "true" } as AppEnv)).toBe(true);
    expect(tradingEnabled({ ENABLE_TRADING: "false" } as AppEnv)).toBe(false);
    expect(tradingEnabled({ ENABLE_TRADING: "TRUE" } as AppEnv)).toBe(false);
  });
});
