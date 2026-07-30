import worker from "./dist/server/index.js";
import { setRuntimeEnvironment } from "./cloudflare-pages-env-shim.mjs";

export default {
  async fetch(request, env, context) {
    setRuntimeEnvironment(env);
    const url = new URL(request.url);

    // Cloudflare Pages advanced mode sends every request through _worker.js.
    // Vinext's generated worker assumes its hashed client assets are served
    // before the worker (the Workers Static Assets default), so forward those
    // files explicitly when running on Pages.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      url.pathname.startsWith("/assets/")
    ) {
      return env.ASSETS.fetch(request);
    }

    return worker.fetch(request, env, context);
  },
};
