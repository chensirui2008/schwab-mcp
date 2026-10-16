// Cross-origin browser provider only. OAuth/token/PKCE/MCP verification stays in the cloud Worker.
import { createServer } from 'node:http';
import { URL } from 'node:url';
import console from 'node:console';
const origin = 'https://schwab-mcp.siruichen461.workers.dev';
createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8797');
  if (url.pathname !== '/authorize' || url.searchParams.get('redirect_uri') !== origin + '/auth/github/callback' || !/^[a-f0-9]{64}$/.test(url.searchParams.get('state') ?? '')) {
    res.writeHead(400); res.end('Mock GitHub only'); return;
  }
  const callback = new URL('/__test/auth/github/callback', origin);
  callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('code', 'mock-code');
  res.writeHead(302, { Location: callback.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
  console.log('Mock GitHub redirected to cloud test callback; no real GitHub or Schwab requests.');
}).listen(8797, '127.0.0.1', () => console.log('Mock GitHub: http://127.0.0.1:8797'));
