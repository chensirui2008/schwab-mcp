import type { JsonValue, TradeCondition } from "./types";

const SENSITIVE_ORDER_KEYS = new Set([
  "accountNumber",
  "access_token",
  "accessToken",
  "authorization",
  "confirmationToken",
  "refresh_token",
  "refreshToken",
  "sessionCapability",
]);

function assertSafe(value: JsonValue, depth: number, counter: { nodes: number }): void {
  counter.nodes += 1;
  if (counter.nodes > 2048) throw new Error("Order payload is too complex");
  if (depth > 16) throw new Error("Order payload is too deeply nested");
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item, depth + 1, counter);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_ORDER_KEYS.has(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Order payload contains forbidden key: ${key}`);
    }
    assertSafe(item, depth + 1, counter);
  }
}

export function assertSafeOrderPayload(value: { [key: string]: JsonValue }): void {
  assertSafe(value, 0, { nodes: 0 });
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function sha256(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

export function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenMatches(token: string, expectedHash: string): Promise<boolean> {
  const actual = new TextEncoder().encode(await sha256(token));
  const expected = new TextEncoder().encode(expectedHash);
  if (actual.byteLength !== expected.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < actual.byteLength; index += 1) difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  return difference === 0;
}

export function compareNumber(left: number, operator: "LT" | "LTE" | "EQ" | "GTE" | "GT", right: number): boolean {
  if (operator === "LT") return left < right;
  if (operator === "LTE") return left <= right;
  if (operator === "EQ") return left === right;
  if (operator === "GTE") return left >= right;
  return left > right;
}

export function collectQuoteSymbols(condition: TradeCondition, output = new Set<string>()): Set<string> {
  if (condition.type === "QUOTE") output.add(condition.symbol);
  else if (condition.type === "NOT") collectQuoteSymbols(condition.condition, output);
  else if (condition.type === "ALL" || condition.type === "ANY") {
    for (const child of condition.conditions) collectQuoteSymbols(child, output);
  }
  return output;
}

export function evaluateCondition(condition: TradeCondition, quotes: Record<string, Record<string, number>>, now: number): boolean {
  if (condition.type === "ALL") return condition.conditions.every((child) => evaluateCondition(child, quotes, now));
  if (condition.type === "ANY") return condition.conditions.some((child) => evaluateCondition(child, quotes, now));
  if (condition.type === "NOT") return !evaluateCondition(condition.condition, quotes, now);
  if (condition.type === "TIME") {
    const at = Date.parse(condition.at);
    if (condition.operator === "BEFORE") return now < at;
    if (condition.operator === "AT_OR_BEFORE") return now <= at;
    if (condition.operator === "AFTER") return now > at;
    return now >= at;
  }
  const quote = quotes[condition.symbol.toUpperCase()];
  const observed = quote?.[condition.field];
  if (typeof observed !== "number" || !Number.isFinite(observed)) throw new Error(`Missing numeric quote field ${condition.field}`);
  return compareNumber(observed, condition.operator, condition.value);
}
