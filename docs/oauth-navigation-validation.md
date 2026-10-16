# OAuth consent navigation regression validation

Validated locally on 2026-10-16. No production deployment or real Schwab request was performed.

## Failure and fix

The consent page enforces `Content-Security-Policy: form-action 'self'`. Chromium applies that restriction to a form's redirect chain. Returning a 302 directly from `POST /authorize/approve` to GitHub therefore blocked navigation after the server had already consumed the consent state and rotated its browser cookie. Clicking the unchanged form again then returned `Invalid consent state`.

Production logs confirmed the sequence at 15:12:51 / 15:12:58 / 15:13:05 Asia/Shanghai: consent GET 200, first consent POST 302, repeated POST 400. The affected version was `f87acb60-5dd8-4f23-82a7-52e66428d39a`. Both security selections use that same path.

The POST now completes with a no-store, same-origin 200 document. That document starts a new top-level navigation to the server-generated GitHub URL with `location.replace()`. An escaped anchor provides a fallback if scripting is unavailable. The existing `form-action 'self'`, state/cookie binding, one-time consumption, owner verification, PKCE, grant revocation and per-client policy checks remain in force. No OAuth version bump is needed.

## Isolated browser environment

Run from the repository root:

```sh
node scripts/oauth-browser-acceptance.mjs
```

Open `http://localhost:8796` in Chrome. The fixture bundles the real Worker and uses Miniflare with fresh, non-persistent OAuth KV and SQLite Durable Objects. It does not load `.dev.vars` or production bindings. `ENABLE_TRADING=false`, all credentials and the owner identity are test values, and Worker outbound requests are restricted to mock GitHub responses. Unknown outbound requests return 502. All servers bind to loopback.

The browser's GitHub destination is rewritten only in this fixture to the separate origin `http://127.0.0.1:8797`. It redirects back to the real Worker callback. A separate mock client on `http://localhost:8798` exchanges the authorization code using S256 PKCE and calls the real MCP `tools/list` endpoint. Codes and tokens stay in process memory and are not printed. Miniflare dispatch uses manual redirects, so the fixture rewrites navigation destinations before the browser follows them.

For enhanced mode, the fixture injects a software authenticator into the security page. It creates real WebAuthn signatures using the existing test helper; the production SimpleWebAuthn verification remains active. This is an OAuth/browser integration test, not an additional native-device Passkey acceptance claim. Native-device results are recorded separately in [passkey-validation.md](passkey-validation.md).

To reproduce the old behavior without changing tracked production code, stop the fixture and restart it with:

```sh
OAUTH_ACCEPTANCE_BASELINE=1 node scripts/oauth-browser-acceptance.mjs
```

That option changes only the in-memory test bundle back to the previous consent POST redirect. Stop with Ctrl+C after each run; restarting clears fixture state.

## Observed results

| Build | Mode | Browser result | Code exchange | MCP tools/list |
| --- | --- | --- | --- | --- |
| Baseline | Ordinary full access | Remains on consent page after submit; second submit returns `Invalid consent state` | Not reached | Not reached |
| Baseline | Advanced Security | Remains on consent page after submit | Not reached | Not reached |
| Fixed | Ordinary full access | Reaches mock client completion page | 200 | 200; `confirm_trade` present |
| Fixed | Advanced Security | Reaches Passkey page, verifies real software-authenticator signature, then completes | 200 | 200; `confirm_trade` absent |

Baseline fixture counters: 0 GitHub authorizations, 0 mock token exchanges, 0 real Schwab requests. Fixed counters: 2 GitHub authorizations, 2 mock token exchanges, 2 mock owner lookups, 0 blocked outbound requests, 0 real Schwab requests. The same restrictive CSP was active in both builds.

`npm run validate` passed: generated types, typecheck, lint, 122 Worker tests, 2 deployment configuration tests, 25-tool introspection, and 4 Passkey fixture tests. New protocol regressions assert a 200 continuation document, the unchanged CSP, correctly bound rotated state/cookie, and rejection of replay for both Advanced Security selections. Existing tests continue through code exchange, refresh and client permission checks.

## Release boundary

The local browsers demonstrated that this regression is fixed without weakening CSP. Production GitHub owner login and real-client callback still need a smoke test after an explicitly approved production release. This test does not authorize production deployment, Schwab connection changes or trading. The fixture processes were stopped after validation.
