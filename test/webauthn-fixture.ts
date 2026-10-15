import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { decodeBytes, encodeBytes } from "../src/security-store";

function join(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(arrays.reduce((length, a) => length + a.length, 0));
  let offset = 0;
  for (const a of arrays) { bytes.set(a, offset); offset += a.length; }
  return bytes;
}
async function hash(value: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", value));
}

// A local software authenticator. Production verification is never mocked.
export async function authenticator() {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cose = new Map<number, number | Uint8Array>([[1, 3], [3, -257], [-1, decodeBytes(jwk.n ?? "")], [-2, decodeBytes(jwk.e ?? "")]]);
  const clientData = (type: string, challenge: string, origin: string, crossOrigin = false) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin }));
  const authData = async (rp: string, flags: number, counter: number) => {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, counter);
    return join(await hash(new TextEncoder().encode(rp)), new Uint8Array([flags]), count);
  };
  return {
    id: encodeBytes(id),
    async register(challenge: string, opts: { origin?: string; rp?: string; uv?: boolean } = {}): Promise<RegistrationResponseJSON> {
      const data = clientData("webauthn.create", challenge, opts.origin ?? "https://example.com");
      const credentialLength = new Uint8Array([0, id.length]);
      const bytes = join(await authData(opts.rp ?? "example.com", opts.uv === false ? 0x41 : 0x45, 0), new Uint8Array(16), credentialLength, id, isoCBOR.encode(cose));
      const attestation = isoCBOR.encode(new Map<string, string | Uint8Array | Map<string, string>>([["fmt", "none"], ["authData", bytes], ["attStmt", new Map()]]));
      return { id: encodeBytes(id), rawId: encodeBytes(id), type: "public-key", response: { clientDataJSON: encodeBytes(data), attestationObject: encodeBytes(attestation), transports: ["internal"] }, clientExtensionResults: {} };
    },
    async authenticate(challenge: string, opts: { origin?: string; rp?: string; uv?: boolean; counter?: number; crossOrigin?: boolean; badSignature?: boolean; type?: string } = {}): Promise<AuthenticationResponseJSON> {
      const data = clientData(opts.type ?? "webauthn.get", challenge, opts.origin ?? "https://example.com", opts.crossOrigin);
      const auth = await authData(opts.rp ?? "example.com", opts.uv === false ? 1 : 5, opts.counter ?? 0);
      const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, join(auth, await hash(data))));
      if (opts.badSignature) signature[0] = (signature[0] ?? 0) ^ 1;
      return { id: encodeBytes(id), rawId: encodeBytes(id), type: "public-key", response: { clientDataJSON: encodeBytes(data), authenticatorData: encodeBytes(auth), signature: encodeBytes(signature) }, clientExtensionResults: {} };
    },
  };
}
