import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const prepareScript = new URL(
  "../scripts/prepare-cloudflare-pages.mjs",
  import.meta.url,
);

const workerRoutes = [
  "/",
  "/privacy",
  "/terms",
  "/commercial-disclosure",
  "/account",
  "/account/profile",
  "/api/usage",
  "/internal/health",
];

function routeMatches(rule, pathname) {
  return rule.endsWith("*")
    ? pathname.startsWith(rule.slice(0, -1))
    : pathname === rule;
}

test("emits a valid Pages route manifest that bypasses only static files", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cloudflare-pages-routes-"));
  t.after(() => rm(projectRoot, { force: true, recursive: true }));

  const clientDirectory = join(projectRoot, "dist", "client");
  await mkdir(join(clientDirectory, "assets"), { recursive: true });
  await writeFile(join(clientDirectory, "assets", "app.js"), "fixture");

  await execFileAsync(process.execPath, [fileURLToPath(prepareScript)], {
    cwd: projectRoot,
  });

  const outputDirectory = join(projectRoot, "dist", "cloudflare-pages");
  const manifest = JSON.parse(
    await readFile(join(outputDirectory, "_routes.json"), "utf8"),
  );

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.include, ["/*"]);
  assert.deepEqual(manifest.exclude, [
    "/assets/*",
    "/favicon.svg",
    "/file.svg",
    "/globe.svg",
    "/manifest.webmanifest",
    "/og.png",
    "/robots.txt",
    "/sitemap.xml",
    "/window.svg",
  ]);

  const rules = [...manifest.include, ...manifest.exclude];
  assert.ok(rules.length <= 100, "Pages accepts at most 100 routing rules");
  assert.ok(
    rules.every((rule) => rule.length <= 100),
    "Pages accepts routing rules of at most 100 characters",
  );
  assert.ok(
    workerRoutes.every((pathname) =>
      manifest.exclude.every((rule) => !routeMatches(rule, pathname)),
    ),
    "documents and application endpoints must continue through the Worker",
  );

  assert.equal(
    await readFile(join(outputDirectory, "assets", "app.js"), "utf8"),
    "fixture",
    "the route manifest must be emitted alongside copied static assets",
  );
});
