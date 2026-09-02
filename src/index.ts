import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { AuthHandler } from "./auth";
import type { AppEnv } from "./env";
import { createServer } from "./tools";

export { SchwabVault } from "./vault";

const apiHandler = {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(() => createServer(env), {
      legacy: "stateless",
      responseMode: "auto",
      onerror(error) {
        console.error(JSON.stringify({ event: "mcp_handler_error", message: error.message }));
      },
    });
    ctx.passThroughOnException();
    return handler.fetch(request);
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
