import { readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TARGETS_PATH = resolve(PROJECT_ROOT, "config", "release-targets.json");
const AUTH_FLAG_NAMES = Object.freeze([
  "OIDC_AUTH_ENABLED",
  "LINE_LOGIN_ENABLED",
  "GOOGLE_OIDC_ENABLED",
  "EMAIL_AUTH_ENABLED",
  "PASSKEY_AUTH_ENABLED",
]);
const EXPECTED_LIVE_FLAGS = Object.freeze({
  OIDC_AUTH_ENABLED: "true",
  LINE_LOGIN_ENABLED: "true",
  GOOGLE_OIDC_ENABLED: "false",
  EMAIL_AUTH_ENABLED: "false",
  PASSKEY_AUTH_ENABLED: "false",
});
const DISABLED_FLAGS = Object.freeze(
  Object.fromEntries(AUTH_FLAG_NAMES.map((name) => [name, "false"])),
);
const CONFIRMATION = "update-pages-auth-flags";

export function parsePagesAuthFlagArguments(argv) {
  const options = { mode: null, path: null, execute: false, confirmation: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (["--capture", "--disable", "--restore"].includes(argument)) {
      if (options.mode) throw new Error("Choose exactly one auth flag operation.");
      options.mode = argument.slice(2);
      continue;
    }
    if (["--output", "--snapshot", "--confirm"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--confirm") options.confirmation = value;
      else options.path = resolve(value);
      continue;
    }
    if (argument === "--execute") {
      options.execute = true;
      continue;
    }
    throw new Error(`Unsupported auth flag argument: ${argument}`);
  }
  if (!options.mode || !options.path || !isAbsolute(options.path)) {
    throw new Error("An operation and an absolute snapshot path are required.");
  }
  const relativeToProject = relative(PROJECT_ROOT, options.path);
  if (
    relativeToProject === "" ||
    (!relativeToProject.startsWith("..") && !isAbsolute(relativeToProject))
  ) {
    throw new Error("The auth flag snapshot must stay outside the repository.");
  }
  if (options.mode === "capture" && options.execute) {
    throw new Error("Capture is read-only and does not accept --execute.");
  }
  if (options.mode !== "capture" && options.execute && options.confirmation !== CONFIRMATION) {
    throw new Error(`Mutation requires --execute --confirm ${CONFIRMATION}.`);
  }
  return options;
}

function normalizeFlagMap(value) {
  const normalized = {};
  for (const name of AUTH_FLAG_NAMES) {
    const entry = value?.[name];
    const flagValue = typeof entry === "string" ? entry : entry?.value;
    const type = typeof entry === "string" ? "plain_text" : entry?.type;
    if (type !== "plain_text" || !["true", "false"].includes(flagValue)) {
      throw new Error(`Authentication flag ${name} is missing or invalid.`);
    }
    normalized[name] = flagValue;
  }
  return normalized;
}

export function assertFlagMap(actual, expected, label) {
  for (const name of AUTH_FLAG_NAMES) {
    if (actual[name] !== expected[name]) {
      throw new Error(`${label} authentication flags do not match at ${name}.`);
    }
  }
}

function snapshotDocument({ targets, flags, capturedAt }) {
  return {
    schemaVersion: 1,
    recordType: "torudake-pages-auth-flags",
    cloudflareAccountId: targets.cloudflareAccountId,
    pagesProject: targets.pagesProject,
    capturedAt,
    flags,
  };
}

async function readSnapshot(path, targets) {
  let parsed;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 16_384) {
      throw new Error("invalid snapshot size");
    }
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Auth flag snapshot could not be read safely.");
  }
  if (
    parsed?.schemaVersion !== 1 ||
    parsed?.recordType !== "torudake-pages-auth-flags" ||
    parsed?.cloudflareAccountId !== targets.cloudflareAccountId ||
    parsed?.pagesProject !== targets.pagesProject
  ) {
    throw new Error("Auth flag snapshot target does not match this release.");
  }
  return normalizeFlagMap(parsed.flags);
}

async function cloudflareRequest({ token, targets, method = "GET", body }) {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
    `/pages/projects/${targets.pagesProject}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Cloudflare Pages API returned ${response.status}.`);
  const payload = await response.json();
  if (payload?.success !== true || !payload.result) {
    throw new Error("Cloudflare Pages API did not return a successful project response.");
  }
  return payload.result;
}

function projectFlags(project) {
  return normalizeFlagMap(project?.deployment_configs?.production?.env_vars);
}

async function updateFlags({ token, targets, flags }) {
  const envVars = Object.fromEntries(
    AUTH_FLAG_NAMES.map((name) => [name, { type: "plain_text", value: flags[name] }]),
  );
  return cloudflareRequest({
    token,
    targets,
    method: "PATCH",
    body: { deployment_configs: { production: { env_vars: envVars } } },
  });
}

export async function runPagesAuthFlags({ argv = process.argv.slice(2), now = Date.now } = {}) {
  const options = parsePagesAuthFlagArguments(argv);
  const targets = JSON.parse(await readFile(TARGETS_PATH, "utf8"));
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("CLOUDFLARE_API_TOKEN is required.");
  }
  const before = projectFlags(await cloudflareRequest({ token, targets }));

  if (options.mode === "capture") {
    assertFlagMap(before, EXPECTED_LIVE_FLAGS, "Live production");
    const document = snapshotDocument({
      targets,
      flags: before,
      capturedAt: new Date(now()).toISOString(),
    });
    await writeFile(options.path, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { mode: "capture", snapshotPath: options.path, mutationPerformed: false };
  }

  const snapshot = await readSnapshot(options.path, targets);
  const desired = options.mode === "disable" ? DISABLED_FLAGS : snapshot;
  if (options.mode === "restore") {
    try {
      assertFlagMap(before, snapshot, "Current production");
      return {
        mode: "restore",
        dryRun: !options.execute,
        alreadyRestored: true,
        mutationPerformed: false,
      };
    } catch {
      // Continue only when the current values are the exact disabled snapshot.
    }
  }
  const expectedBefore = options.mode === "disable" ? snapshot : DISABLED_FLAGS;
  assertFlagMap(before, expectedBefore, "Current production");
  if (!options.execute) {
    return { mode: options.mode, dryRun: true, mutationPerformed: false };
  }
  const after = projectFlags(await updateFlags({ token, targets, flags: desired }));
  assertFlagMap(after, desired, "Updated production");
  return { mode: options.mode, dryRun: false, mutationPerformed: true };
}

async function main() {
  try {
    const result = await runPagesAuthFlags();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(`[BLOCKED] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { AUTH_FLAG_NAMES, DISABLED_FLAGS, EXPECTED_LIVE_FLAGS };
