import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./cloudflare-pages-env-shim.mjs", import.meta.url),
      ),
    },
  },
  build: {
    ssr: "cloudflare-pages-entry.mjs",
    outDir: "dist/cloudflare-pages",
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "_worker.js",
        format: "es",
        codeSplitting: false,
      },
    },
  },
});
