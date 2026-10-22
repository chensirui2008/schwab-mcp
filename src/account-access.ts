import { z } from "zod";

export const accountHashSchema = z.string().min(16).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const accountSelectionSchema = z.array(accountHashSchema).max(100).refine(hashes => new Set(hashes).size === hashes.length);
const linkedAccountsSchema = z.array(z.object({ accountNumber: z.string().regex(/^\d+$/), hashValue: accountHashSchema }));

// Full account numbers exist only transiently while mapping Schwab responses.
export function linkedAccounts(value: unknown) {
  const parsed = linkedAccountsSchema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid linked accounts response");
  return parsed.data;
}
export function accountChoices(value: unknown) {
  return linkedAccounts(value).map(({ accountNumber, hashValue }) => ({ hashValue, label: `••••${accountNumber.slice(-4)}` }));
}
export function scopedPreferences(value: unknown, linked: unknown, allowed: string[]): unknown {
  const parsed = z.object({ accounts: z.array(z.object({ accountNumber: z.string(), primaryAccount: z.boolean().optional(), type: z.string().optional() })) }).safeParse(value);
  if (!parsed.success) throw new Error("Invalid user preferences response");
  const prefs = parsed.data;
  const hashes = new Map(linkedAccounts(linked).map(account => [account.accountNumber, account.hashValue]));
  return { accounts: prefs.accounts.flatMap(account => {
    const hashValue = hashes.get(account.accountNumber);
    if (!hashValue) throw new Error("Unmapped Schwab preference account");
    return allowed.includes(hashValue) ? [{ hashValue, ...(account.primaryAccount === undefined ? {} : { primaryAccount: account.primaryAccount }), ...(account.type === undefined ? {} : { type: account.type }) }] : [];
  }) };
}

export function orderEnteredTime(value: unknown): number {
  const parsed = z.object({ enteredTime: z.string() }).safeParse(value);
  if (!parsed.success) throw new Error("Invalid order timestamp");
  const time = Date.parse(parsed.data.enteredTime);
  if (!Number.isFinite(time)) throw new Error("Invalid order timestamp");
  return time;
}
