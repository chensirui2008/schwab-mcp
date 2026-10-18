import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const { Response } = globalThis;

const bundle = await build({
  stdin: {
    contents: `
      import { SchwabVault } from './src/vault';
      export class PushAcceptanceVault extends SchwabVault {
        override async fetch(request: Request): Promise<Response> {
          if (new URL(request.url).pathname === '/test/deliveries') {
            return Response.json(this.ctx.storage.sql.exec(
              'SELECT status, last_status_code FROM notification_delivery ORDER BY rowid'
            ).toArray());
          }
          return super.fetch(request);
        }
      }
      export default {
        fetch(request, env) {
          return env.STORE.get(env.STORE.idFromName('isolated-push')).fetch(request);
        }
      };
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  external: ['cloudflare:*', 'node:*'],
});

test('native Worker fetch dispatches encrypted push and does not follow push-service redirects', async () => {
  const requests = [];
  let serviceStatus = 201;
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-08-06',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { STORE: { className: 'PushAcceptanceVault', useSQLite: true } },
    bindings: {
      SCHWAB_REDIRECT_URI: 'https://example.com/auth/schwab/callback',
      ALLOWED_GITHUB_USER_ID: '123456',
      ENABLE_TRADING: 'false',
    },
    outboundService: async request => {
      requests.push({
        url: request.url,
        encoding: request.headers.get('content-encoding'),
        vapid: request.headers.has('authorization'),
        encryptedBytes: (await request.arrayBuffer()).byteLength,
      });
      return new Response(null, {
        status: serviceStatus,
        ...(serviceStatus === 302 ? { headers: { Location: 'https://untrusted.invalid/push' } } : {}),
      });
    },
  });
  async function post(path, input) {
    const response = await mf.dispatchFetch('https://example.com' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  try {
    const created = await post('/security/session/create', {});
    const browser = { sessionId: created.sessionId, csrf: created.session.csrf };
    const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const keys = {
      p256dh: Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url'),
      auth: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'),
    };
    for (const [label, status] of [['accepted', 201], ['redirected', 302]]) {
      serviceStatus = status;
      const endpoint = 'https://fcm.googleapis.com/fcm/send/' + label;
      const subscription = await post('/notifications/subscribe', {
        ...browser, input: { subscription: { endpoint, keys }, label },
      });
      await post('/notifications/test', { ...browser, input: { id: subscription.id } });
      await post('/alarm/run', {});
    }
    assert.deepEqual(requests.map(request => request.url), [
      'https://fcm.googleapis.com/fcm/send/accepted',
      'https://fcm.googleapis.com/fcm/send/redirected',
    ]);
    for (const request of requests) {
      assert.equal(request.encoding, 'aes128gcm');
      assert.equal(request.vapid, true);
      assert.ok(request.encryptedBytes > 86);
    }
    const states = await (await mf.dispatchFetch('https://example.com/test/deliveries')).json();
    assert.deepEqual(states, [
      { status: 'SENT', last_status_code: 201 },
      { status: 'FAILED', last_status_code: 302 },
    ]);
  } finally {
    await mf.dispose();
  }
});
