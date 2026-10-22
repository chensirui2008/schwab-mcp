# OAuth consent navigation regression validation

## Account selection Origin regression (2026-10-22)

The account selection document is rendered at `/auth/github/callback` with the shared `Referrer-Policy: no-referrer` response header. Native form POST navigation under that policy sends `Origin: null`, so the strict `/authorize/accounts` origin check rejects a legitimate selection with `Invalid origin`. Worker tests had supplied the expected Origin manually and did not model browser header generation.

The account selection page now includes `<meta name="referrer" content="same-origin">`. This document policy preserves the Origin on its same-origin form submission and suppresses cross-origin referrers. The shared response header, server origin checks, browser-bound one-time state, owner session and account allowlist validation remain unchanged.

Local @Browser validation used the actual `renderAccountSelectionPage` HTML, fake state/account data, and an HTTP loopback receiver with the production `no-referrer` response header. Submitting the baseline document produced `Origin: null` and failed the receiver's exact-origin check; submitting the fixed document produced the loopback origin and passed. This demonstrates browser-generated headers; it does not represent a production OAuth login, token exchange or device Passkey acceptance. Real Schwab requests: **0**.

The account consent regression test checks the document policy and rejects foreign, empty and literal `null` origins before a valid submission. To smoke-test after an approved release, restart MCP authorization, complete owner login, select accounts, and confirm that the POST to `/authorize/accounts` sends the configured origin and advances to client continuation or Passkey approval.

## Historical navigation validation

Validated locally on 2026-10-16. No production deployment or real Schwab request was performed.

## Failure and fix

The consent page enforces `Content-Security-Policy: form-action 'self'`. Chromium applies that restriction to a form's redirect chain. Returning a 302 directly from `POST /authorize/approve` to GitHub therefore blocked navigation after the server had already consumed the consent state and rotated its browser cookie. Clicking the unchanged form again then returned `Invalid consent state`.

Production logs confirmed the sequence at 15:12:51 / 15:12:58 / 15:13:05 Asia/Shanghai: consent GET 200, first consent POST 302, repeated POST 400. The affected version was `f87acb60-5dd8-4f23-82a7-52e66428d39a`. Both security selections use that same path.

The POST now completes with a no-store, same-origin 200 document. That document starts a new top-level navigation to the server-generated GitHub URL with `location.replace()`. An escaped anchor provides a fallback if scripting is unavailable. The existing `form-action 'self'`, state/cookie binding, one-time consumption, owner verification, PKCE, grant revocation and per-client policy checks remain in force. No OAuth version bump is needed.

## Isolated browser environment (Historical 2026-10-16 validation)

The regression was originally reproduced and validated using a local Miniflare fixture on `http://localhost:8796`. The fixture bundled the real Worker with non-persistent OAuth KV and SQLite Durable Objects, restricting outbound requests to mock GitHub responses.

This temporary local fixture was retired after the same-Worker isolated acceptance routes (`/__test/*`) and automated Vitest test suite (`test/cloud-acceptance.test.ts`, `test/auth.test.ts`) were merged into the repository.

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

## Same-Worker cloud acceptance (2026-10-16)

The owner explicitly requested test routes inside the existing `schwab-mcp` Worker and authorized deploying them. No separate Worker was created. `/__test/*` uses an optional `ACCEPTANCE_KEY` Worker Secret, separate HttpOnly cookies, a dedicated `ACCEPTANCE_KV` namespace and SQLite `AcceptanceVault`. Every run gets a new Durable Object identity. Missing key/bindings disable the routes with 404. Production routes continue to use the real GitHub provider, original KV/DO, and existing secrets.

The acceptance vault replaces all brokerage configuration with dummy values, forces trading off, and rejects credential storage, accounts and trading paths before calling the production vault implementation. Browser routes cannot directly proxy MCP, token, or Schwab endpoints. OAuth tokens are used server-side for verification and never returned in HTML or stored in reports. Reports expire after one hour. The software authenticator creates an in-memory test key and uses the actual server WebAuthn verifier; it does not create a device Passkey.

### Reproduce

1. Set the optional `ACCEPTANCE_KEY` through Worker Secrets; never put it in configuration, a URL, or a committed file. Keep the existing three required secret names unchanged.
2. Open `https://schwab-mcp.siruichen461.workers.dev/__test/` and unlock using that key. Choose a fresh ordinary or enhanced flow. Select Full access; select Advanced Security for the enhanced flow. Click the normal consent button, then the software registration button when prompted.
3. Expect `tokenExchange: 200`, `mcpStatus: 200`, `prepareTrade: true`, `tradingEnabled: false`, and `realSchwabRequests: 0`. Ordinary mode exposes `confirmTrade`; enhanced mode hides it.
4. Cloud acceptance test flows use the built-in mock route in the same Worker (`/__test/mock/github`). PKCE, OAuth persistence, Passkey verification, token exchange and authenticated MCP all run in the deployed Cloudflare Worker without external dependencies.
5. Delete the optional Worker Secret when testing is no longer needed; routes then return 404. This is a deployment operation and does not clear production grants or credentials.

### Observed cloud results

Chrome completed both cross-origin flows on the existing Worker, deployed version `e70a255f-4fb4-4f6f-97d3-38ead125b20e`. Both returned token exchange 200 and MCP 200, with `prepareTrade: true`. Ordinary `confirmTrade: true`; enhanced `confirmTrade: false`. Both reported trading disabled and zero real Schwab requests. The loopback provider observed both callbacks. The consent CSP remained `form-action 'self'`; production configuration and secret values were preserved. The live production trading flag was already `false` when preparing this deployment and remained `false`.

`npm run validate` passed: 127 Worker tests, 2 deployment configuration tests, 25 tool introspection checks, and 4 browser fixture tests. Five added Worker tests cover the optional gate, foreign-origin unlock rejection, blocked brokerage/token/MCP routes, production/test storage and cookie isolation, mock callback restrictions, and DO-level brokerage denial.

These results validate deployed application behavior with simulated GitHub and a software authenticator. They do not claim a real GitHub login or a new Safari/iPhone hardware Passkey run against production. Earlier device acceptance is documented separately.
