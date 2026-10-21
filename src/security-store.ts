import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCredential } from "@simplewebauthn/server";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { AppEnv } from "./env";
import type { PermissionLevel } from "./oauth-access";
import { accountSelectionSchema } from "./account-access";
import { AUTHORIZATION_VERSION } from "./oauth-access";
import { canonicalJson, randomToken, sha256 } from "./trading";
import { authenticationResponseSchema, registrationResponseSchema } from "./security-validation";

export interface ClientIdentity {
  clientId: string;
  advancedSecurity: boolean;
  securityPolicyVersion: number;
}
export interface ClientPolicy {
  clientId: string;
  permissionLevel: PermissionLevel;
  advancedSecurity: boolean;
  version: number;
  revoked: boolean;
  updatedAt: number;
}
export interface PendingAuthorization {
  authRequest: AuthRequest;
  permissionLevel: PermissionLevel;
  advancedSecurity: boolean;
  username: string;
  policyVersion: number;
  allowedAccountHashes?: string[] | undefined;
}
export type ClientAuthorizationStatus =
  | "PENDING"
  | "APPROVED"
  | "FINISHING"
  | "COMPLETED"
  | "CANCELLED"
  | "INVALIDATED"
  | "FAILED";

export interface ClientAuthorization {
  id: string;
  intent: PendingAuthorization;
  clientName: string;
  origin: string;
  digest: string;
  originalSessionId: string;
  credentialVersion: number;
  authorizationVersion: string;
  requiresPasskey: boolean;
  createdAt: number;
  expiresAt: number;
  status: ClientAuthorizationStatus;
  approvedAt?: number;
  finishingId?: string;
  committedPolicyVersion?: number;
  authorizationEventId?: string;
}

export interface BrowserSession {
  csrf: string;
  credentialVersion: number;
  expiresAt: number;
  recovery: boolean;
  pendingAuthorizationId?: string | undefined;
}
interface CredentialRow { [key: string]: string | number; id: string; name: string; credential: string }
export interface ApprovalBinding {
  proposalId: string;
  intentDigest: string;
  clientId: string;
  policyVersion: number;
  expiresAt: number;
}
interface DashboardPolicyBinding {
  clientId: string;
  advancedSecurity: boolean;
  permissionLevel: PermissionLevel;
  version: number;
}
interface Challenge {
  sessionId: string;
  credentialVersion: number;
  operation: "register" | "recover" | "client-authorization" | "add" | "delete" | "rename" | "approve" | "dashboard-policy";
  challenge: string;
  expiresAt: number;
  target: string;
  name: string;
  binding?: ApprovalBinding;
  policyVersion?: number;
  dashboardPolicy?: DashboardPolicyBinding;
  registration?: boolean;
  authorizationId?: string;
  authorizationDigest?: string;
}
export class SecurityError extends Error {
  constructor(public code: "SECURITY_VERIFICATION_FAILED" | "SECURITY_POLICY_CHANGED" | "BROWSER_AUTH_REQUIRED" | "ACCOUNT_ACCESS_DENIED" = "SECURITY_VERIFICATION_FAILED") {
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
  let clientData: unknown;
  try { clientData = JSON.parse(new TextDecoder().decode(decodeBytes(clientDataJSON))); }
  catch { throw new SecurityError(); }
  if (!clientData || typeof clientData !== "object" || Array.isArray(clientData)) throw new SecurityError();
  const crossOrigin: unknown = Reflect.get(clientData, "crossOrigin");
  if ((crossOrigin !== undefined && crossOrigin !== false) || Reflect.get(clientData, "topOrigin") !== undefined) throw new SecurityError();
}

// All state is in the owner SQLite DO. No OAuth KV key layout is used here.
export class SecurityStore {
  constructor(private storage: DurableObjectStorage, private env: AppEnv) {
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS owner_security (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO owner_security VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS passkey (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_security (
        client_id TEXT PRIMARY KEY,
        advanced INTEGER NOT NULL,
        version INTEGER NOT NULL,
        permission_level TEXT NOT NULL DEFAULT 'read_only',
        permission_initialized INTEGER NOT NULL DEFAULT 1,
        revoked INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS client_authorization_finishing (
        client_id TEXT PRIMARY KEY,
        authorization_id TEXT NOT NULL UNIQUE,
        finishing_id TEXT NOT NULL
      );
      INSERT OR IGNORE INTO client_authorization_finishing (client_id, authorization_id, finishing_id)
        SELECT json_extract(payload, '$.intent.authRequest.clientId'), state, json_extract(payload, '$.finishingId')
        FROM oauth_state
        WHERE kind = 'security_client_authorization'
          AND json_extract(payload, '$.status') = 'FINISHING'
          AND json_extract(payload, '$.finishingId') IS NOT NULL;
    `);
    storage.sql.exec("CREATE TABLE IF NOT EXISTS client_accounts (client_id TEXT PRIMARY KEY, hashes TEXT NOT NULL)");
    const clientColumns = new Set(storage.sql.exec<{ name: string }>("PRAGMA table_info(client_security)").toArray().map(row => row.name));
    for (const [name, definition] of Object.entries({
      // Legacy policies had no permission authority. Seed their permission once
      // from validated token/grant metadata, never from a migration default.
      permission_level: "TEXT NOT NULL DEFAULT 'read_only'",
      permission_initialized: "INTEGER NOT NULL DEFAULT 0",
      revoked: "INTEGER NOT NULL DEFAULT 0",
      updated_at: "INTEGER NOT NULL DEFAULT 0",
    })) if (!clientColumns.has(name)) storage.sql.exec(`ALTER TABLE client_security ADD COLUMN ${name} ${definition}`);
    for (const table of ["trade_proposal", "delayed_trade"]) {
      const columns = new Set(storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
      for (const [name, definition] of Object.entries({
        approval_method: "TEXT NOT NULL DEFAULT 'conversation'",
        client_id: "TEXT",
        policy_version: "INTEGER NOT NULL DEFAULT 0",
      })) if (!columns.has(name)) storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    storage.sql.exec(`UPDATE delayed_trade SET status = 'PAUSED', updated_at = ?
      WHERE status = 'ACTIVE' AND NOT EXISTS (
        SELECT 1 FROM client_accounts, json_each(client_accounts.hashes)
        WHERE client_accounts.client_id = delayed_trade.client_id AND json_each.value = delayed_trade.account_hash
      )`, Date.now());
  }
  accounts(clientId: string): string[] {
    const row = this.storage.sql.exec<{ hashes: string }>("SELECT hashes FROM client_accounts WHERE client_id = ?", clientId).toArray()[0];
    return row ? accountSelectionSchema.parse(JSON.parse(row.hashes) as unknown) : [];
  }
  setAccounts(clientId: string, hashes: string[]): void {
    const selected = accountSelectionSchema.parse(hashes);
    this.storage.sql.exec("INSERT INTO client_accounts (client_id, hashes) VALUES (?, ?) ON CONFLICT(client_id) DO UPDATE SET hashes = excluded.hashes", clientId, JSON.stringify(selected));
    this.storage.sql.exec(
      "UPDATE delayed_trade SET status = 'PAUSED', updated_at = ? WHERE client_id = ? AND status = 'ACTIVE' AND account_hash NOT IN (SELECT value FROM json_each(?))",
      Date.now(), clientId, JSON.stringify(selected),
    );
  }
  assertAccount(clientId: string, hash: string): void {
    if (!this.accounts(clientId).includes(hash)) throw new SecurityError("ACCOUNT_ACCESS_DENIED");
  }
  assertReadIdentity(identity: ClientIdentity): void {
    const row = this.storage.sql.exec<{ permission_initialized: number }>("SELECT permission_initialized FROM client_security WHERE client_id = ?", identity.clientId).toArray()[0];
    if (row?.permission_initialized !== 1) throw new SecurityError("SECURITY_POLICY_CHANGED");
    const policy = this.policy(identity.clientId);
    if (policy.revoked || policy.version !== identity.securityPolicyVersion || policy.advancedSecurity !== identity.advancedSecurity) throw new SecurityError("SECURITY_POLICY_CHANGED");
  }
  version(): number { return this.storage.sql.exec<{ version: number }>("SELECT version FROM owner_security WHERE id = 1").one().version; }
  policy(clientId: string): ClientPolicy {
    const row = this.storage.sql.exec<{ advanced: number; version: number; permission_level: string; revoked: number; updated_at: number }>(
      "SELECT advanced, version, permission_level, revoked, updated_at FROM client_security WHERE client_id = ?",
      clientId,
    ).toArray()[0];
    return {
      clientId,
      permissionLevel: row?.permission_level === "full_access" ? "full_access" : "read_only",
      advancedSecurity: row?.advanced === 1,
      version: row?.version ?? 0,
      revoked: row?.revoked === 1,
      updatedAt: row?.updated_at ?? 0,
    };
  }
  policies(): ClientPolicy[] {
    return this.storage.sql.exec<{ client_id: string; advanced: number; version: number; permission_level: string; revoked: number; updated_at: number }>(
      "SELECT client_id, advanced, version, permission_level, revoked, updated_at FROM client_security ORDER BY client_id",
    ).toArray().map(row => ({
      clientId: row.client_id,
      permissionLevel: row.permission_level === "full_access" ? "full_access" : "read_only",
      advancedSecurity: row.advanced === 1,
      version: row.version,
      revoked: row.revoked === 1,
      updatedAt: row.updated_at,
    }));
  }
  ensurePolicy(clientId: string, permissionLevel: PermissionLevel, advancedSecurity: boolean, version: number): ClientPolicy {
    const existing = this.storage.sql.exec<{ permission_initialized: number }>("SELECT permission_initialized FROM client_security WHERE client_id = ?", clientId).toArray()[0];
    if (existing) {
      if (existing.permission_initialized === 0) this.storage.sql.exec(
        "UPDATE client_security SET permission_level = ?, permission_initialized = 1, updated_at = ? WHERE client_id = ? AND permission_initialized = 0",
        permissionLevel, Date.now(), clientId,
      );
      return this.policy(clientId);
    }
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT INTO client_security (client_id, advanced, version, permission_level, permission_initialized, revoked, updated_at) VALUES (?, ?, ?, ?, 1, 0, ?)",
      clientId,
      advancedSecurity ? 1 : 0,
      version,
      permissionLevel,
      now,
    );
    return {
      clientId,
      permissionLevel,
      advancedSecurity,
      version,
      revoked: false,
      updatedAt: now,
    };
  }
  assertIdentity(identity: ClientIdentity): void {
    const row = this.storage.sql.exec<{ advanced: number; version: number; permission_level: string; revoked: number; permission_initialized: number }>(
      "SELECT advanced, version, permission_level, revoked, permission_initialized FROM client_security WHERE client_id = ?",
      identity.clientId,
    ).toArray()[0];
    if (!row || row.permission_initialized !== 1) throw new SecurityError("SECURITY_POLICY_CHANGED");
    if (row.revoked === 1 || row.permission_level !== "full_access" || row.version !== identity.securityPolicyVersion || (row.advanced === 1) !== identity.advancedSecurity) {
      throw new SecurityError("SECURITY_POLICY_CHANGED");
    }
  }
  commitPolicy(clientId: string, advancedSecurity: boolean, expected: number, permissionLevel?: PermissionLevel): ClientPolicy {
    return this.storage.transactionSync(() => {
      const current = this.policy(clientId);
      if (current.version !== expected) throw new SecurityError("SECURITY_POLICY_CHANGED");
      const version = expected + 1;
      const perm = permissionLevel ?? current.permissionLevel;
      const now = Date.now();
      this.storage.sql.exec(
        `INSERT INTO client_security (client_id, advanced, version, permission_level, permission_initialized, revoked, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           advanced = excluded.advanced,
           version = excluded.version,
           permission_level = excluded.permission_level,
           permission_initialized = 1,
           revoked = excluded.revoked,
           updated_at = excluded.updated_at`,
        clientId,
        advancedSecurity ? 1 : 0,
        version,
        perm,
        now,
      );
      this.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED', updated_at = ? WHERE client_id = ? AND status = 'PENDING'", now, clientId);
      return {
        clientId,
        permissionLevel: perm,
        advancedSecurity,
        version,
        revoked: false,
        updatedAt: now,
      };
    });
  }
  updatePolicy(clientId: string, updates: { permissionLevel?: PermissionLevel | undefined; advancedSecurity?: boolean | undefined; revoked?: boolean | undefined }, expected?: number): ClientPolicy {
    return this.storage.transactionSync(() => {
      const current = this.policy(clientId);
      if (expected !== undefined && current.version !== expected) throw new SecurityError("SECURITY_POLICY_CHANGED");
      const version = current.version + 1;
      const advancedSecurity = updates.advancedSecurity ?? current.advancedSecurity;
      const permissionLevel = updates.permissionLevel ?? current.permissionLevel;
      const revoked = updates.revoked ?? current.revoked;
      const now = Date.now();
      this.storage.sql.exec(
        `INSERT INTO client_security (client_id, advanced, version, permission_level, permission_initialized, revoked, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(client_id) DO UPDATE SET
           advanced = excluded.advanced,
           version = excluded.version,
           permission_level = excluded.permission_level,
           permission_initialized = 1,
           revoked = excluded.revoked,
           updated_at = excluded.updated_at`,
        clientId,
        advancedSecurity ? 1 : 0,
        version,
        permissionLevel,
        revoked ? 1 : 0,
        now,
      );
      this.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED', updated_at = ? WHERE client_id = ? AND status = 'PENDING'", now, clientId);
      return {
        clientId,
        permissionLevel,
        advancedSecurity,
        version,
        revoked,
        updatedAt: now,
      };
    });
  }
  save(kind: string, payload: unknown, expiresAt: number, explicitId?: string): string {
    this.storage.sql.exec("DELETE FROM oauth_state WHERE expires_at <= ?", Date.now());
    const id = explicitId ?? randomToken();
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
  createSession(recovery = false, pendingAuthorizationId?: string): { sessionId: string; session: BrowserSession } {
    const session: BrowserSession = {
      csrf: randomToken(),
      credentialVersion: this.version(),
      expiresAt: Date.now() + 15 * 60_000,
      recovery,
      ...(pendingAuthorizationId ? { pendingAuthorizationId } : {}),
    };
    return { sessionId: this.save("session", session, session.expiresAt), session };
  }
  session(id: string, csrf?: string): BrowserSession {
    const session = this.read<BrowserSession>(id, "session");
    if (Reflect.has(session, "pending")) {
      this.storage.sql.exec("DELETE FROM oauth_state WHERE state = ? AND kind = 'security_session'", id);
      throw new SecurityError("BROWSER_AUTH_REQUIRED");
    }
    if (session.credentialVersion !== this.version() || (csrf !== undefined && session.csrf !== csrf)) throw new SecurityError("BROWSER_AUTH_REQUIRED");
    return session;
  }
  dashboardSession(id: string, csrf?: string): BrowserSession {
    const session = this.session(id, csrf);
    if (session.recovery || session.pendingAuthorizationId) throw new SecurityError("BROWSER_AUTH_REQUIRED");
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
  async options(sessionId: string, csrf: string, operation: Challenge["operation"], target = "", name = "Passkey", binding?: ApprovalBinding, resetConfirmation?: string, dashboardPolicy?: DashboardPolicyBinding) {
    const session = this.session(sessionId, csrf);
    const count = this.credentials().length;
    if (session.recovery && operation !== "recover") throw new SecurityError();
    if (session.pendingAuthorizationId) throw new SecurityError();
    if (operation === "dashboard-policy") {
      this.dashboardSession(sessionId, csrf);
      if (!dashboardPolicy) throw new SecurityError();
      this.checkDashboardPolicy(dashboardPolicy);
    }
    if (operation === "recover" && (!session.recovery || resetConfirmation !== "重置全部 Passkey")) throw new SecurityError();
    if (operation === "register" && count > 0) throw new SecurityError();
    if (operation === "approve" && !binding) throw new SecurityError();
    if ((operation === "delete" || operation === "rename") && !this.credentials().some(c => c.id === target)) throw new SecurityError();
    if (operation === "delete" && count <= 1) throw new SecurityError();
    if (!["register", "recover"].includes(operation) && count === 0 && !(operation === "dashboard-policy" && dashboardPolicy?.advancedSecurity)) throw new SecurityError();
    if (name.trim().length < 1 || name.length > 80) throw new SecurityError();
    const register = operation === "register" || operation === "recover" || (operation === "dashboard-policy" && count === 0);
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
    if (dashboardPolicy) this.checkDashboardPolicy(dashboardPolicy);
    const expiresAt = Math.min(Date.now() + 120_000, session.expiresAt, binding?.expiresAt ?? Infinity);
    const challenge: Challenge = {
      sessionId, credentialVersion: session.credentialVersion, operation, target, name, expiresAt, challenge: options.challenge,
      ...(binding ? { binding } : {}),
      ...(dashboardPolicy ? { dashboardPolicy } : {}), registration: register,
    };
    if (expiresAt <= Date.now()) throw new SecurityError();
    const challengeId = this.save("challenge", challenge, expiresAt);
    return { challengeId, options, registration: register };
  }
  private checkDashboardPolicy(binding: DashboardPolicyBinding): void {
    const policy = this.policy(binding.clientId);
    if (policy.revoked || policy.version !== binding.version || policy.permissionLevel !== binding.permissionLevel ||
      (binding.advancedSecurity && policy.permissionLevel !== "full_access")) throw new SecurityError("SECURITY_POLICY_CHANGED");
  }
  async dashboardPolicyOptions(sessionId: string, csrf: string, clientId: string, advancedSecurity: boolean) {
    const policy = this.policy(clientId);
    return this.options(sessionId, csrf, "dashboard-policy", "", "Passkey", undefined, undefined,
      { clientId, advancedSecurity, permissionLevel: policy.permissionLevel, version: policy.version });
  }
  // Consume before crypto; recheck all mutable bindings after crypto before committing.
  async verify(sessionId: string, csrf: string, challengeId: string, response: RegistrationResponseJSON | AuthenticationResponseJSON,
    checkApproval: (binding: ApprovalBinding) => void, dashboardPolicy?: { clientId: string; advancedSecurity: boolean }): Promise<{ binding?: ApprovalBinding; authorizationTicket?: string; registrationTicket?: string; recovered?: boolean; policy?: ClientPolicy }> {
    const session = this.session(sessionId, csrf);
    const challenge = this.read<Challenge>(challengeId, "challenge", true);
    if (challenge.sessionId !== sessionId || challenge.credentialVersion !== this.version()) throw new SecurityError();
    if (challenge.dashboardPolicy) {
      this.dashboardSession(sessionId, csrf);
      if (!dashboardPolicy || dashboardPolicy.clientId !== challenge.dashboardPolicy.clientId || dashboardPolicy.advancedSecurity !== challenge.dashboardPolicy.advancedSecurity) throw new SecurityError();
      this.checkDashboardPolicy(challenge.dashboardPolicy);
    } else if (dashboardPolicy) throw new SecurityError();
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    if (challenge.binding) this.storage.sql.exec("INSERT INTO oauth_state VALUES (?, 'security_approval_attempt', ?, ?)", challengeId, JSON.stringify({ sessionId, proposalId: challenge.binding.proposalId }), session.expiresAt);
    assertSameOriginCeremony(response.response.clientDataJSON);
    const register = challenge.registration ?? (challenge.operation === "register" || challenge.operation === "recover");
    let credential: WebAuthnCredential;
    let previousCounter = 0;
    if (register) {
      const verified = await verifyRegistrationResponse({ response: registrationResponseSchema.parse(response), expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] }).catch(() => { throw new SecurityError(); });
      if (!verified.verified) throw new SecurityError();
      credential = verified.registrationInfo.credential;
    } else {
      credential = this.credential(response.id);
      previousCounter = credential.counter;
      const verified = await verifyAuthenticationResponse({ response: authenticationResponseSchema.parse(response), credential, expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true }).catch(() => { throw new SecurityError(); });
      if (!verified.verified) throw new SecurityError();
      credential = { ...credential, counter: verified.authenticationInfo.newCounter };
    }
    return this.storage.transactionSync(() => {
      this.session(sessionId, csrf);
      if (challenge.expiresAt <= Date.now() || challenge.credentialVersion !== this.version()) throw new SecurityError();
      // Normal ceremony session check
      if (challenge.binding) checkApproval(challenge.binding);
      if (challenge.dashboardPolicy) {
        this.dashboardSession(sessionId, csrf);
        this.checkDashboardPolicy(challenge.dashboardPolicy);
      }
      if (!register && this.credential(credential.id).counter !== previousCounter) throw new SecurityError();
      if (challenge.operation === "recover") {
        if (!session.recovery) throw new SecurityError();
        this.storage.sql.exec("DELETE FROM passkey");
        this.insertCredential(credential, challenge.name);
        this.storage.sql.exec("UPDATE owner_security SET version = version + 1 WHERE id = 1");
        this.storage.sql.exec("DELETE FROM oauth_state WHERE kind LIKE 'security_%'");
        this.storage.sql.exec("UPDATE trade_proposal SET status = 'INVALIDATED', updated_at = ? WHERE approval_method = 'passkey' AND status = 'PENDING'", Date.now());
        this.storage.sql.exec("UPDATE push_subscription SET disabled_at = ?, disabled_reason = 'PASSKEY_RECOVERY' WHERE disabled_at IS NULL", Date.now());
        this.storage.sql.exec("UPDATE notification_delivery SET status = 'SUPPRESSED' WHERE status IN ('PENDING', 'SENDING')");
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
      if (challenge.dashboardPolicy) return {
        policy: this.updatePolicy(challenge.dashboardPolicy.clientId, { advancedSecurity: challenge.dashboardPolicy.advancedSecurity }, challenge.dashboardPolicy.version),
      };
      if (challenge.operation === "add") {
        return { registrationTicket: this.save("add", { sessionId, credentialVersion: this.version() }, Math.min(Date.now() + 120_000, session.expiresAt)) };
      }
      // Client authorization handled by clientAuthorizationVerify
      return challenge.binding ? { binding: challenge.binding } : {};
    });
  }
  async addOptions(sessionId: string, csrf: string, ticket: string, name: string) {
    this.dashboardSession(sessionId, csrf);
    const proof = this.read<{ sessionId: string; credentialVersion: number }>(ticket, "add", true);
    if (proof.sessionId !== sessionId || proof.credentialVersion !== this.version()) throw new SecurityError();
    // Only the verified add ticket enables another registration.
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    if (!name.trim() || name.length > 80) throw new SecurityError();
    const options = await generateRegistrationOptions({ rpName: "Schwab MCP", rpID: origin.hostname, userName: this.env.ALLOWED_GITHUB_USER_ID, userID: new TextEncoder().encode(this.env.ALLOWED_GITHUB_USER_ID), attestationType: "none", supportedAlgorithmIDs: [-7, -257], authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, excludeCredentials: this.credentials().map(c => ({ id: c.id })) });
    this.dashboardSession(sessionId, csrf);
    const expiresAt = Math.min(Date.now() + 120_000, this.session(sessionId).expiresAt);
    const challengeId = this.save("add_registration", { sessionId, credentialVersion: this.version(), challenge: options.challenge, expiresAt, name }, expiresAt);
    return { challengeId, options, registration: true };
  }
  async addVerify(sessionId: string, csrf: string, challengeId: string, response: RegistrationResponseJSON) {
    this.dashboardSession(sessionId, csrf);
    const challenge = this.read<{ sessionId: string; credentialVersion: number; challenge: string; expiresAt: number; name: string }>(challengeId, "add_registration", true);
    if (challenge.sessionId !== sessionId || challenge.credentialVersion !== this.version()) throw new SecurityError();
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    assertSameOriginCeremony(response.response.clientDataJSON);
    const result = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: origin.origin, expectedRPID: origin.hostname, requireUserVerification: true, supportedAlgorithmIDs: [-7, -257] }).catch(() => { throw new SecurityError(); });
    this.storage.transactionSync(() => {
      this.dashboardSession(sessionId, csrf);
      if (!result.verified || challenge.expiresAt <= Date.now() || challenge.credentialVersion !== this.version()) throw new SecurityError();
      this.insertCredential(result.registrationInfo.credential, challenge.name);
    });
  }

  async beginClientAuthorization(
    intent: PendingAuthorization,
    clientName: string,
    currentAdvanced: boolean
  ): Promise<{ sessionId: string; authorizationId: string; requiresPasskey: boolean; status: ClientAuthorizationStatus }> {
    const now = Date.now();
    const expiresAt = now + 15 * 60_000;
    const requiresPasskey = intent.advancedSecurity || currentAdvanced;
    const status: ClientAuthorizationStatus = requiresPasskey ? "PENDING" : "APPROVED";

    const previousAuths = this.storage.sql.exec<{ state: string; payload: string }>(
      "SELECT state, payload FROM oauth_state WHERE kind = 'security_client_authorization'"
    ).toArray();
    for (const row of previousAuths) {
      const item = JSON.parse(row.payload) as ClientAuthorization;
      if (item.intent.authRequest.clientId === intent.authRequest.clientId && ["PENDING", "APPROVED"].includes(item.status)) {
        item.status = "INVALIDATED";
        this.storage.sql.exec(
          "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
          JSON.stringify(item),
          row.state
        );
      }
    }

    const authorizationId = crypto.randomUUID();
    const { sessionId } = this.createSession(false, authorizationId);

    const origin = new URL(this.env.SCHWAB_REDIRECT_URI).origin;
    const digest = await sha256(canonicalJson({
      clientId: intent.authRequest.clientId,
      permissionLevel: intent.permissionLevel,
      advancedSecurity: intent.advancedSecurity,
      policyVersion: intent.policyVersion,
      allowedAccountHashes: intent.allowedAccountHashes ?? [],
      redirectUri: intent.authRequest.redirectUri,
      codeChallenge: intent.authRequest.codeChallenge ?? null,
      origin,
      credentialVersion: this.version(),
      authorizationVersion: AUTHORIZATION_VERSION,
      originalSessionId: sessionId,
    }));

    const record: ClientAuthorization = {
      id: authorizationId,
      intent,
      clientName,
      origin,
      digest,
      originalSessionId: sessionId,
      credentialVersion: this.version(),
      authorizationVersion: AUTHORIZATION_VERSION,
      requiresPasskey,
      createdAt: now,
      expiresAt,
      status,
      ...(requiresPasskey ? {} : { approvedAt: now }),
    };
    this.save("client_authorization", record, expiresAt, authorizationId);
    return { sessionId, authorizationId, requiresPasskey, status };
  }

  getClientAuthorization(authorizationId: string): ClientAuthorization | null {
    const row = this.storage.sql.exec<{ payload: string; expires_at: number }>(
      "SELECT payload, expires_at FROM oauth_state WHERE state = ? AND kind = 'security_client_authorization'",
      authorizationId
    ).toArray()[0];
    if (!row) return null;
    const record = JSON.parse(row.payload) as ClientAuthorization;
    if (record.expiresAt <= Date.now() && (record.status === "PENDING" || record.status === "APPROVED")) {
      record.status = "FAILED";
    }
    return record;
  }

  assertCanAccessAuthorization(session: BrowserSession, authorization: ClientAuthorization): void {
    if (session.recovery) throw new SecurityError("BROWSER_AUTH_REQUIRED");
    if (session.pendingAuthorizationId && session.pendingAuthorizationId !== authorization.id) {
      throw new SecurityError("BROWSER_AUTH_REQUIRED");
    }
  }

  async clientAuthorizationOptions(sessionId: string, csrf: string, authorizationId: string) {
    const session = this.session(sessionId, csrf);
    const auth = this.getClientAuthorization(authorizationId);
    if (!auth || auth.status !== "PENDING" || auth.expiresAt <= Date.now()) {
      throw new SecurityError("SECURITY_VERIFICATION_FAILED");
    }
    this.assertCanAccessAuthorization(session, auth);

    const count = this.credentials().length;
    const register = count === 0;
    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    const options = register ? await generateRegistrationOptions({
      rpName: "Schwab MCP", rpID: origin.hostname, userName: this.env.ALLOWED_GITHUB_USER_ID,
      userID: new TextEncoder().encode(this.env.ALLOWED_GITHUB_USER_ID),
      attestationType: "none", supportedAlgorithmIDs: [-7, -257],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
      excludeCredentials: this.credentials().map(c => ({ id: c.id })),
    }) : await generateAuthenticationOptions({
      rpID: origin.hostname, userVerification: "required", allowCredentials: this.credentials().map(c => ({ id: c.id })),
    });

    this.session(sessionId, csrf);

    const expiresAt = Math.min(Date.now() + 120_000, session.expiresAt, auth.expiresAt);
    const challengeId = this.save("challenge", {
      sessionId,
      credentialVersion: this.version(),
      operation: "client-authorization",
      target: "",
      name: "Passkey",
      expiresAt,
      challenge: options.challenge,
      authorizationId: auth.id,
      authorizationDigest: auth.digest,
      policyVersion: auth.intent.policyVersion,
      registration: register,
    }, expiresAt);

    return { challengeId, options, registration: register };
  }

  async clientAuthorizationVerify(
    sessionId: string,
    csrf: string,
    challengeId: string,
    response: RegistrationResponseJSON | AuthenticationResponseJSON
  ): Promise<{ authorizationId: string; status: "APPROVED" }> {
    const session = this.session(sessionId, csrf);
    const challenge = this.read<Challenge>(challengeId, "challenge", true);
    if (challenge.sessionId !== sessionId || challenge.credentialVersion !== this.version() || challenge.operation !== "client-authorization" || !challenge.authorizationId) {
      throw new SecurityError();
    }
    const authorizationId = challenge.authorizationId;
    const auth = this.getClientAuthorization(authorizationId);
    if (!auth || auth.status !== "PENDING" || auth.expiresAt <= Date.now() || auth.digest !== challenge.authorizationDigest) {
      throw new SecurityError("SECURITY_VERIFICATION_FAILED");
    }
    this.assertCanAccessAuthorization(session, auth);

    const origin = new URL(this.env.SCHWAB_REDIRECT_URI);
    const register = challenge.registration === true;

    assertSameOriginCeremony(response.response.clientDataJSON);

    let credential: WebAuthnCredential;
    let previousCounter = 0;

    if (register) {
      if (this.credentials().length !== 0) throw new SecurityError();
      const result = await verifyRegistrationResponse({
        response: registrationResponseSchema.parse(response),
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin.origin,
        expectedRPID: origin.hostname,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      }).catch(() => { throw new SecurityError(); });
      if (!result.registrationInfo) throw new SecurityError();
      credential = {
        id: result.registrationInfo.credential.id,
        publicKey: result.registrationInfo.credential.publicKey,
        counter: result.registrationInfo.credential.counter,
        ...(result.registrationInfo.credential.transports !== undefined ? { transports: result.registrationInfo.credential.transports } : {}),
      };
    } else {
      credential = this.credential(response.id);
      previousCounter = credential.counter;
      const result = await verifyAuthenticationResponse({
        response: authenticationResponseSchema.parse(response),
        credential,
        expectedChallenge: challenge.challenge,
        expectedOrigin: origin.origin,
        expectedRPID: origin.hostname,
        requireUserVerification: true,
      }).catch(() => { throw new SecurityError(); });
      credential = { ...credential, counter: result.authenticationInfo.newCounter };
    }

    return this.storage.transactionSync(() => {
      this.session(sessionId, csrf);
      if (challenge.expiresAt <= Date.now() || challenge.credentialVersion !== this.version()) throw new SecurityError();
      const currentAuth = this.getClientAuthorization(authorizationId);
      if (!currentAuth || currentAuth.status !== "PENDING" || currentAuth.expiresAt <= Date.now() || currentAuth.digest !== challenge.authorizationDigest) {
        throw new SecurityError("SECURITY_VERIFICATION_FAILED");
      }

      if (!register && this.credential(credential.id).counter !== previousCounter) throw new SecurityError();

      if (register) {
        if (this.credentials().length !== 0) throw new SecurityError();
        this.insertCredential(credential, challenge.name);
      } else {
        this.storage.sql.exec("UPDATE passkey SET credential = ? WHERE id = ?", JSON.stringify({ ...credential, publicKey: encodeBytes(credential.publicKey) }), credential.id);
      }

      currentAuth.status = "APPROVED";
      currentAuth.approvedAt = Date.now();
      this.storage.sql.exec(
        "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
        JSON.stringify(currentAuth),
        currentAuth.id
      );

      return { authorizationId: currentAuth.id, status: "APPROVED" as const };
    });
  }

  clientAuthorizationCancel(sessionId: string, csrf: string, authorizationId: string): { cancelled: boolean } {
    const session = this.session(sessionId, csrf);
    const auth = this.getClientAuthorization(authorizationId);
    if (!auth) throw new SecurityError("SECURITY_VERIFICATION_FAILED");
    this.assertCanAccessAuthorization(session, auth);

    if (auth.status === "FINISHING") {
      throw new SecurityError("SECURITY_POLICY_CHANGED");
    }

    if (auth.status !== "PENDING" && auth.status !== "APPROVED") {
      return { cancelled: false };
    }

    auth.status = "CANCELLED";
    this.storage.sql.exec(
      "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
      JSON.stringify(auth),
      auth.id
    );
    return { cancelled: true };
  }
  clientAuthorizationFail(authorizationId: string): void {
    this.storage.transactionSync(() => {
      const auth = this.getClientAuthorization(authorizationId);
      if (auth && auth.status === "FINISHING") {
        auth.status = "FAILED";
        this.storage.sql.exec(
          "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
          JSON.stringify(auth),
          auth.id
        );
      }
      // Recovery may have removed the authorization envelope, but the provider
      // lifecycle still owns this exclusion until its cleanup has completed.
      this.storage.sql.exec("DELETE FROM client_authorization_finishing WHERE authorization_id = ?", authorizationId);
    });
  }


  claimClientAuthorization(
    authorizationId: string,
    sessionId: string,
    csrf?: string
  ): {
    intent: PendingAuthorization;
    finishingId: string;
    commitTicket: string;
    clientName: string;
  } {
    const session = this.session(sessionId, csrf);
    if (session.pendingAuthorizationId !== authorizationId) {
      throw new SecurityError("BROWSER_AUTH_REQUIRED");
    }

    return this.storage.transactionSync(() => {
      const auth = this.getClientAuthorization(authorizationId);
      if (!auth || auth.originalSessionId !== sessionId || auth.status !== "APPROVED" || auth.expiresAt <= Date.now() || auth.credentialVersion !== this.version()) {
        throw new SecurityError("SECURITY_VERIFICATION_FAILED");
      }

      const otherFinishing = this.storage.sql.exec<{ authorization_id: string }>(
        "SELECT authorization_id FROM client_authorization_finishing WHERE client_id = ?",
        auth.intent.authRequest.clientId
      ).toArray().length > 0;

      if (otherFinishing) {
        throw new SecurityError("SECURITY_POLICY_CHANGED");
      }

      const finishingId = crypto.randomUUID();
      this.storage.sql.exec(
        "INSERT INTO client_authorization_finishing (client_id, authorization_id, finishing_id) VALUES (?, ?, ?)",
        auth.intent.authRequest.clientId, authorizationId, finishingId
      );
      auth.status = "FINISHING";
      auth.finishingId = finishingId;

      this.storage.sql.exec(
        "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
        JSON.stringify(auth),
        auth.id
      );

      const commitTicket = this.save("commit", {
        authorizationId,
        finishingId,
        digest: auth.digest,
        credentialVersion: this.version(),
      }, Math.min(Date.now() + 120_000, auth.expiresAt));

      return {
        intent: auth.intent,
        finishingId,
        commitTicket,
        clientName: auth.clientName,
      };
    });
  }

  commitClientPolicy(
    ticket: string,
    clientId: string,
    permissionLevel: PermissionLevel,
    advancedSecurity: boolean,
    expectedVersion: number
  ): ClientPolicy {
    return this.storage.transactionSync(() => {
      const proof = this.read<{
        authorizationId: string;
        finishingId: string;
        digest: string;
        credentialVersion: number;
      }>(ticket, "commit", true);

      if (proof.credentialVersion !== this.version()) throw new SecurityError();

      const auth = this.getClientAuthorization(proof.authorizationId);
      if (!auth || auth.finishingId !== proof.finishingId || auth.status !== "FINISHING" || auth.digest !== proof.digest ||
          auth.credentialVersion !== this.version() || auth.expiresAt <= Date.now() ||
          auth.intent.authRequest.clientId !== clientId || auth.intent.permissionLevel !== permissionLevel ||
          auth.intent.advancedSecurity !== advancedSecurity || auth.intent.policyVersion !== expectedVersion) {
        throw new SecurityError("SECURITY_VERIFICATION_FAILED");
      }

      const updatedPolicy = this.updatePolicy(clientId, { permissionLevel, advancedSecurity }, expectedVersion);
      this.setAccounts(clientId, auth.intent.allowedAccountHashes ?? []);
      auth.committedPolicyVersion = updatedPolicy.version;

      const otherRows = this.storage.sql.exec<{ state: string; payload: string }>(
        "SELECT state, payload FROM oauth_state WHERE kind = 'security_client_authorization' AND state != ?",
        auth.id
      ).toArray();

      for (const row of otherRows) {
        const item = JSON.parse(row.payload) as ClientAuthorization;
        if (item.intent.authRequest.clientId === clientId && (item.status === "PENDING" || item.status === "APPROVED")) {
          item.status = "INVALIDATED";
          this.storage.sql.exec("UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'", JSON.stringify(item), row.state);
        }
      }

      this.storage.sql.exec("UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'", JSON.stringify(auth), auth.id);

      return updatedPolicy;
    });
  }

  finalizeClientAuthorization(
    authorizationId: string,
    finishingId: string,
    originalSessionId: string,
    authorizationEventId: string
  ): void {
    this.storage.transactionSync(() => {
      const auth = this.getClientAuthorization(authorizationId);
      if (!auth || auth.finishingId !== finishingId || auth.originalSessionId !== originalSessionId || auth.status !== "FINISHING" || auth.credentialVersion !== this.version()) {
        throw new SecurityError("SECURITY_VERIFICATION_FAILED");
      }
      const policy = this.policy(auth.intent.authRequest.clientId);
      if (auth.expiresAt <= Date.now() || auth.committedPolicyVersion !== policy.version || policy.revoked ||
          policy.permissionLevel !== auth.intent.permissionLevel || policy.advancedSecurity !== auth.intent.advancedSecurity) {
        throw new SecurityError("SECURITY_POLICY_CHANGED");
      }

      auth.status = "COMPLETED";
      auth.authorizationEventId = authorizationEventId;

      this.storage.sql.exec(
        "UPDATE oauth_state SET payload = ? WHERE state = ? AND kind = 'security_client_authorization'",
        JSON.stringify(auth),
        auth.id
      );

      this.storage.sql.exec(
        "DELETE FROM client_authorization_finishing WHERE authorization_id = ? AND finishing_id = ?",
        authorizationId, finishingId
      );
      this.storage.sql.exec("DELETE FROM oauth_state WHERE state = ? AND kind = 'security_session'", originalSessionId);
    });
  }
}
