# Agent Setup & Deployment Guide for schwab-mcp

> **Notice to AI Agents**: This document is an executable, step-by-step Standard Operating Procedure (SOP) designed for AI coding assistants (Claude Code, Cursor, Windsurf, Codex, etc.) to set up, configure, and deploy `schwab-mcp` to the user's personal Cloudflare account.
>
> **Execution Invariants**:
> 1. **Idempotence**: Check if a resource/config already exists before creating or overwriting.
> 2. **Zero Secret Leaks**: Never print raw secrets, keys, or tokens in logs or conversation. Prompt the user safely or use interactive CLI commands (`wrangler secret put`).
> 3. **Human-in-the-Loop Boundaries**: External portal actions (GitHub OAuth App registration, Schwab Developer Portal approval, browser authorization) require human interaction. Pause, give clear instructions with links, and wait for the user to provide the resulting IDs/keys.

---

## Architecture Context

```
Client (Cursor / Claude Desktop)
       │ (Streamable HTTP /mcp)
       ▼
Cloudflare Workers Edge Router
  ├── OAUTH_KV (Client & Grant persistence)
  └── SchwabVault Durable Object (SQLite: Schwab Tokens, Proposals, DO Alarms)
```

---

## Phase 0: Prerequisites & Environment Check

### Step 0.1: Check Node.js and npm
Run:
```bash
node -v && npm -v
```
- **Expectation**: Node.js `>= 20.0.0` (v20 or v22 recommended).
- **If missing/outdated**: Instruct the user to install or upgrade Node.js (via `nvm`, `brew`, or official installer).

### Step 0.2: Install Dependencies
Run:
```bash
npm install
```
Ensure all dependencies install cleanly.

### Step 0.3: Verify Cloudflare Authentication
Run:
```bash
npx wrangler whoami
```
- **If authenticated**: Note the account name and ID.
- **If unauthenticated**: Instruct the user:
  > *"Please run `npx wrangler login` in your terminal to authenticate with your Cloudflare account. Let me know when you have completed the login in your browser."*
  Wait for the user's confirmation, then re-check with `npx wrangler whoami`.

---

## Phase 1: External Application Registration (Interactive Human Tasks)

The agent should guide the user through setting up two external developer applications.

### Step 1.1: GitHub OAuth App (Owner Authentication)
Guide the user to register an OAuth application on GitHub to secure access:
1. Go to: **https://github.com/settings/developers** -> **OAuth Apps** -> **New OAuth App**.
2. Fill in:
   - **Application name**: `Schwab MCP Server`
   - **Homepage URL**: `https://schwab-mcp.<your-cloudflare-subdomain>.workers.dev` (or placeholder `http://localhost`)
   - **Authorization callback URL**: `https://schwab-mcp.<your-cloudflare-subdomain>.workers.dev/authorize/callback`
3. Click **Register application**.
4. Generate a new Client Secret.
5. Retrieve numeric GitHub User ID by running:
   ```bash
   curl -s https://api.github.com/users/<GITHUB_USERNAME> | grep '"id":'
   ```
   *(Agent should replace `<GITHUB_USERNAME>` with the user's GitHub username).*

**Values collected from user:**
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `ALLOWED_GITHUB_USER_ID` (integer number)

### Step 1.2: Charles Schwab Developer Portal (API Access)
Guide the user to prepare their Charles Schwab Developer App:
1. Log in to **https://developer.schwab.com/**.
2. Go to **Dashboard** -> **Apps** -> Create or select an App.
3. Ensure the app has the **Trader API** and **Market Data API** products enabled and status is **Ready for Use** / **Approved**.
4. Set Callback URL in Schwab Developer Portal:
   - `https://schwab-mcp.<your-cloudflare-subdomain>.workers.dev/auth/schwab/callback`
5. Note the credentials:
   - **App Key** (`SCHWAB_CLIENT_ID`)
   - **Secret** (`SCHWAB_CLIENT_SECRET`)

---

## Phase 2: Cloudflare Resource Provisioning & Configuration

### Step 2.1: Provision KV Namespace
Check if `OAUTH_KV` already exists or create a new one:
```bash
npx wrangler kv namespace create OAUTH_KV
```
Capture the returned namespace ID (a 32-character hex string).

### Step 2.2: Configure `wrangler.jsonc`
Edit `wrangler.jsonc`:
1. In `kv_namespaces`, replace `"id": "replace-with-your-kv-namespace-id"` with the ID from Step 2.1.
2. In `vars`:
   - Set `"GITHUB_CLIENT_ID"` to the user's GitHub Client ID.
   - Set `"ALLOWED_GITHUB_USER_ID"` to the user's numeric GitHub ID (quoted string).
   - Set `"SCHWAB_REDIRECT_URI"` to:
     `https://<your-worker-name>.<your-cloudflare-subdomain>.workers.dev/auth/schwab/callback`
   - Ensure `"ENABLE_TRADING"` remains `"false"` initially for safe read-only deployment.

### Step 2.3: Upload Encrypted Secrets to Cloudflare
Execute the following commands to upload secrets to Cloudflare Workers (interactive or via standard input):
```bash
echo "<GITHUB_CLIENT_SECRET>" | npx wrangler secret put GITHUB_CLIENT_SECRET
echo "<SCHWAB_CLIENT_ID>" | npx wrangler secret put SCHWAB_CLIENT_ID
echo "<SCHWAB_CLIENT_SECRET>" | npx wrangler secret put SCHWAB_CLIENT_SECRET
```
*Never print these values to chat or write them into git-tracked files.*

---

## Phase 3: Pre-Flight Verification & Deployment

### Step 3.1: Automated Code & Type Check
Run the comprehensive test and validation suite:
```bash
npm run validate
```
This runs:
- `wrangler types` (verifies bindings)
- `npm run typecheck` (strict TypeScript validation)
- `npm run lint` (ESLint checks)
- `npm test` (Vitest suites for tools, OAuth permissions, and auth flow)

All checks **MUST pass** before deploying.

### Step 3.2: Deploy Worker
Run:
```bash
npm run deploy
```
- Capture the public deployment URL (e.g., `https://schwab-mcp.<subdomain>.workers.dev`).
- **Callback Verification**: Ensure the domain matches the callback URLs configured in Step 1.1 and Step 1.2:
  - GitHub Callback: `https://<deployed-domain>/authorize/callback`
  - Schwab Callback: `https://<deployed-domain>/auth/schwab/callback`

---

## Phase 4: Account Linking (Schwab OAuth Connection)

Instruct the user to link their Charles Schwab account:
1. Open in browser:
   ```text
   https://<deployed-domain>/auth/schwab/connect
   ```
2. The user will be redirected to GitHub to authenticate. The server verifies their numeric GitHub ID against `ALLOWED_GITHUB_USER_ID`.
3. If verified, the user is redirected to Schwab's login portal.
4. Log in and approve account access.
5. The Schwab OAuth token will be exchanged and encrypted into the `SchwabVault` SQLite Durable Object.
6. A success message `Schwab account successfully connected!` will be displayed.

---

## Phase 5: Client Connection & Smoke Testing

### Step 5.1: Configure MCP Client
Use a client with [RFC 7636 S256 PKCE](https://www.rfc-editor.org/rfc/rfc7636) support; upgrade clients that lack it. Server metadata advertises only `S256`. Every new authorization request must include exactly one `code_challenge` (43 unpadded base64url characters) and one `code_challenge_method=S256`. The client generates and retains a random verifier, sends its SHA-256 base64url challenge at authorization, and sends `code_verifier` only at code exchange. Missing, duplicate, or invalid authorization PKCE parameters return HTTP 400 `invalid_request` without starting consent.

This update does not change `AUTHORIZATION_VERSION`: existing valid access/refresh tokens keep their current permissions. Previously issued, unexchanged codes must restart authorization; pending consent/callback flows lacking valid S256 parameters cannot continue. Local protocol tests simulate GitHub verification and cover registration, authorization, exchange, refresh, and MCP calls; actual client compatibility still requires reconnection testing after deployment.

The remote MCP endpoint is:
```text
https://<deployed-domain>/mcp
```

#### For Claude Desktop
Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):
```json
{
  "mcpServers": {
    "schwab": {
      "url": "https://<deployed-domain>/mcp"
    }
  }
}
```

#### For Cursor / VS Code / Codex
1. Add new MCP server:
   - **Type**: `Streamable HTTP`
   - **URL**: `https://<deployed-domain>/mcp`
2. Connect. When prompted in the browser:
   - Choose permission scope: **Read only** (recommended for analysis) or **Full access**.
   - Authenticate with GitHub to approve the client.

### Step 5.2: Verification Call
In the MCP client, prompt the model:
> *"Run `get_trading_diagnostics` to check my Schwab connection status and permissions."*

Expected response:
- `schwabConnected: true`
- `permissionLevel: "read_only"` (or `"full_access"`)
- `killswitchEnabled: false`
- `activeTradingState: "DISABLED_BY_KILLSWITCH"` (safe default)

---

## Maintenance & Observability

- **Real-time Tail Logs**:
  ```bash
  npx wrangler tail schwab-mcp --format json
  ```
  Application events contain allowlisted fields only; this is not an automatic scrubber for arbitrary logs. Automatic Invocation Logs and Traces are disabled to avoid full callback URL/query collection. Worker source maps are uploaded outside public assets.
- **Enable Trading (Optional & Caution)**:
  To enable trading operations, update `ENABLE_TRADING` to `"true"` in `wrangler.jsonc` and redeploy (`npm run deploy`). All trading writes still require explicit two-phase phrase repetition.

Optional critical owner email setup, recipient ownership verification and the protected test request are documented in [the deployment guide](README.md#optional-owner-email-alerts). Keep `PROD_EMAIL_ALERTS_ENABLED=false` until the owner confirms a real test message. Local simulation does not deliver mail.
