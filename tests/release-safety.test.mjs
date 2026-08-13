import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  READ_ONLY_D1_QUERIES,
  assertReadOnlySql,
  compareMigrationLedger,
  discoverMigrationNames,
  extractRowsFromWranglerJson,
  isDDrivePath,
  isUnsafeGitRemote,
} from "../scripts/release-preflight.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("OpenAI Sites metadata is absent and local bindings omit optional R2", async () => {
  assert.equal(
    existsSync(new URL("../.openai/hosting.json", import.meta.url)),
    false,
  );
  const bindings = JSON.parse(
    await readFile(new URL("../config/local-bindings.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(bindings, { d1: "DB", r2: null });

  const pluginSource = await readFile(
    new URL("../build/sites-vite-plugin.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(pluginSource, /hosting\.json/);
});

test("release targets are pinned to the reviewed Cloudflare Pages and D1 resources", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const wrangler = JSON.parse(
    await readFile(new URL("../wrangler.d1.jsonc", import.meta.url), "utf8"),
  );

  assert.equal(targets.hosting, "cloudflare-pages-direct-upload");
  assert.equal(targets.pagesProject, "torudake-reel");
  assert.equal(targets.productionBranch, "main");
  assert.equal(targets.d1Database, "torudake-reel-db");
  assert.equal(targets.d1Binding, "DB");
  assert.equal(wrangler.pages_build_output_dir, undefined);
  assert.equal(wrangler.r2_buckets, undefined);
  assert.deepEqual(wrangler.d1_databases, [
    {
      binding: targets.d1Binding,
      database_name: targets.d1Database,
      database_id: targets.d1DatabaseId,
      migrations_dir: targets.d1MigrationsDir,
      migrations_table: targets.d1MigrationsTable,
    },
  ]);
});

test("release preflight rejects C-drive and local filesystem remotes", () => {
  assert.equal(isDDrivePath("D:\\CodexTemp\\release", "win32"), true);
  assert.equal(isDDrivePath("C:\\Users\\example\\release", "win32"), false);
  assert.equal(
    isUnsafeGitRemote("C:\\Users\\example\\old-checkout"),
    true,
  );
  assert.equal(isUnsafeGitRemote("file:///C:/old-checkout"), true);
  assert.equal(isUnsafeGitRemote("../old-checkout"), true);
  assert.equal(isUnsafeGitRemote("https://github.com/example/repo.git"), false);
  assert.equal(isUnsafeGitRemote("git@github.com:example/repo.git"), false);
});

test("migration ledger comparison detects missing, unexpected, and duplicate rows", () => {
  assert.deepEqual(compareMigrationLedger(["0000_a.sql"], ["0000_a.sql"]), {
    aligned: true,
    missing: [],
    unexpected: [],
    duplicateApplied: [],
    outOfOrder: false,
  });
  assert.deepEqual(
    compareMigrationLedger(
      ["0000_a.sql", "0001_b.sql"],
      ["0000_a.sql", "9999_x.sql", "9999_x.sql"],
    ),
    {
      aligned: false,
      missing: ["0001_b.sql"],
      unexpected: ["9999_x.sql", "9999_x.sql"],
      duplicateApplied: ["9999_x.sql"],
      outOfOrder: false,
    },
  );
  assert.deepEqual(
    compareMigrationLedger(
      ["0000_a.sql", "0001_b.sql"],
      ["0001_b.sql", "0000_a.sql"],
    ),
    {
      aligned: false,
      missing: [],
      unexpected: [],
      duplicateApplied: [],
      outOfOrder: true,
    },
  );
});

test("repository migration sequence is continuous and Wrangler JSON is parsed", () => {
  const migrations = discoverMigrationNames(projectRoot);
  assert.equal(migrations[0], "0000_video_transfers.sql");
  assert.equal(migrations.at(-1), "0024_careless_jubilee.sql");
  assert.equal(migrations.length, 25);

  const rows = extractRowsFromWranglerJson(
    '[{"results":[{"name":"0000_video_transfers.sql"}],"success":true}]',
  );
  assert.deepEqual(rows, [{ name: "0000_video_transfers.sql" }]);
});

test("all D1 preflight SQL is provably read-only", () => {
  for (const query of Object.values(READ_ONLY_D1_QUERIES)) {
    assert.equal(assertReadOnlySql(query), query);
  }
  assert.throws(
    () => assertReadOnlySql("INSERT INTO d1_migrations(name) VALUES ('x')"),
    /Refusing non-read-only D1 query/,
  );
  assert.throws(
    () => assertReadOnlySql("SELECT 1; DELETE FROM users"),
    /Refusing non-read-only D1 query/,
  );
  assert.throws(
    () => assertReadOnlySql("SELECT 1"),
    /Refusing non-read-only D1 query/,
  );
  assert.throws(
    () => assertReadOnlySql("PRAGMA writable_schema=ON"),
    /Refusing non-read-only D1 query/,
  );
  assert.throws(
    () => assertReadOnlySql(`${READ_ONLY_D1_QUERIES.quickCheck};`),
    /Refusing non-read-only D1 query/,
  );
  assert.throws(
    () => assertReadOnlySql(` ${READ_ONLY_D1_QUERIES.quickCheck}`),
    /Refusing non-read-only D1 query/,
  );
});
