import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const projectRoot = process.cwd();
const clientDirectory = resolve(projectRoot, "dist/client");
const pagesDirectory = resolve(projectRoot, "dist/cloudflare-pages");
const relativePagesDirectory = relative(projectRoot, pagesDirectory);

if (
  !relativePagesDirectory ||
  relativePagesDirectory.startsWith("..") ||
  relativePagesDirectory.includes(":")
) {
  throw new Error("Cloudflare Pages output must stay inside the project.");
}

await rm(pagesDirectory, { force: true, recursive: true });
await mkdir(pagesDirectory, { recursive: true });
await cp(clientDirectory, pagesDirectory, { recursive: true });

// Advanced-mode Pages projects otherwise invoke _worker.js for every request.
// Keep all document and application routes in the Worker, and bypass it only
// for files that are safe to serve directly from the static asset namespace.
const routes = {
  version: 1,
  include: ["/*"],
  exclude: [
    "/assets/*",
    "/favicon.svg",
    "/file.svg",
    "/globe.svg",
    "/manifest.webmanifest",
    "/og.png",
    "/robots.txt",
    "/sitemap.xml",
    "/window.svg",
  ],
};

await writeFile(
  resolve(pagesDirectory, "_routes.json"),
  `${JSON.stringify(routes, null, 2)}\n`,
  "utf8",
);
