import { z } from "zod";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { BrowserSession, PendingAuthorization } from "./security-store";

export const clientIdSchema = z.string().min(1).max(2048);
export const permissionSchema = z.enum(["read_only", "full_access"]);
export const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const timestampSchema = versionSchema;
export const policySchema = z.object({
  clientId: clientIdSchema, permissionLevel: permissionSchema, advancedSecurity: z.boolean(),
  version: versionSchema, revoked: z.boolean(), updatedAt: timestampSchema,
});
export const pendingAuthorizationSchema = z.object({
  authRequest: z.object({
    responseType: z.string(), clientId: clientIdSchema, redirectUri: z.string(), scope: z.array(z.string()), state: z.string(),
    codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), codeChallengeMethod: z.literal("S256"),
    resource: z.union([z.string(), z.array(z.string())]).optional(),
  }),
  permissionLevel: permissionSchema, advancedSecurity: z.boolean(), username: z.string(), policyVersion: versionSchema,
}).transform(({ authRequest, ...pending }): PendingAuthorization => {
  const { resource, ...request } = authRequest;
  return { ...pending, authRequest: { ...request, ...(resource === undefined ? {} : { resource }) } };
});
export const sessionSchema = z.object({
  csrf: z.string().min(1), credentialVersion: versionSchema, expiresAt: timestampSchema,
  recovery: z.boolean(), pendingAuthorizationId: z.string().min(1).optional(),
}).strict().transform(({ pendingAuthorizationId, ...session }): BrowserSession => ({
  ...session, ...(pendingAuthorizationId === undefined ? {} : { pendingAuthorizationId }),
}));
export const sessionEnvelopeSchema = z.object({
  session: sessionSchema, credentials: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});
const base64url = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const credentialBase = {
  id: base64url, rawId: base64url, type: z.literal("public-key"),
  authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  clientExtensionResults: z.looseObject({}),
};
export const registrationResponseSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: base64url, attestationObject: base64url,
    authenticatorData: base64url.optional(), transports: z.array(z.string()).optional(),
    publicKeyAlgorithm: z.number().int().optional(), publicKey: base64url.optional(),
  }),
}).transform(({ authenticatorAttachment, response, ...credential }): RegistrationResponseJSON => {
  const { authenticatorData, transports, publicKeyAlgorithm, publicKey, ...attestation } = response;
  return {
    ...credential, ...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
    response: {
      ...attestation, ...(authenticatorData === undefined ? {} : { authenticatorData }),
      ...(transports === undefined ? {} : { transports }),
      ...(publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm }),
      ...(publicKey === undefined ? {} : { publicKey }),
    },
  };
});
export const authenticationResponseSchema = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: base64url, authenticatorData: base64url, signature: base64url,
    userHandle: z.string().regex(/^[A-Za-z0-9_-]*$/).optional(),
  }),
}).transform(({ authenticatorAttachment, response, ...credential }): AuthenticationResponseJSON => {
  const { userHandle, ...assertion } = response;
  return {
    ...credential, ...(authenticatorAttachment === undefined ? {} : { authenticatorAttachment }),
    response: { ...assertion, ...(userHandle === undefined ? {} : { userHandle }) },
  };
});
export const credentialResponseSchema = z.union([registrationResponseSchema, authenticationResponseSchema]);
export const dashboardPolicyInputSchema = z.object({
  clientId: clientIdSchema, advancedSecurity: z.boolean(),
  challengeId: z.string().min(1).max(2048).optional(), response: credentialResponseSchema.optional(),
}).strict().refine(value => (value.challengeId === undefined) === (value.response === undefined));
export const policyUpdateSchema = z.object({
  clientId: clientIdSchema, permissionLevel: permissionSchema.optional(), revoked: z.literal(true).optional(),
  expected: versionSchema.optional(), sessionId: z.string().min(1).max(2048).optional(), csrf: z.string().min(1).max(2048).optional(),
}).strict().refine(value => value.permissionLevel !== undefined || value.revoked !== undefined)
  .refine(value => (value.sessionId === undefined) === (value.csrf === undefined));
export const toolAuditInputSchema = z.object({
  id: z.string().min(1).max(256).optional(), clientId: clientIdSchema, toolName: z.string().min(1).max(256),
  requestId: z.string().min(1).max(256), status: z.enum(["SUCCESS", "ERROR"]),
  parametersSummary: z.string().max(65536).optional(), errorCode: z.string().min(1).max(256).optional(),
  errorMessage: z.string().max(65536).optional(), durationMs: versionSchema, createdAt: timestampSchema.optional(),
}).strict();
export const auditQuerySchema = z.object({
  clientId: clientIdSchema.optional(), toolName: z.string().min(1).max(256).optional(), status: z.enum(["SUCCESS", "ERROR"]).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional().default(50),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(5000)).optional().default(0),
}).strict();
export function parseAuditQuery(params: URLSearchParams) {
  const entries: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(entries, key)) throw new RequestBodyError("Duplicate query parameter");
    entries[key] = value;
  }
  return auditQuerySchema.parse(entries);
}
export class RequestBodyError extends Error {
  constructor(message: string, public status: 400 | 413 = 400) { super(message); }
}
export function isJsonContentType(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(value.trim());
}
export async function readBoundedJson(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("JSON body required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65536) {
      await reader.cancel();
      throw new RequestBodyError("Request too large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new RequestBodyError("Invalid JSON"); }
}
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
