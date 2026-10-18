// Isolated real-Worker PWA and Cross-Device OAuth acceptance fixture.
// All GitHub traffic is mocked; Schwab is unreachable; Web Push outbound requests are captured.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { URL, URLSearchParams } from 'node:url';
import console from 'node:console';

const { Response, Headers } = globalThis;
const origin = 'http://localhost:8799';
const github = 'http://127.0.0.1:8800';
const callback = 'http://localhost:8801/callback';

const bundle = await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
});

const keyBundle = await build({
  entryPoints: ['test/webauthn-fixture.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});

const { authenticator } = await import('data:text/javascript;base64,' + Buffer.from(keyBundle.outputFiles[0].text).toString('base64'));
const key = await authenticator();

const flows = new Map();
const results = [];
const pushEvents = [];
const stats = {
  githubAuthorizations: 0,
  mockTokenExchanges: 0,
  mockProfileReads: 0,
  pushDeliveriesIntercepted: 0,
  blockedUpstreamRequests: 0,
  realSchwabRequests: 0,
};

const mf = new Miniflare({
  modules: true,
  script: bundle.outputFiles[0].text,
  compatibilityDate: '2026-08-06',
  compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: ['OAUTH_KV'],
  durableObjects: { SCHWAB_VAULT: { className: 'SchwabVault', useSQLite: true } },
  assets: { directory: './public', routerConfig: { has_user_worker: true } },
  bindings: {
    GITHUB_CLIENT_ID: 'mock-client',
    GITHUB_CLIENT_SECRET: 'mock-secret',
    ALLOWED_GITHUB_USER_ID: '123456',
    SCHWAB_CLIENT_ID: 'mock-schwab',
    SCHWAB_CLIENT_SECRET: 'mock-secret',
    SCHWAB_REDIRECT_URI: origin + '/auth/schwab/callback',
    MARKET_DATA_BASE_URL: 'https://blocked.invalid/market',
    TRADER_BASE_URL: 'https://blocked.invalid/trader',
    ENABLE_TRADING: 'false',
    APP_VERSION: '0.2.0-pwa-acceptance',
  },
  outboundService: async request => {
    const u = new URL(request.url);
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/access_token' && request.method === 'POST') {
      stats.mockTokenExchanges++;
      return Response.json({ access_token: 'mock-github-token' });
    }
    if (u.origin === 'https://api.github.com' && u.pathname === '/user' && request.method === 'GET') {
      stats.mockProfileReads++;
      return Response.json({ id: 123456, login: 'mock-owner', name: null });
    }
    // Intercept Web Push standard endpoints (Apple or FCM)
    if (u.hostname.endsWith('push.apple.com') || u.hostname === 'fcm.googleapis.com') {
      stats.pushDeliveriesIntercepted++;
      const authHeader = request.headers.get('authorization') || '';
      const ttl = request.headers.get('ttl') || '';
      const urgency = request.headers.get('urgency') || '';
      const encoding = request.headers.get('content-encoding') || '';
      pushEvents.push({
        endpoint: u.href,
        hasVapid: authHeader.length > 0,
        ttl,
        urgency,
        encoding,
        timestamp: Date.now(),
      });
      return new Response(null, { status: 201 });
    }
    stats.blockedUpstreamRequests++;
    return new Response('External network disabled in acceptance', { status: 502 });
  },
});

const shim = `<script>
const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
async function testCredential(registration, {publicKey}) {
 const challenge=btoa(String.fromCharCode(...new Uint8Array(publicKey.challenge))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const r=await fetch('/__fixture/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registration,challenge})});
 const c=await r.json();
 const response=Object.fromEntries(Object.entries(c.response).filter(([k])=>k!=='transports').map(([k,v])=>[k,decode(v).buffer]));
 response.getTransports=()=>c.response.transports||[];
 return {id:c.id,rawId:decode(c.rawId).buffer,type:c.type,response,getClientExtensionResults:()=>({})};
}
if (window.PublicKeyCredential && navigator.credentials) {
 Object.defineProperty(navigator.credentials,'create',{value:o=>testCredential(true,o)});
 Object.defineProperty(navigator.credentials,'get',{value:o=>testCredential(false,o)});
}
</script>`;

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 65536) throw new Error('Fixture request too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, text, type = 'text/html; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function workerFetch(path, options = {}) {
  return mf.dispatchFetch(origin + path, { ...options, redirect: 'manual' });
}

// Seed fixture data into DO on startup
async function seedFixtureData() {
  const vault = (await mf.getDurableObjectNamespace('SCHWAB_VAULT')).get(
    (await mf.getDurableObjectNamespace('SCHWAB_VAULT')).idFromName('owner')
  );

  // Seed mock client policies and audits
  const now = Date.now();
  await vault.fetch('https://vault/client/policy?clientId=claude-desktop&ensure=true&permissionLevel=full_access&advancedSecurity=true&version=1');
  await vault.fetch('https://vault/client/policy?clientId=cursor-ide&ensure=true&permissionLevel=read_only&advancedSecurity=false&version=0');

  for (let i = 0; i < 35; i++) {
    await vault.fetch('https://vault/audit/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: i % 2 === 0 ? 'claude-desktop' : 'cursor-ide',
        toolName: i % 3 === 0 ? 'get_quotes' : i % 3 === 1 ? 'get_account' : 'prepare_trade',
        requestId: randomUUID(),
        status: i % 7 === 0 ? 'ERROR' : 'SUCCESS',
        parametersSummary: JSON.stringify({ symbol: 'AAPL', count: i }),
        errorCode: i % 7 === 0 ? 'RATE_LIMITED' : null,
        errorMessage: i % 7 === 0 ? 'Upstream request was throttled' : null,
        durationMs: 45 + (i * 3),
        createdAt: now - (i * 3600 * 1000),
      }),
    });
  }

  // Seed a multi-leg proposal
  await vault.fetch('https://vault/trade/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identity: { clientId: 'claude-desktop', advancedSecurity: true, securityPolicyVersion: 1 },
      requestId: randomUUID(),
      input: {
        executionMode: 'IMMEDIATE',
        action: 'PLACE',
        accountHash: 'DEMO_HASH_888',
        orderPayload: {
          orderType: 'LIMIT',
          session: 'NORMAL',
          duration: 'DAY',
          price: '150.25',
          orderStrategyType: 'VERTICAL_CALL',
          orderLegCollection: [
            { instruction: 'BUY_TO_OPEN', quantity: 2, instrument: { symbol: 'AAPL 240920C00150000', assetType: 'OPTION' } },
            { instruction: 'SELL_TO_OPEN', quantity: 2, instrument: { symbol: 'AAPL 240920C00155000', assetType: 'OPTION' } },
          ],
        },
        userInstruction: 'Open AAPL 150/155 bull call spread',
      },
    }),
  });
}

await seedFixtureData();

const servers = [];

const app = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (req.headers.host !== 'localhost:8799') return send(res, 403, 'Local host only');

    if (url.pathname === '/') {
      return send(res, 200, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schwab MCP · PWA &amp; 跨设备 OAuth 本机验收</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; background: #070b12; color: #dfe2ef; padding: 24px; max-width: 680px; margin: auto; line-height: 1.6; }
    h1 { color: #4edea3; font-size: 20px; }
    a { color: #7bd0ff; text-decoration: none; display: inline-block; margin: 4px 0; }
    a:hover { text-decoration: underline; }
    .card { background: #0f131c; border: 1px solid #1e2d42; border-radius: 8px; padding: 16px; margin: 16px 0; }
    .stat { font-mono; font-size: 13px; color: #86948a; }
    .btn { display: inline-block; background: #4edea3; color: #003824; font-weight: 600; padding: 8px 16px; border-radius: 6px; text-decoration: none; margin: 6px 0; }
  </style>
</head>
<body>
  <h1>Schwab MCP · PWA &amp; 跨设备 OAuth 本机隔离验收</h1>
  <p>真实 Worker、Miniflare SQLite、PWA 静态资源、模拟 GitHub、模拟 Web Push 发送捕获。</p>
  
  <div class="card">
    <h3>1. 控制面板与 PWA 体验</h3>
    <p>登录 Owner 账号进入控制面板，测试 PWA 离线、待办核准、Web Push 订阅和设备管理：</p>
    <a class="btn" href="/login">进入 Dashboard 控制面板 (模拟 Owner 登录)</a>
  </div>

  <div class="card">
    <h3>2. 客户端 OAuth 授权流程</h3>
    <p>电脑发起客户端授权：</p>
    <a href="/start?mode=plain">发起普通客户端授权 (Plain Full Access)</a><br>
    <a href="/start?mode=enhanced">发起增强客户端授权 (Enhanced - 需 Passkey)</a>
  </div>

  <div class="card">
    <h3>3. 实时状态与拦截统计</h3>
    <div class="stat">GitHub 授权计数: ${stats.githubAuthorizations}</div>
    <div class="stat">Token 换票计数: ${stats.mockTokenExchanges}</div>
    <div class="stat">拦截标准 Web Push 请求数: ${stats.pushDeliveriesIntercepted}</div>
    <div class="stat">真实 Schwab 写请求数: 0 (严格隔离禁止)</div>
    <br>
    <a href="/__fixture/push-events">查看已拦截的 Web Push 载荷明细 (JSON)</a>
  </div>
</body>
</html>`);
    }

    if (url.pathname === '/login') {
      res.writeHead(302, { Location: '/dashboard' });
      return res.end();
    }

    if (url.pathname === '/__fixture/status') {
      return send(res, 200, JSON.stringify({ stats, pushEvents, results }), 'application/json');
    }

    if (url.pathname === '/__fixture/push-events') {
      return send(res, 200, JSON.stringify(pushEvents, null, 2), 'application/json');
    }
    if (url.pathname === '/__fixture/alarm') {
      const ns = await mf.getDurableObjectNamespace('SCHWAB_VAULT');
      const vault = ns.get(ns.idFromName('owner'));
      await vault.fetch('https://vault/alarm/run', { method: 'POST' });
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    }


    if (url.pathname === '/__fixture/sign') {
      const b = JSON.parse((await body(req)).toString());
      const signed = await key[b.registration ? 'register' : 'authenticate'](b.challenge, { origin, rp: 'localhost' });
      return send(res, 200, JSON.stringify(signed), 'application/json');
    }

    if (url.pathname === '/start') {
      const mode = url.searchParams.get('mode') === 'enhanced' ? 'enhanced' : 'plain';
      const registration = await workerFetch('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ redirect_uris: [callback], client_name: 'Local ' + mode, token_endpoint_auth_method: 'none' }),
      });
      const { client_id: clientId } = await registration.json();
      const verifier = randomUUID() + randomUUID();
      const state = randomUUID();
      flows.set(state, { mode, clientId, verifier });
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: callback,
        scope: 'schwab.read',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      res.writeHead(302, { Location: '/authorize?' + params });
      return res.end();
    }

    // Proxy request to Miniflare Worker
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v && !['content-length', 'transfer-encoding', 'connection'].includes(k)) {
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
    }

    const response = await workerFetch(req.url, {
      method: req.method,
      headers,
      ...(!['GET', 'HEAD'].includes(req.method) ? { body: await body(req) } : {}),
    });

    const out = new Headers(response.headers);
    const cookies = out.getSetCookie();
    out.delete('set-cookie');

    const location = out.get('location');
    if (location?.startsWith('https://github.com/login/oauth/authorize')) {
      out.set('location', location.replace('https://github.com/login/oauth/authorize', github + '/authorize'));
    }

    let text = await response.text();
    if (out.get('Content-Type')?.includes('text/html')) {
      text = text.replaceAll('https://github.com/login/oauth/authorize', github + '/authorize');
      if (url.pathname.startsWith('/security')) {
        text = text.replace('<script id="page-data"', shim + '<script id="page-data"');
      }
    }

    out.delete('content-length');
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    res.writeHead(response.status, Object.fromEntries(out));
    res.end(text);
  } catch (error) {
    console.error({ event: 'pwa_acceptance_failed', errorType: error.name, message: error.message, stack: error.stack });
    send(res, 500, 'Isolated fixture failed; no external traffic allowed: ' + error.message);
  }
});
servers.push(app);

// Mock GitHub server
const provider = createServer((req, res) => {
  const u = new URL(req.url, github);
  if (u.pathname !== '/authorize') return send(res, 404, 'Mock route only');
  stats.githubAuthorizations++;
  const target = new URL(u.searchParams.get('redirect_uri'));
  if (target.origin !== origin) return send(res, 403, 'Invalid mock redirect');
  target.searchParams.set('state', u.searchParams.get('state'));
  target.searchParams.set('code', 'mock-code');
  res.writeHead(302, { Location: target.href });
  res.end();
});
servers.push(provider);

// Mock Client server
const client = createServer(async (req, res) => {
  const u = new URL(req.url, callback);
  if (u.pathname === '/complete') {
    return send(res, 200, `<!doctype html>
<html><body style="font-family:sans-serif;background:#070b12;color:#dfe2ef;padding:24px;">
<h1>本机模拟客户端授权完成</h1>
<pre style="background:#0f131c;padding:16px;border-radius:8px;">${JSON.stringify(results.at(-1), null, 2)}</pre>
<a href="${origin}/dashboard" style="color:#7bd0ff;">进入 Dashboard</a>
</body></html>`);
  }
  const flow = flows.get(u.searchParams.get('state'));
  if (!flow || !u.searchParams.get('code')) return send(res, 400, 'Invalid test callback');
  flows.delete(u.searchParams.get('state'));

  const token = await workerFetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: flow.clientId,
      redirect_uri: callback,
      code: u.searchParams.get('code'),
      code_verifier: flow.verifier,
    }).toString(),
  });
  const tokens = await token.json();

  const tools = await workerFetch('/mcp', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tokens.access_token,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const list = await tools.text();

  results.push({
    mode: flow.mode,
    tokenExchange: token.status,
    mcpStatus: tools.status,
    prepareTrade: list.includes('"name":"prepare_trade"'),
    confirmTrade: list.includes('"name":"confirm_trade"'),
    realSchwabRequests: 0,
  });

  res.writeHead(302, { Location: '/complete' });
  res.end();
});
servers.push(client);

for (const [i, s] of servers.entries()) {
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(8799 + i, '127.0.0.1', resolve);
  });
}

console.log('Isolated PWA acceptance server ready at: ' + origin);

async function stop() {
  await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
  await mf.dispose();
}

process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
