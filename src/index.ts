import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { AuthHandler } from "./auth";
import type { AppEnv } from "./env";
import { createServer } from "./tools";

export { SchwabVault } from "./vault";

const apiHandler = {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Method",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const handler = createMcpHandler(() => createServer(env), {
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

export default new OAuthProvider({
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler: AuthHandler,
});
