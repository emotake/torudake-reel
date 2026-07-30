import worker from "./dist/server/index.js";
import { setRuntimeEnvironment } from "./cloudflare-pages-env-shim.mjs";

export default {
  async fetch(request, env, context) {
    setRuntimeEnvironment(env);
    return worker.fetch(request, env, context);
  },
};
