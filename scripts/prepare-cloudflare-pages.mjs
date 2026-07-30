import { cp, mkdir, rm } from "node:fs/promises";
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
