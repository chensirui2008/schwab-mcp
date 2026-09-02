const SENSITIVE_KEYS = new Set([
  "access_token",
  "accessToken",
  "refresh_token",
  "refreshToken",
  "authorization",
  "code",
  "accountNumber",
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value === null || typeof value !== "object") return value;

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEYS.has(key)) continue;
    output[key] = redact(Reflect.get(value, key) as unknown);
  }
  return output;
}

export function accountHashes(value: unknown): Array<{ hashValue: string }> {
  if (!Array.isArray(value)) throw new Error("Unexpected Schwab account-number response");
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object") throw new Error("Unexpected Schwab account entry");
    const hashValue = Reflect.get(entry, "hashValue") as unknown;
    if (typeof hashValue !== "string") throw new Error("Schwab account entry is missing hashValue");
    return { hashValue };
  });
}
