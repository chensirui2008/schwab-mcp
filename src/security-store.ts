import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./env";
import type { PermissionLevel } from "./oauth-access";
import { randomToken } from "./trading";

export interface ClientIdentity {
  clientId: string;
  advancedSecurity: boolean;
  securityPolicyVersion: number;
}
export interface ClientPolicy { advancedSecurity: boolean; version: number }
export interface PendingAuthorization {
  authRequest: AuthRequest;
  permissionLevel: PermissionLevel;
  advancedSecurity: boolean;
  username: string;
  policyVersion: number;
}
export interface BrowserSession {
  csrf: string;
  credentialVersion: number;
  expiresAt: number;
  recovery: boolean;
  pending?: PendingAuthorization;
}
interface CredentialRow { [key: string]: string | number; id: string; name: string; credential: string }
export interface ApprovalBinding {
  proposalId: string;
  intentDigest: string;
  clientId: string;
  policyVersion: number;
  expiresAt: number;
}
interface Challenge {
  sessionId: string;
  credentialVersion: number;
  operation: "register" | "recover" | "authorize" | "add" | "delete" | "rename" | "approve";
  challenge: string;
  expiresAt: number;
  target: string;
  name: string;
  binding?: ApprovalBinding;
  policyVersion?: number;
}
export class SecurityError extends Error {
  constructor(public code: "SECURITY_VERIFICATION_FAILED" | "SECURITY_POLICY_CHANGED" | "BROWSER_AUTH_REQUIRED" = "SECURITY_VERIFICATION_FAILED") {
    super(code);
  }
}
export function encodeBytes(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function decodeBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}

function assertSameOriginCeremony(clientDataJSON: string): void {
  const clientData = JSON.parse(new TextDecoder().decode(decodeBytes(clientDataJSON))) as { crossOrigin?: boolean; topOrigin?: string };
  if (clientData.crossOrigin || clientData.topOrigin !== undefined) throw new SecurityError();
}

// All state is in the owner SQLite DO. No OAuth KV key layout is used here.
export class SecurityStore {
  constructor(private storage: DurableObjectStorage, private env: AppEnv) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner_security (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO owner_security VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS passkey (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_security (client_id TEXT PRIMARY KEY, advanced INTEGER NOT NULL, version INTEGER NOT NULL);
    `);
    for (const table of ["trade_proposal", "delayed_trade"]) {
      const columns = new Set(storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
      for (const [name, definition] of Object.entries({
        approval_method: "TEXT NOT NULL DEFAULT 'conversation'",
        client_id: "TEXT",
        policy_version: "INTEGER NOT NULL DEFAULT 0",
      })) if (!columns.has(name)) storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  version(): number { return this.storage.sql.exec<{ version: number }>("SELECT version FROM owner_security WHERE id = 1").one().version; }
  policy(clientId: string): ClientPolicy {
    const row = this.storage.sql.exec<{ advanced: number; version: number }>("SELECT advanced, version FROM client_security WHERE client_id = ?", clientId).toArray()[0];
    return { advancedSecurity: row?.advanced === 1, version: row?.version ?? 0 };
  }
  assertIdentity(identity: ClientIdentity): void {
    const policy = this.policy(identity.clientId);
    if (policy.version !== identity.securityPolicyVersion || policy.advancedSecurity !== identity.advancedSecurity) throw new SecurityError("SECURITY_POLICY_CHANGED");
  }
  commitPolicy(clientId: string, advancedSecurity: boolean, expected: number): ClientPolicy {
    return this.storage.transactionSync(() => {
      if (this.policy(clientId).version !== expected) throw new SecurityError("SECURITY_POLICY_CHANGED");
      const version = expected + 1;
      this.storage.sql.exec("INSERT INTO client_security VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET advanced = excluded.advanced, version = excluded.version", clientId, advancedSecurity ? 1 : 0, version);
      this.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED', updated_at = ? WHERE client_id = ? AND status = 'PENDING'", Date.now(), clientId);
      return { advancedSecurity, version };
    });
  }
  save(kind: string, payload: unknown, expiresAt: number): string {
    this.storage.sql.exec("DELETE FROM oauth_state WHERE expires_at <= ?", Date.now());
    const id = randomToken();
    this.storage.sql.exec("INSERT INTO oauth_state VALUES (?, ?, ?, ?)", id, `security_${kind}`, JSON.stringify(payload), expiresAt);
    return id;
  }
  // Typed internal SQLite envelopes are written only by this store.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  read<T>(id: string, kind: string, consume = false): T {
    const query = consume ? "DELETE FROM oauth_state WHERE state = ? AND kind = ? AND expires_at > ? RETURNING payload" : "SELECT payload FROM oauth_state WHERE state = ? AND kind = ? AND expires_at > ?";
    const row = this.storage.sql.exec<{ payload: string }>(query, id, `security_${kind}`, Date.now()).toArray()[0];
    if (!row) throw new SecurityError("BROWSER_AUTH_REQUIRED");
    return JSON.parse(row.payload) as T;
  }
  createSession(recovery = false, pending?: PendingAuthorization): { sessionId: string; session: BrowserSession } {
    const session: BrowserSession = { csrf: randomToken(), credentialVersion: this.version(), expiresAt: Date.now() + 15 * 60_000, recovery, ...(pending ? { pending } : {}) };
    return { sessionId: this.save("session", session, session.expiresAt), session };
  }
  session(id: string, csrf?: string): BrowserSession {
    const session = this.read<BrowserSession>(id, "session");
    if (session.credentialVersion !== this.version() || (csrf !== undefined && session.csrf !== csrf)) throw new SecurityError("BROWSER_AUTH_REQUIRED");
    return session;
  }
  credentials(): { id: string; name: string }[] {
    return this.storage.sql.exec<{ id: string; name: string }>("SELECT id, name FROM passkey ORDER BY id").toArray();
  }
  private credential(id: string): WebAuthnCredential {
    const row = this.storage.sql.exec<CredentialRow>("SELECT * FROM passkey WHERE id = ?", id).toArray()[0];
    if (!row) throw new SecurityError();
    const stored = JSON.parse(row.credential) as Omit<WebAuthnCredential, "publicKey"> & { publicKey: string };
    return { ...stored, publicKey: decodeBytes(stored.publicKey) };
  }
  private insertCredential(credential: WebAuthnCredential, name: string): void {
    this.storage.sql.exec("INSERT INTO passkey VALUES (?, ?, ?)", credential.id, name, JSON.stringify({ ...credential, publicKey: encodeBytes(credential.publicKey) }));
  }
  async options(sessionId: string, csrf: string, operation: Challenge["operation"], target = "", name = "Passkey", binding?: ApprovalBinding, resetConfirmation?: string) {
    const session = this.session(sessionId, csrf);
    const count = this.credentials().length;
    if (session.recovery && operation !== "recover") throw new SecurityError();
    if (operation === "recover" && (!session.recovery || resetConfirmation !== "重置全部 Passkey")) throw new SecurityError();
    if (operation === "register" && count > 0) throw new SecurityError();
    if (operation === "authorize" && !session.pending) throw new SecurityError();
    if (operation === "approve" && !binding) throw new SecurityError();
    if ((operation === "delete" || operation === "rename") && !this.credentials().some(c => c.id === target)) throw new SecurityError();
    if (operation === "delete" && count <= 1) throw new SecurityError();
    if (!["register", "recover"].includes(operation) && count === 0) throw new SecurityError();
    if (name.trim().length < 1 || name.length > 80) throw new SecurityError();
    const register = operation === "register" || operation === "recover";
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    const options = register ? await generateRegistrationOptions({
      rpName: "Schwab MCP", rpID: origin.hostname, userName: this.env.ALLOWED_GITHUB_USER_ID,
      userID: new TextEncoder().encode(this.env.ALLOWED_GITHUB_USER_ID),
      attestationType: "none", supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      excludeCredentials: this.credentials().map(c => ({ id: c.id })),
    }) : await generateAuthenticationOptions({ rpID: origin.hostname, userVerification: "required", allowCredentials: this.credentials().map(c => ({ id: c.id })) });
    // Recheck after asynchronous option generation.
    this.session(sessionId, csrf);
    const expiresAt = Math.min(Date.now() + 120_000, session.expiresAt, binding?.expiresAt ?? Infinity);
    const challenge: Challenge = {
      sessionId, credentialVersion: session.credentialVersion, operation, target, name, expiresAt, challenge: options.challenge,
      ...(binding ? { binding } : {}), ...(session.pending ? { policyVersion: session.pending.policyVersion } : {}),
    };
    if (expiresAt <= Date.now()) throw new SecurityError();
    const challengeId = this.save("challenge", challenge, expiresAt);
    return { challengeId, options, registration: register };
  }
  // Consume before crypto; recheck all mutable bindings after crypto before committing.
  async verify(sessionId: string, csrf: string, challengeId: string, response: RegistrationResponseJSON | AuthenticationResponseJSON,
    checkApproval: (binding: ApprovalBinding) => void): Promise<{ binding?: ApprovalBinding; authorizationTicket?: string; registrationTicket?: string; recovered?: boolean }> {
    const session = this.session(sessionId, csrf);
    const challenge = this.read<Challenge>(challengeId, "challenge", true);
    if (challenge.sessionId !== sessionId || challenge.credentialVersion !== this.version()) throw new SecurityError();
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    if (challenge.binding) this.storage.sql.exec("INSERT INTO oauth_state VALUES (?, 'security_approval_attempt', ?, ?)", challengeId, JSON.stringify({ sessionId, proposalId: challenge.binding.proposalId }), session.expiresAt);
    assertSameOriginCeremony(response.response.clientDataJSON);
    const register = challenge.operation === "register" || challenge.operation === "recover";
    let credential: WebAuthnCredential;
    let previousCounter = 0;
    if (register) {
      const verified = await verifyRegistrationResponse({ response: response as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
      if (!verified.verified) throw new SecurityError();
      credential = verified.registrationInfo.credential;
    } else {
      credential = this.credential(response.id);
      previousCounter = credential.counter;
      const verified = await verifyAuthenticationResponse({ response: response as AuthenticationResponseJSON, credential, expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true });
      if (!verified.verified) throw new SecurityError();
      credential = { ...credential, counter: verified.authenticationInfo.newCounter };
    }
    return this.storage.transactionSync(() => {
      this.session(sessionId, csrf);
      if (challenge.expiresAt <= Date.now() || challenge.credentialVersion !== this.version()) throw new SecurityError();
      if (session.pending && (this.policy(session.pending.authRequest.clientId).version !== session.pending.policyVersion || challenge.policyVersion !== session.pending.policyVersion)) throw new SecurityError("SECURITY_POLICY_CHANGED");
      if (challenge.binding) checkApproval(challenge.binding);
      if (!register && this.credential(credential.id).counter !== previousCounter) throw new SecurityError();
      if (challenge.operation === "recover") {
        if (!session.recovery) throw new SecurityError();
        this.storage.sql.exec("DELETE FROM passkey");
        this.insertCredential(credential, challenge.name);
        this.storage.sql.exec("UPDATE owner_security SET version = version + 1 WHERE id = 1");
        this.storage.sql.exec("DELETE FROM oauth_state WHERE kind LIKE 'security_%'");
        this.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED', updated_at = ? WHERE approval_method = 'passkey' AND status = 'PENDING'", Date.now());
        return { recovered: true };
      }
      if (register) {
        if (this.credentials().length !== 0) throw new SecurityError();
        this.insertCredential(credential, challenge.name);
      } else {
        this.storage.sql.exec("UPDATE passkey SET credential = ? WHERE id = ?", JSON.stringify({ ...credential, publicKey: encodeBytes(credential.publicKey) }), credential.id);
      }
      if (challenge.operation === "delete") {
        if (this.credentials().length <= 1) throw new SecurityError();
        this.storage.sql.exec("DELETE FROM passkey WHERE id = ?", challenge.target);
      }
      if (challenge.operation === "rename") this.storage.sql.exec("UPDATE passkey SET name = ? WHERE id = ?", challenge.name, challenge.target);
      if (challenge.operation === "add") {
        return { registrationTicket: this.save("add", { sessionId, credentialVersion: this.version() }, Math.min(Date.now() + 120_000, session.expiresAt)) };
      }
      if ((challenge.operation === "authorize" || challenge.operation === "register") && session.pending) {
        // Session cannot approve a second authorization after ticket issuance.
        this.storage.sql.exec("DELETE FROM oauth_state WHERE state = ?", sessionId);
        return { authorizationTicket: this.save("authorization", { pending: session.pending, credentialVersion: this.version() }, Date.now() + 120_000) };
      }
      return challenge.binding ? { binding: challenge.binding } : {};
    });
  }
  async addOptions(sessionId: string, csrf: string, ticket: string, name: string) {
    this.session(sessionId, csrf);
    const proof = this.read<{ sessionId: string; credentialVersion: number }>(ticket, "add", true);
    if (proof.sessionId !== sessionId || proof.credentialVersion !== this.version()) throw new SecurityError();
    // Only the verified add ticket enables another registration.
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    if (!name.trim() || name.length > 80) throw new SecurityError();
    const options = await generateRegistrationOptions({ rpName: "Schwab MCP", rpID: origin.hostname, userName: this.env.ALLOWED_GITHUB_USER_ID, userID: new TextEncoder().encode(this.env.ALLOWED_GITHUB_USER_ID), attestationType: "none", supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, excludeCredentials: this.credentials().map(c => ({ id: c.id })) });
    this.session(sessionId, csrf);
    const expiresAt = Math.min(Date.now() + 120_000, this.session(sessionId).expiresAt);
    const challengeId = this.save("add_registration", { sessionId, credentialVersion: this.version(), challenge: options.challenge, expiresAt, name }, expiresAt);
    return { challengeId, options, registration: true };
  }
  async addVerify(sessionId: string, csrf: string, challengeId: string, response: RegistrationResponseJSON) {
    this.session(sessionId, csrf);
    const challenge = this.read<{ sessionId: string; credentialVersion: number; challenge: string; expiresAt: number; name: string }>(challengeId, "add_registration", true);
    if (challenge.sessionId !== sessionId || challenge.credentialVersion !== this.version()) throw new SecurityError();
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    assertSameOriginCeremony(response.response.clientDataJSON);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] });
    this.storage.transactionSync(() => {
      this.session(sessionId, csrf);
      if (!result.verified || challenge.expiresAt <= Date.now() || challenge.credentialVersion !== this.version()) throw new SecurityError();
      this.insertCredential(result.registrationInfo.credential, challenge.name);
    });
  }
}
