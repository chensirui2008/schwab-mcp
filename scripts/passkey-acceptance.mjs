// Local UI/device acceptance only. No Worker bindings, OAuth, Schwab credentials or outbound requests.
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { TextEncoder } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL, URL } from 'node:url';
import { build } from 'esbuild';
import { generateRegistrationOptions, generateAuthenticationOptions, verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';

export async function startAcceptance(port = 8791, publicOrigin) {
  const origin = publicOrigin || `http://localhost:${port}`;
  const parsedOrigin = new URL(origin);
  if (publicOrigin && (parsedOrigin.protocol !== 'https:' || !parsedOrigin.hostname.endsWith('.trycloudflare.com') || parsedOrigin.origin !== publicOrigin)) {
    throw new Error('Mobile acceptance requires an exact HTTPS trycloudflare.com origin');
  }
  const rpID = parsedOrigin.hostname;
  const bundle = await build({ entryPoints: ['src/security-ui.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  const { renderSecurityPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const csrf = randomUUID();
  const expiresAt = Date.now() + 15 * 60_000;
  let credential;
  let credentialName;
  let proposal;
  let submissions = 0;
  const challenges = new Map();
  const preview = Object.freeze({ accountHash: 'TEST_ONLY_NOT_A_SCHWAB_ACCOUNT', action: 'PLACE', executionMode: 'IMMEDIATE', orderPayload: { orderType: 'LIMIT', session: 'NORMAL', duration: 'DAY', price: '1.00', orderStrategyType: 'SINGLE', orderLegCollection: [{ instruction: 'BUY', quantity: 1, instrument: { symbol: 'TEST_ONLY', assetType: 'EQUITY' } }] } });
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'" });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (![parsedOrigin.host, `localhost:${port}`].includes(req.headers.host)) return send(403, { error: { message: 'Invalid acceptance host' } });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/status') return send(200, { environment: 'LOCAL_UI_FIXTURE', credentialRegistered: !!credential, proposal, simulatedSubmissions: submissions, realSchwabRequests: 0 });
      if (req.method === 'GET' && ['/', '/security', '/approve', '/unsupported'].includes(url.pathname)) {
        if (Date.now() >= expiresAt) throw new Error('本机验收会话已过期，请重启脚本。');
        if (url.pathname === '/approve' && !credential) { res.writeHead(302, { Location: '/security' }); return res.end(); }
        if (url.pathname === '/approve' && (!proposal || url.searchParams.get('new') === '1')) {
          proposal = { proposalId: randomUUID(), status: 'PENDING', preview, intentDigest: createHash('sha256').update(JSON.stringify(preview)).digest('hex'), expiresAt: new Date(Date.now() + 300_000).toISOString(), outcome: null };
        }
        let page = String(await renderSecurityPage({ csrf, credentialVersion: 1, expiresAt, recovery: false }, credential ? [{ id: credential.id, name: credentialName }] : [], url.pathname === '/approve' ? proposal : undefined));
        page = page.replace('<main>', '<main><p><strong>仅本机模拟验收：不会连接 Schwab，批准只增加模拟计数。</strong></p><p><a href="/security">1. 注册</a> · <a href="/approve?new=1">2. 新模拟订单</a> · <a href="/unsupported">3. 不支持提示</a> · <a href="/status">验收状态</a></p>');
        if (url.pathname === '/unsupported') page = page.replace('<script id="page-data"', '<script>Object.defineProperty(window,"PublicKeyCredential",{value:undefined});</script><script id="page-data"');
        page = page.replace('</body>', '<p id="acceptance-metrics"></p><script>function metrics(){document.querySelector("#acceptance-metrics").textContent="验收视口："+innerWidth+"；内容宽："+document.documentElement.scrollWidth;}addEventListener("resize",metrics);metrics();</script></body>');
        return send(200, page, 'text/html; charset=utf-8');
      }
      if (req.method !== 'POST' || !['/security/api/options', '/security/api/verify'].includes(url.pathname)) return send(404, { error: { message: 'Fixture route unavailable' } });
      if (req.headers.origin !== origin || req.headers['x-csrf-token'] !== csrf || Date.now() >= expiresAt) throw new Error('Invalid origin, CSRF or session');
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 65536) throw new Error('Request too large'); }
      const body = JSON.parse(raw);
      if (url.pathname.endsWith('/options')) {
        const registration = body.operation === 'register' && !credential;
        if (!registration && !(body.operation === 'approve' && credential && proposal?.status === 'PENDING' && body.proposalId === proposal.proposalId && Date.parse(proposal.expiresAt) > Date.now())) throw new Error('Fixture supports first registration and pending approval only');
        const options = registration
          ? await generateRegistrationOptions({ rpName: 'Schwab MCP LOCAL TEST', rpID, userName: 'local-acceptance', userID: new TextEncoder().encode('local-acceptance'), supportedAlgorithmIDs: [-7, -257], attestationType: 'none', authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' } })
          : await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [{ id: credential.id }] });
        const challengeId = randomUUID();
        challenges.set(challengeId, { challenge: options.challenge, registration, name: body.name, proposalId: proposal?.proposalId, expires: Math.min(Date.now() + 120_000, expiresAt, registration ? Infinity : Date.parse(proposal.expiresAt)) });
        return send(200, { options, registration, challengeId });
      }
      const c = challenges.get(body.challengeId);
      challenges.delete(body.challengeId);
      if (!c || c.expires <= Date.now()) throw new Error('Challenge expired or consumed');
      if (c.registration) {
        if (credential) throw new Error('Already registered');
        const result = await verifyRegistrationResponse({ response: body.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
        if (!result.verified || !result.registrationInfo) throw new Error('Registration failed');
        credential = result.registrationInfo.credential;
        credentialName = c.name || '本机验收 Passkey';
        return send(200, { registered: true });
      }
      const result = await verifyAuthenticationResponse({ response: body.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: rpID, credential, requireUserVerification: true });
      if (!result.verified || proposal?.proposalId !== c.proposalId || proposal.status !== 'PENDING' || Date.parse(proposal.expiresAt) <= Date.now()) throw new Error('Approval failed or already consumed');
      credential.counter = result.authenticationInfo.newCounter;
      proposal.status = 'EXECUTED';
      proposal.outcome = { simulated: true, simulatedSubmissions: ++submissions, realSchwabRequests: 0 };
      return send(200, { status: proposal.status, result: proposal.outcome });
    } catch (error) { send(403, { error: { message: error.message } }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startAcceptance(8791, process.env.PASSKEY_ACCEPTANCE_ORIGIN);
  console.log(`模拟 Passkey 验收：${process.env.PASSKEY_ACCEPTANCE_ORIGIN || 'http://localhost:8791'}/security （15 分钟；Ctrl+C 停止；不连接 Schwab）`);
}
