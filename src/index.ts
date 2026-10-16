import worker from "./worker";
import { acceptanceFetch } from "./acceptance";
import type { AppEnv } from "./env";
export { SchwabVault } from "./vault";
export { AcceptanceVault } from "./acceptance";
export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    return new URL(request.url).pathname.startsWith("/__test")
      ? acceptanceFetch(request, env, ctx)
      : worker.fetch(request, env, ctx);
  },
};
