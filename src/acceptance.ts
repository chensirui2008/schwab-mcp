// Opt-in acceptance routes in the existing Worker. Never reuse production identity or storage.
import worker from "./worker";
import { SchwabVault } from "./vault";
import { vaultStub, type AppEnv } from "./env";
import shim from "../.wrangler/oauth-test/browser-shim.js";

const ROOT = "/__test";
const HOST = "https://schwab-mcp.siruichen461.workers.dev";
const CROSS = "__Host-schwab-test-cross";
const GATE = "__Host-schwab-acceptance";
const RUN = "__Host-schwab-test-run";
const COOKIE_PREFIX = "__Host-schwab-test-";
const fake = {
  GITHUB_CLIENT_ID: "mock-client", GITHUB_CLIENT_SECRET: "mock-secret", ALLOWED_GITHUB_USER_ID: "123456",
  SCHWAB_CLIENT_ID: "mock-client", SCHWAB_CLIENT_SECRET: "mock-secret", ENABLE_TRADING: "false",
  SCHWAB_REDIRECT_URI: `${HOST}/auth/schwab/callback`,
  MARKET_DATA_BASE_URL: "https://blocked.invalid/market", TRADER_BASE_URL: "https://blocked.invalid/trader",
  APP_VERSION: "cloud-oauth-acceptance",
};
export class AcceptanceVault extends SchwabVault {
  constructor(ctx: DurableObjectState, env: AppEnv) { super(ctx, { ...env, ...fake }); }
  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    // No credentials or Schwab requests can enter this namespace, even with a leaked test token.
    if (!["/state", "/state/consume"].includes(path) && !path.startsWith("/security/")) {
      return Promise.resolve(new Response("Acceptance vault blocks account and trading operations", { status: 403 }));
    }
    return super.fetch(request);
  }
}
function cookie(request: Request, name: string): string | undefined {
  return request.headers.get("Cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(name + "="))?.slice(name.length + 1);
}
const setCookie = (name: string, value: string) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`;
function page(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>隔离 OAuth 验收</title><h1>隔离 OAuth 验收</h1><p>同一 Worker · 模拟 GitHub · 软件认证器 · 无 Schwab 连接 · 交易关闭</p>${body}</html>`, {
    status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", ...headers },
  });
}
function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const r = new Request(input, init), url = new URL(r.url);
  if (url.href === "https://github.com/login/oauth/access_token" && r.method === "POST") return Promise.resolve(Response.json({ access_token: "mock-token" }));
  if (url.href === "https://api.github.com/user" && r.method === "GET") return Promise.resolve(Response.json({ id: 123456, login: "acceptance-owner", name: null }));
  return Promise.resolve(new Response("External requests blocked", { status: 502 }));
}
function isolated(env: AppEnv, run: string, crossOrigin = false): AppEnv {
  const binding = env.ACCEPTANCE_VAULT;
  if (!binding || !env.ACCEPTANCE_KV) throw new Error("Acceptance bindings missing");
  return { ...env, ...fake, OAUTH_KV: env.ACCEPTANCE_KV,
    SCHWAB_VAULT: { get: () => binding.get(binding.idFromName(run)), idFromName: binding.idFromName.bind(binding), idFromString: binding.idFromString.bind(binding), newUniqueId: binding.newUniqueId.bind(binding), getByName: () => binding.get(binding.idFromName(run)), jurisdiction: binding.jurisdiction.bind(binding) },
    acceptanceGitHub: { url: crossOrigin ? "http://127.0.0.1:8797/authorize" : `${HOST}${ROOT}/mock/github`, fetch: mockFetch },
  };
}
async function state(env: AppEnv, path: string, body: unknown): Promise<Response> {
  return vaultStub(env).fetch(`https://vault${path}`, { method: "POST", body: JSON.stringify(body) });
}
function prefixLocation(value: string): string {
  const url = new URL(value, HOST);
  if (url.origin === HOST && !url.pathname.startsWith(ROOT + "/")) url.pathname = ROOT + url.pathname;
  return url.href;
}
async function dispatch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(ROOT.length) || "/";
  const headers = new Headers(request.headers);
  // Production cookies are never forwarded. Test cookies never use production cookie names on the wire.
  const cookies = (headers.get("Cookie") ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith(COOKIE_PREFIX) && !v.startsWith(RUN + "="));
  headers.delete("Cookie");
  if (cookies.length) headers.set("Cookie", cookies.map(v => v.replace(COOKIE_PREFIX, "__Host-schwab-")).join("; "));
  const response = await worker.fetch(new Request(url, new Request(request, { headers })), env, ctx);
  const out = new Headers(response.headers);
  const saved = out.getSetCookie(); out.delete("Set-Cookie");
  for (const value of saved) out.append("Set-Cookie", value.replace("__Host-schwab-", COOKIE_PREFIX));
  const location = out.get("Location"); if (location) out.set("Location", prefixLocation(location));
  if (!out.get("Content-Type")?.includes("text/html")) return new Response(response.body, { status: response.status, headers: out });
  let html = await response.text();
  // Rewrite only application root-relative literals; preserve third-party destinations and the CSP.
  html = html.replace(/(["'])\/(authorize|security)(?=[/"'?])/g, `$1${ROOT}/$2`);
  if (url.pathname === "/security") html = html.replace('<script id="page-data"', `<p>测试专用软件认证器，无系统凭据保存。</p><script>${shim}</script><script id="page-data"`);
  out.delete("Content-Length");
  return new Response(html, { status: response.status, headers: out });
}
export async function acceptanceFetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (!env.ACCEPTANCE_KEY || !env.ACCEPTANCE_KV || !env.ACCEPTANCE_VAULT) return new Response("Not found", { status: 404 });
  // A same-Worker mock is the default. A loopback provider can exercise real cross-origin navigation.
  if (url.origin === HOST && url.pathname === ROOT + "/mock/github" && cookie(request, GATE) === env.ACCEPTANCE_KEY) {
    if (url.searchParams.get("redirect_uri") !== HOST + "/auth/github/callback" || !/^[a-f0-9]{64}$/.test(url.searchParams.get("state") ?? "")) return page("Invalid mock request", 400);
    const callback = new URL(ROOT + "/auth/github/callback", HOST);
    callback.searchParams.set("state", url.searchParams.get("state") ?? ""); callback.searchParams.set("code", "mock-code");
    return new Response(null, { status: 302, headers: { Location: callback.href, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  if (url.origin !== HOST) return page("Invalid test origin", 403);
  if (url.pathname === ROOT + "/unlock" && request.method === "POST") {
    if ((request.headers.get("Origin") !== HOST && request.headers.get("Sec-Fetch-Site") !== "same-origin") || (await request.clone().arrayBuffer()).byteLength > 4096) return page("Invalid request", 403);
    const form = await request.formData();
    if (form.get("key") !== env.ACCEPTANCE_KEY) return page("Invalid access key", 403);
    const headers = new Headers({ Location: ROOT + "/" }); headers.append("Set-Cookie", setCookie(GATE, env.ACCEPTANCE_KEY));
    return new Response(null, { status: 303, headers });
  }
  if (cookie(request, GATE) !== env.ACCEPTANCE_KEY) return page(`<form method="post" action="${ROOT}/unlock"><label>测试访问密钥 <input name="key" type="password" required></label><button>进入测试</button></form>`, 401);
  if (url.pathname === ROOT + "/" || url.pathname === ROOT) return page(`<p>每次开始使用新的隔离测试状态。授权页请选择完整访问，增强模式再勾选 Advanced Security。</p><p><a href="${ROOT}/start?mode=plain">开始普通授权</a></p><p><a href="${ROOT}/start?mode=enhanced">开始增强授权</a></p>`);
  if (url.pathname === ROOT + "/start") {
    const mode = url.searchParams.get("mode") === "enhanced" ? "enhanced" : "plain";
    const run = crypto.randomUUID(), crossOrigin = url.searchParams.get("crossOrigin") === "1", test = isolated(env, run, crossOrigin), callback = HOST + ROOT + "/client/callback";
    const registration = await worker.fetch(new Request(HOST + "/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [callback], client_name: "Cloud acceptance " + mode, token_endpoint_auth_method: "none" }) }), test, ctx);
    const { client_id: clientId } = await registration.json<{ client_id: string }>();
    const verifier = crypto.randomUUID() + crypto.randomUUID(), flow = crypto.randomUUID();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    await state(test, "/state", { state: flow, kind: "acceptance_client", payload: { clientId, verifier, mode }, expiresAt: Date.now() + 600000 });
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: callback, response_type: "code", scope: "schwab.read", state: flow, code_challenge: challenge, code_challenge_method: "S256" });
    const headers = new Headers({ Location: `${ROOT}/authorize?${params}` }); headers.append("Set-Cookie", setCookie(RUN, run)); headers.append("Set-Cookie", setCookie(CROSS, crossOrigin ? "1" : "0"));
    return new Response(null, { status: 302, headers });
  }
  const run = cookie(request, RUN); if (!run || !/^[a-f0-9-]{36}$/.test(run)) return page("Start a fresh test", 400);
  const test = isolated(env, run, cookie(request, CROSS) === "1");
  if (url.pathname === ROOT + "/client/callback") {
    const consumed = await state(test, "/state/consume", { state: url.searchParams.get("state"), kind: "acceptance_client" });
    if (!consumed.ok || !url.searchParams.has("code")) return page("Invalid test callback", 400);
    const { payload: flow } = await consumed.json<{ payload: { clientId: string; verifier: string; mode: string } }>();
    const token = await worker.fetch(new Request(HOST + "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: flow.clientId, code: url.searchParams.get("code") ?? "", code_verifier: flow.verifier, redirect_uri: HOST + ROOT + "/client/callback" }) }), test, ctx);
    const tokens = await token.json<{ access_token?: string }>();
    const tools = await worker.fetch(new Request(HOST + "/mcp", { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token ?? ""}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), test, ctx);
    const list = await tools.text();
    const report = { mode: flow.mode, tokenExchange: token.status, mcpStatus: tools.status, prepareTrade: list.includes('"name":"prepare_trade"'), confirmTrade: list.includes('"name":"confirm_trade"'), tradingEnabled: false, realSchwabRequests: 0 };
    await env.ACCEPTANCE_KV.put("report:" + run, JSON.stringify(report), { expirationTtl: 3600 });
    return new Response(null, { status: 303, headers: { Location: ROOT + "/complete", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  if (url.pathname === ROOT + "/complete") return page(`<pre>${await env.ACCEPTANCE_KV.get("report:" + run) ?? "No report"}</pre><a href="${ROOT}/">返回</a>`);
  // No direct registration, token, MCP or Schwab API proxy is exposed to the test browser.
  if (!/^\/__test\/(authorize(?:\/approve)?|auth\/github\/callback|security(?:\/api\/(?:options|verify))?)$/.test(url.pathname)) return page("Test route blocked", 403);
  return dispatch(request, test, ctx);
}
