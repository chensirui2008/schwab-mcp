import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { AuthHandler } from "./auth";
import type { AppEnv } from "./env";
import { isCurrentAuthorization, READ_SCOPE, resolveClientPolicy, validateTokenExchange } from "./oauth-access";
import type { ClientPolicy } from "./security-store";
import { createServer } from "./tools";

export { SchwabVault } from "./vault";

const apiHandler = {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Method",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const props: unknown = ctx.props;
    if (!isCurrentAuthorization(props) || props.userId !== env.ALLOWED_GITHUB_USER_ID) {
      return Response.json({ error: "invalid_token", error_description: "MCP authorization expired; reconnect and select a permission level" }, {
        status: 401,
        headers: {
          ...cors,
          "WWW-Authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", request.url).href}", error="invalid_token"`,
        },
      });
    }
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    const summary = token ? await env.OAUTH_PROVIDER.unwrapToken<unknown>(token) : null;
    if (!summary || (props.clientId !== undefined && props.clientId !== summary.grant.clientId)) return Response.json({ error: "invalid_token" }, { status: 401, headers: cors });
    let policy: ClientPolicy;
    try {
      policy = await resolveClientPolicy(env, summary.grant.clientId, props);
    } catch {
      return Response.json({ error: "temporarily_unavailable", error_description: "Client policy is unavailable; retry later" }, { status: 503, headers: cors });
    }
    if (policy.revoked) {
      return Response.json({ error: "invalid_token", error_description: "Client authorization revoked" }, { status: 401, headers: cors });
    }
    const identity = {
      clientId: summary.grant.clientId,
      advancedSecurity: policy.advancedSecurity,
      securityPolicyVersion: policy.version,
    };
    const handler = createMcpHandler(() => createServer(env, policy.permissionLevel, identity, ctx), {
      legacy: "stateless",
      responseMode: "auto",
      onerror(error) {
        console.error(JSON.stringify({ event: "mcp_handler_error", errorType: error.name }));
      },
    });
    const response = await handler.fetch(request);
    const headers = new Headers(response.headers);
    Object.entries(cors).forEach(([key, value]) => {
      headers.set(key, value);
    });
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    // OAuth callbacks must close over this request's bindings, never mutable
    // isolate-global state shared with production or acceptance requests.
    const oauthProvider = new OAuthProvider({
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler: AuthHandler,
      scopesSupported: [READ_SCOPE],
      allowPlainPKCE: false,
      tokenExchangeCallback: (options) => validateTokenExchange(options, env),
    });
    return oauthProvider.fetch(request, env, ctx);
  },
};
