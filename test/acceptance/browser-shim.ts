// In-memory software authenticator for the isolated cloud test, not a device Passkey.
import { authenticator } from "../webauthn-fixture";
declare const navigator: { credentials: object };
declare const location: { origin: string; hostname: string };
interface TestOptions { publicKey?: { challenge: BufferSource } }
const key = authenticator();
const encode = (buffer: BufferSource) => btoa(String.fromCharCode(...new Uint8Array(buffer as ArrayBuffer))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const decode = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0)).buffer;
async function credential(registration: boolean, options: TestOptions) {
  const publicKey = options.publicKey;
  if (!publicKey) throw new Error("Missing test challenge");
  const response = await (await key)[registration ? "register" : "authenticate"](encode(publicKey.challenge), { origin: location.origin, rp: location.hostname });
  const binary = Object.fromEntries(Object.entries(response.response).filter(([name]) => name !== "transports").map(([name, value]) => [name, decode(value as string)]));
  return { id: response.id, rawId: decode(response.rawId), type: response.type, response: { ...binary, getTransports: () => ["internal"] }, getClientExtensionResults: () => ({}) };
}
Object.defineProperty(navigator.credentials, "create", { value: (options: TestOptions) => credential(true, options) });
Object.defineProperty(navigator.credentials, "get", { value: (options: TestOptions) => credential(false, options) });
