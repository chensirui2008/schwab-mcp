// Isolated real-Worker OAuth acceptance. All GitHub traffic is mocked; Schwab is unreachable.
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL, URLSearchParams } from 'node:url';
import console from 'node:console';

const { Response, Headers } = globalThis;
const origin = 'http://localhost:8796';
const github = 'http://127.0.0.1:8797';
const callback = 'http://localhost:8798/callback';
const baseline = process.env.OAUTH_ACCEPTANCE_BASELINE === '1';
const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['cloudflare:*', 'node:*'], plugins: baseline ? [{ name: 'baseline-only', setup(b) { b.onLoad({ filter: /src\/auth\.ts$/ }, async args => ({ loader: 'ts', contents: (await readFile(args.path, 'utf8')).replace('return c.html(renderGitHubContinuePage(githubAuthorizationUrl(c.env, payload.origin, githubState)));', 'return c.redirect(githubAuthorizationUrl(c.env, payload.origin, githubState));') })); } }] : [] });
const keyBundle = await build({ entryPoints: ['test/webauthn-fixture.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { authenticator } = await import('data:text/javascript;base64,' + Buffer.from(keyBundle.outputFiles[0].text).toString('base64'));
const key = await authenticator();
const flows = new Map();
const results = [];
const stats = { githubAuthorizations: 0, mockTokenExchanges: 0, mockProfileReads: 0, blockedUpstreamRequests: 0, realSchwabRequests: 0 };
const mf = new Miniflare({
  modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
  kvNamespaces: ['OAUTH_KV'], durableObjects: { SCHWAB_VAULT: { className: 'SchwabVault', useSQLite: true } },
  bindings: { GITHUB_CLIENT_ID: 'mock-client', GITHUB_CLIENT_SECRET: 'mock-secret', ALLOWED_GITHUB_USER_ID: '123456', SCHWAB_CLIENT_ID: 'mock-schwab', SCHWAB_CLIENT_SECRET: 'mock-secret', SCHWAB_REDIRECT_URI: origin + '/auth/schwab/callback', MARKET_DATA_BASE_URL: 'https://blocked.invalid/market', TRADER_BASE_URL: 'https://blocked.invalid/trader', ENABLE_TRADING: 'false', APP_VERSION: 'local-oauth-acceptance' },
  outboundService: async request => {
    const u = new URL(request.url);
    if (u.origin === 'https://github.com' && u.pathname === '/login/oauth/access_token' && request.method === 'POST') { stats.mockTokenExchanges++; return Response.json({ access_token: 'mock-github-token' }); }
    if (u.origin === 'https://api.github.com' && u.pathname === '/user' && request.method === 'GET') { stats.mockProfileReads++; return Response.json({ id: 123456, login: 'mock-owner', name: null }); }
    stats.blockedUpstreamRequests++;
    return new Response('External network disabled in acceptance', { status: 502 });
  },
});
const shim = `<script>
const decode=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
async function testCredential(registration, {publicKey}) {
 const challenge=btoa(String.fromCharCode(...new Uint8Array(publicKey.challenge))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 const r=await fetch('/__fixture/sign',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({registration,challenge})});const c=await r.json();
 const response=Object.fromEntries(Object.entries(c.response).filter(([k])=>k!=='transports').map(([k,v])=>[k,decode(v).buffer]));
 response.getTransports=()=>c.response.transports||[];
 return {id:c.id,rawId:decode(c.rawId).buffer,type:c.type,response,getClientExtensionResults:()=>({})};
}
Object.defineProperty(navigator.credentials,'create',{value:o=>testCredential(true,o)});
Object.defineProperty(navigator.credentials,'get',{value:o=>testCredential(false,o)});
</script>`;
async function body(req) { const chunks=[]; let size=0; for await (const c of req) { size+=c.length; if(size>65536) throw Error('Fixture request too large'); chunks.push(c); } return Buffer.concat(chunks); }
function send(res, status, text, type='text/html; charset=utf-8') { res.writeHead(status, { 'Content-Type':type, 'Cache-Control':'no-store' }); res.end(text); }
async function workerFetch(path, options={}) { return mf.dispatchFetch(origin+path, { ...options, redirect: 'manual' }); }
const servers=[];
const app = createServer(async (req,res) => {
  try {
    const url=new URL(req.url,origin);
    if(req.headers.host!=='localhost:8796')return send(res,403,'Local host only');
    if(url.pathname==='/')return send(res,200,'<h1>仅本机 OAuth 模拟验收</h1><p>真实 Worker、独立 KV/SQLite DO；模拟 GitHub、软件 Passkey；生产交易关闭。</p><a href="/start?mode=plain">普通完整访问</a><br><a href="/start?mode=enhanced">增强完整访问</a>');
    if(url.pathname==='/__fixture/status')return send(res,200,JSON.stringify({baseline,stats,results}), 'application/json');
    if(url.pathname==='/__fixture/sign') { const b=JSON.parse((await body(req)).toString()); return send(res,200,JSON.stringify(await key[b.registration?'register':'authenticate'](b.challenge,{origin,rp:'localhost'})),'application/json'); }
    if(url.pathname==='/start') {
      const mode=url.searchParams.get('mode')==='enhanced'?'enhanced':'plain';
      const registration=await workerFetch('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({redirect_uris:[callback],client_name:'Local '+mode,token_endpoint_auth_method:'none'})});
      const {client_id:clientId}=await registration.json();
      const verifier=randomUUID()+randomUUID(), state=randomUUID(); flows.set(state,{mode,clientId,verifier});
      const params=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callback,scope:'schwab.read',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
      res.writeHead(302,{Location:'/authorize?'+params});return res.end();
    }
    const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(v && !['content-length','transfer-encoding','connection'].includes(k))headers.set(k,Array.isArray(v)?v.join(', '):v);
    const response=await workerFetch(req.url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method)?{body:await body(req)}:{})});
    const out=new Headers(response.headers);
    const cookies=out.getSetCookie();out.delete('set-cookie');
    const location=out.get('location');if(location?.startsWith('https://github.com/login/oauth/authorize'))out.set('location',location.replace('https://github.com/login/oauth/authorize',github+'/authorize'));
    let text=await response.text();
    if(out.get('Content-Type')?.includes('text/html')) {
      text=text.replaceAll('https://github.com/login/oauth/authorize',github+'/authorize');
      if(url.pathname==='/security')text=text.replace('<script id="page-data"',shim+'<script id="page-data"');
    }
    out.delete('content-length');
    if(cookies.length)res.setHeader('Set-Cookie',cookies);
    res.writeHead(response.status,Object.fromEntries(out));res.end(text);
  }catch(error){console.error({event:'oauth_acceptance_failed',errorType:error.name});send(res,500,'Isolated fixture failed; no external traffic allowed');}
});servers.push(app);
const provider = createServer((req,res) => {
 const u=new URL(req.url,github);if(u.pathname!=='/authorize')return send(res,404,'Mock route only');
 stats.githubAuthorizations++;const target=new URL(u.searchParams.get('redirect_uri'));if(target.origin!==origin)return send(res,403,'Invalid mock redirect');
 target.searchParams.set('state',u.searchParams.get('state'));target.searchParams.set('code','mock-code');res.writeHead(302,{Location:target.href});res.end();
});servers.push(provider);
const client = createServer(async(req,res)=>{
 const u=new URL(req.url,callback);
 if(u.pathname==='/complete')return send(res,200,'<h1>本机模拟授权完成</h1><pre>'+JSON.stringify(results.at(-1),null,2)+'</pre>');
 const flow=flows.get(u.searchParams.get('state'));if(!flow||!u.searchParams.get('code'))return send(res,400,'Invalid test callback');flows.delete(u.searchParams.get('state'));
 const token=await workerFetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:flow.clientId,redirect_uri:callback,code:u.searchParams.get('code'),code_verifier:flow.verifier}).toString()});
 const tokens=await token.json();
 const tools=await workerFetch('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 const list=await tools.text();
 results.push({mode:flow.mode,tokenExchange:token.status,mcpStatus:tools.status,prepareTrade:list.includes('"name":"prepare_trade"'),confirmTrade:list.includes('"name":"confirm_trade"'),realSchwabRequests:0});
 res.writeHead(302,{Location:'/complete'});res.end();
});servers.push(client);
for(const [i,s]of servers.entries())await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(8796+i,'127.0.0.1',resolve);});
console.log('Isolated OAuth acceptance: '+origin+' (baseline='+baseline+')');
async function stop(){await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));await mf.dispose();}
process.on('SIGTERM',()=>{void stop();});process.on('SIGINT',()=>{void stop();});
