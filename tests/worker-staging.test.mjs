import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../wrangler.worker-staging.jsonc", import.meta.url);
const productionTargetsUrl = new URL(
  "../config/release-targets.json",
  import.meta.url,
);
const stagingTargetsUrl = new URL(
  "../config/worker-staging-targets.json",
  import.meta.url,
);
const packageUrl = new URL("../package.json", import.meta.url);

test("Workers staging is isolated from production and stays on the free-safe path", async () => {
  const [config, productionTargets, stagingTargets, packageJson] = await Promise.all([
    readJson(configUrl),
    readJson(productionTargetsUrl),
    readJson(stagingTargetsUrl),
    readJson(packageUrl),
  ]);

  assert.equal(config.name, "torudake-reel-worker-staging");
  assert.equal(config.workers_dev, true);
  assert.equal(config.preview_urls, false);
  assert.equal(config.main, "cloudflare-pages-entry.mjs");
  assert.equal(config.assets.directory, "./dist/client");
  assert.equal(config.assets.binding, "ASSETS");
  assert.deepEqual(config.assets.run_worker_first, ["/demo/*"]);
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.logs.persist, true);

  const stagingDb = config.d1_databases.find(({ binding }) => binding === "DB");
  assert.equal(stagingDb.database_name, "torudake-reel-worker-staging-db");
  assert.notEqual(stagingDb.database_id, productionTargets.d1DatabaseId);
  assert.equal(stagingDb.database_id, stagingTargets.d1DatabaseId);
  assert.equal(stagingTargets.servesProductionTraffic, false);
  assert.equal(stagingTargets.secretsProvisioned, false);
  assert.equal(stagingTargets.r2Provisioned, false);

  assert.equal(Object.hasOwn(config, "r2_buckets"), false);
  assert.equal(Object.hasOwn(config, "vars"), false);
  assert.match(packageJson.scripts["worker:staging:dry-run"], /--dry-run/);
  assert.match(packageJson.scripts["worker:staging:deploy"], /vinext build/);
});

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}
