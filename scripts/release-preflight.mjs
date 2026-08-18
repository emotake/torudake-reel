import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
export const READ_ONLY_D1_QUERIES = Object.freeze({
  ledger: "SELECT name FROM d1_migrations ORDER BY id",
  quickCheck: "PRAGMA quick_check",
  foreignKeyCheck: "PRAGMA foreign_key_check",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function isDDrivePath(path, platform = process.platform) {
  if (platform !== "win32") return true;
  return /^D:[\\/]/i.test(String(path));
}

export function isUnsafeGitRemote(remote) {
  const value = remote.trim();
  return !(
    /^https:\/\/[^/]+\/.+/i.test(value) ||
    /^ssh:\/\/[^/]+\/.+/i.test(value) ||
    /^[\w.-]+@[\w.-]+:.+/.test(value)
  );
}

export function discoverMigrationNames(root = PROJECT_ROOT) {
  const directory = resolve(root, "drizzle");
  const names = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right));

  const versions = names.map((name) => Number.parseInt(name.slice(0, 4), 10));
  const sequenceIsContinuous = versions.every(
    (version, index) => version === index,
  );

  if (names.length === 0 || !sequenceIsContinuous) {
    throw new Error(
      "drizzle migration files must form one continuous sequence from 0000.",
    );
  }

  return names;
}

export function compareMigrationLedger(expected, applied) {
  const expectedSet = new Set(expected);
  const appliedSet = new Set(applied);
  const duplicateApplied = applied.filter(
    (name, index) => applied.indexOf(name) !== index,
  );
  const missing = expected.filter((name) => !appliedSet.has(name));
  const unexpected = applied.filter((name) => !expectedSet.has(name));
  const outOfOrder =
    missing.length === 0 &&
    unexpected.length === 0 &&
    duplicateApplied.length === 0 &&
    expected.some((name, index) => applied[index] !== name);

  return {
    aligned:
      missing.length === 0 &&
      unexpected.length === 0 &&
      duplicateApplied.length === 0 &&
      !outOfOrder &&
      expected.length === applied.length,
    missing,
    unexpected,
    duplicateApplied: [...new Set(duplicateApplied)],
    outOfOrder,
  };
}

export function extractRowsFromWranglerJson(stdout) {
  const trimmed = stdout.trim();
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  const jsonText =
    firstBracket >= 0 && lastBracket >= firstBracket
      ? trimmed.slice(firstBracket, lastBracket + 1)
      : trimmed;
  const parsed = JSON.parse(jsonText);
  const batches = Array.isArray(parsed) ? parsed : [parsed];

  return batches.flatMap((batch) =>
    Array.isArray(batch?.results) ? batch.results : [],
  );
}

export function assertReadOnlySql(query) {
  if (
    typeof query !== "string" ||
    !Object.values(READ_ONLY_D1_QUERIES).includes(query)
  ) {
    throw new Error(`Refusing non-read-only D1 query: ${query}`);
  }
  return query;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function runGit(args) {
  return run("git", args);
}

function runD1Query(database, query) {
  const safeQuery = assertReadOnlySql(query);
  const wranglerBin = resolve(
    PROJECT_ROOT,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  const result = run(process.execPath, [
    wranglerBin,
    "d1",
    "execute",
    database,
    "--remote",
    "--config",
    resolve(PROJECT_ROOT, "wrangler.d1.jsonc"),
    "--command",
    safeQuery,
    "--json",
  ]);

  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "Wrangler D1 query failed.").trim(),
    );
  }
  return extractRowsFromWranglerJson(result.stdout);
}

function checkExactObject(actual, expected, label, errors) {
  if (!isDeepStrictEqual(actual, expected)) {
    errors.push(`${label} does not match the release contract.`);
  }
}

export function runLocalChecks({ root = PROJECT_ROOT } = {}) {
  const errors = [];
  const notes = [];

  if (!isDDrivePath(root)) {
    errors.push(`Project must be released from drive D: (${root}).`);
  }

  const sitesMetadata = resolve(root, ".openai", "hosting.json");
  if (existsSync(sitesMetadata)) {
    errors.push(
      ".openai/hosting.json must stay absent; production uses Cloudflare Pages, not OpenAI Sites.",
    );
  }

  const localBindings = readJson(resolve(root, "config", "local-bindings.json"));
  checkExactObject(
    localBindings,
    { d1: "DB", r2: null },
    "Local bindings",
    errors,
  );

  const targets = readJson(resolve(root, "config", "release-targets.json"));
  const expectedTargets = {
    hosting: "cloudflare-pages-direct-upload",
    pagesProject: "torudake-reel",
    productionBranch: "main",
    productionUrl: "https://torudake-reel.pages.dev",
    d1Binding: "DB",
    d1Database: "torudake-reel-db",
    d1DatabaseId: "c0b9cc06-fc19-4e02-acac-2c19d32f3fdc",
    d1MigrationsDir: "drizzle",
    d1MigrationsTable: "d1_migrations",
    authObservabilityBinding: "AUTH_OBSERVABILITY",
    authObservabilityDataset: "torudake_line_auth_events",
    observabilityContract: "config/observability.json",
  };
  checkExactObject(targets, expectedTargets, "Release targets", errors);

  const observability = readJson(
    resolve(root, targets.observabilityContract),
  );
  if (
    observability?.schemaVersion !== 1 ||
    observability?.production?.structuredLogs !== true ||
    observability?.production?.sampling?.errors !== 1 ||
    observability?.production?.sampling?.warnings !== 1 ||
    observability?.production?.sampling?.success !== 1 ||
    observability?.production?.durableAuthentication?.binding !==
      targets.authObservabilityBinding ||
    observability?.production?.durableAuthentication?.dataset !==
      targets.authObservabilityDataset ||
    observability?.production?.durableAuthentication?.retention !==
      "three_months" ||
    observability?.production?.durableAuthentication?.sampling !== 1
  ) {
    errors.push(
      "Production observability must keep structured LINE authentication events at full sampling.",
    );
  } else {
    notes.push("Production observability contract is present.");
  }

  if (existsSync(resolve(root, "wrangler.jsonc"))) {
    errors.push(
      "Do not deploy a partial root wrangler.jsonc: it would replace the existing Pages dashboard configuration. Add Pages bindings in the dashboard and redeploy instead.",
    );
  } else {
    notes.push("Pages dashboard remains the source of truth for production bindings.");
  }

  const wranglerConfig = readJson(resolve(root, "wrangler.d1.jsonc"));
  const databaseConfig = wranglerConfig.d1_databases?.[0];
  checkExactObject(
    databaseConfig,
    {
      binding: targets.d1Binding,
      database_name: targets.d1Database,
      database_id: targets.d1DatabaseId,
      migrations_dir: targets.d1MigrationsDir,
      migrations_table: targets.d1MigrationsTable,
    },
    "D1 maintenance binding",
    errors,
  );
  if (
    wranglerConfig.pages_build_output_dir ||
    wranglerConfig.r2_buckets ||
    wranglerConfig.d1_databases?.length !== 1
  ) {
    errors.push(
      "wrangler.d1.jsonc must remain D1-only and must never configure Pages or R2.",
    );
  }
  if (
    wranglerConfig.observability?.enabled !== true ||
    wranglerConfig.observability?.logs?.enabled !== true ||
    wranglerConfig.observability?.logs?.head_sampling_rate !== 1 ||
    wranglerConfig.observability?.traces?.enabled !== false
  ) {
    errors.push(
      "D1 maintenance observability must preserve all logs and keep paid traces disabled.",
    );
  }

  let migrations = [];
  try {
    migrations = discoverMigrationNames(root);
    notes.push(`Found ${migrations.length} ordered D1 migrations.`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const remoteResult = runGit(["remote", "get-url", "--all", "origin"]);
  if (remoteResult.status !== 0) {
    notes.push(
      "Git origin is intentionally unset; this checkout supports reviewed Cloudflare Pages Direct Upload only.",
    );
  } else {
    const remotes = remoteResult.stdout.split(/\r?\n/).filter(Boolean);
    const unsafe = remotes.filter(isUnsafeGitRemote);
    if (unsafe.length > 0) {
      errors.push(
        `Git origin still points to a local filesystem path: ${unsafe.join(", ")}`,
      );
    }
  }

  const statusResult = runGit(["status", "--porcelain"]);
  if (statusResult.status !== 0) {
    errors.push("Unable to inspect the Git worktree.");
  } else if (statusResult.stdout.trim()) {
    errors.push("Git worktree is not clean; commit and review the exact release first.");
  }

  return { errors, migrations, notes, targets };
}

function checkDDriveEnvironment(errors) {
  if (process.platform !== "win32") return;
  for (const name of [
    "TEMP",
    "TMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "WRANGLER_LOG_PATH",
  ]) {
    const value = process.env[name];
    if (!value || !isDDrivePath(value)) {
      errors.push(`${name} must point to drive D: before contacting Cloudflare.`);
    }
  }
}

export function runRemoteD1Checks(targets, expectedMigrations) {
  const errors = [];
  const notes = [];
  checkDDriveEnvironment(errors);
  if (errors.length > 0) return { errors, notes };

  try {
    const ledgerRows = runD1Query(
      targets.d1Database,
      READ_ONLY_D1_QUERIES.ledger,
    );
    const ledger = ledgerRows
      .map((row) => row?.name)
      .filter((name) => typeof name === "string");
    const comparison = compareMigrationLedger(expectedMigrations, ledger);
    if (!comparison.aligned) {
      errors.push(
        [
          "D1 migration ledger does not match the repository.",
          comparison.missing.length
            ? `missing=${comparison.missing.join(",")}`
            : "",
          comparison.unexpected.length
            ? `unexpected=${comparison.unexpected.join(",")}`
            : "",
          comparison.duplicateApplied.length
            ? `duplicates=${comparison.duplicateApplied.join(",")}`
            : "",
          comparison.outOfOrder ? "order=incorrect" : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } else {
      notes.push("D1 migration ledger matches the repository.");
    }

    const quickRows = runD1Query(
      targets.d1Database,
      READ_ONLY_D1_QUERIES.quickCheck,
    );
    const quickValue = quickRows[0] && Object.values(quickRows[0])[0];
    if (quickValue !== "ok") {
      errors.push(`D1 quick_check failed: ${String(quickValue)}`);
    } else {
      notes.push("D1 quick_check is ok.");
    }

    const foreignKeyRows = runD1Query(
      targets.d1Database,
      READ_ONLY_D1_QUERIES.foreignKeyCheck,
    );
    if (foreignKeyRows.length > 0) {
      errors.push(
        `D1 foreign_key_check reported ${foreignKeyRows.length} violation(s).`,
      );
    } else {
      notes.push("D1 foreign_key_check found no violations.");
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return { errors, notes };
}

function printResult(result, { offline }) {
  for (const note of result.notes) console.log(`[OK] ${note}`);
  if (offline) {
    console.log(
      "[INFO] Remote D1 checks were skipped; offline mode never authorizes a release.",
    );
  }
  for (const error of result.errors) console.error(`[BLOCKED] ${error}`);
}

function main() {
  const offline = process.argv.includes("--offline");
  const local = runLocalChecks();
  const remote = offline
    ? { errors: [], notes: [] }
    : runRemoteD1Checks(local.targets, local.migrations);
  const result = {
    errors: [...local.errors, ...remote.errors],
    notes: [...local.notes, ...remote.notes],
  };
  printResult(result, { offline });
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === SCRIPT_PATH.toLowerCase()
) {
  main();
}
