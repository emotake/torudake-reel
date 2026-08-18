#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, open, readFile, readdir, unlink } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { readBoundedJsonResponse } from "../../lib/bounded-json-response.mjs";
import {
  assertExternalPagesReleasePath,
  assertReviewedCleanHead,
  assertValidPagesArtifactManifest,
  createExternalReleaseTempDirectory,
  createPagesArtifactManifest,
  createVerifiedPagesArtifactSnapshot,
  readPagesArtifactManifestFile,
  removeExternalReleaseTempDirectory,
  verifyPagesArtifactDirectory,
  verifyPagesArtifactManifest,
  writePagesArtifactManifestExclusive,
} from "../../lib/pages-release-artifact.mjs";

export const PREPARE_CONFIRMATION = "prepare-pages-release";
export const DEPLOY_CONFIRMATION = "deploy-cloudflare-pages";
export const PAGES_DEPLOYMENT_RECORD_SCHEMA_VERSION = 1;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..", "..");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const MAX_COMMAND_JSON_BYTES = 2 * 1024 * 1024;
const MAX_API_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_JSON_BYTES = 32 * 1024;
const MAX_DEPLOYMENT_RECORD_BYTES = 64 * 1024;
const MAX_DEPLOYMENT_PAGES = 50;
const DEPLOYMENTS_PER_PAGE = 100;
const SNAPSHOT_PREFIX = ".torudake-pages-stage-";
const WRANGLER_CWD_PREFIX = ".torudake-pages-wrangler-";
const RELEASE_MESSAGE_PATTERN =
  /^torudake-pages-v1 commit=([0-9a-f]{40}) artifactSha256=([0-9a-f]{64})$/;
const AUTH_FLAG_NAMES = Object.freeze([
  "OIDC_AUTH_ENABLED",
  "LINE_LOGIN_ENABLED",
  "GOOGLE_OIDC_ENABLED",
  "EMAIL_AUTH_ENABLED",
  "PASSKEY_AUTH_ENABLED",
]);
const PINNED_TARGET = Object.freeze({
  hosting: "cloudflare-pages-direct-upload",
  cloudflareAccountId: "e7572bf15e2fc4346e54f72ed7cb3ff0",
  pagesProject: "torudake-reel",
  productionBranch: "main",
  productionUrl: "https://torudake-reel.pages.dev",
  d1Binding: "DB",
  d1DatabaseId: "c0b9cc06-fc19-4e02-acac-2c19d32f3fdc",
  authObservabilityBinding: "AUTH_OBSERVABILITY",
  authObservabilityDataset: "torudake_line_auth_events",
});
const PINNED_LEGACY_PREVIOUS_PRODUCTION = Object.freeze({
  deploymentId: "f8bee356-6458-4c91-9e29-b3febcd5e4fc",
  sourceCommit: "35abc4dde3d45a48b2d422da8f37a3b314e036ee",
  commitMessage: "fix: harden LINE login lifecycle and observability",
  createdOn: "2026-08-18T08:51:43.113033Z",
  methodsSchema: "line_only_without_authentication_flags",
});

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function valueAfter(argv, name) {
  const indexes = argv.flatMap((value, index) => (value === name ? [index] : []));
  if (indexes.length > 1) {
    throw new Error(`${name} may only be specified once.`);
  }
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parsePagesReleaseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("Release arguments must be an array of strings.");
  }
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }
  if (argv.includes("--")) {
    throw new Error("The package-manager separator is valid only once at the start.");
  }
  const valueFlags = new Set([
    "--manifest",
    "--external-root",
    "--deployment-record",
    "--confirm",
  ]);
  const booleanFlags = new Set([
    "--prepare",
    "--deploy",
    "--execute",
    "--provision-disabled-rollback",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (valueFlags.has(value)) {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new Error(`${value} requires a value.`);
      }
    } else if (!booleanFlags.has(value)) {
      throw new Error(`Unsupported Pages release argument: ${value}`);
    }
  }
  for (const flag of booleanFlags) {
    if (argv.filter((value) => value === flag).length > 1) {
      throw new Error(`${flag} may only be specified once.`);
    }
  }
  const prepare = argv.includes("--prepare");
  const deploy = argv.includes("--deploy");
  if (prepare === deploy) {
    throw new Error("Select exactly one of --prepare or --deploy.");
  }
  const manifestPath = valueAfter(argv, "--manifest");
  if (!manifestPath) {
    throw new Error("--manifest is required.");
  }
  const externalRoot = valueAfter(argv, "--external-root");
  const deploymentRecord = valueAfter(argv, "--deployment-record");
  if (
    !isAbsolute(manifestPath) ||
    (externalRoot !== undefined && !isAbsolute(externalRoot)) ||
    (deploymentRecord !== undefined && !isAbsolute(deploymentRecord))
  ) {
    throw new Error("Pages release paths must be absolute.");
  }
  if (prepare && !externalRoot) {
    throw new Error("--prepare requires --external-root.");
  }
  const provisionDisabledRollback = argv.includes(
    "--provision-disabled-rollback",
  );
  if (prepare && provisionDisabledRollback) {
    throw new Error("Rollback provisioning is only valid with --deploy.");
  }
  const execute = argv.includes("--execute");
  const confirmation = valueAfter(argv, "--confirm");
  const expectedConfirmation = prepare
    ? PREPARE_CONFIRMATION
    : DEPLOY_CONFIRMATION;
  if (execute && confirmation !== expectedConfirmation) {
    throw new Error(
      `Mutation requires --execute --confirm ${expectedConfirmation}.`,
    );
  }
  if (!execute && confirmation) {
    throw new Error("--confirm is only valid together with --execute.");
  }
  return {
    mode: prepare ? "prepare" : "deploy",
    manifestPath: resolve(manifestPath),
    externalRoot: externalRoot ? resolve(externalRoot) : undefined,
    deploymentRecordPath: deploymentRecord,
    provisionDisabledRollback,
    execute,
  };
}

async function loadPinnedTargets(projectRoot) {
  let targets;
  try {
    targets = JSON.parse(
      await readFile(resolve(projectRoot, "config", "release-targets.json"), "utf8"),
    );
  } catch {
    throw new Error("Pinned Pages release targets could not be read.");
  }
  for (const [key, expected] of Object.entries(PINNED_TARGET)) {
    if (targets?.[key] !== expected) {
      throw new Error(`Pinned Pages release target ${key} does not match.`);
    }
  }
  if (
    typeof targets?.rollbackPolicy?.provisioningConfirmation !== "string" ||
    !/^[a-z0-9-]{8,80}$/.test(
      targets.rollbackPolicy.provisioningConfirmation,
    )
  ) {
    throw new Error("Rollback provisioning confirmation is invalid.");
  }
  if (
    !exactKeys(
      targets.rollbackPolicy.requiredDisabledAuthenticationFlags,
      AUTH_FLAG_NAMES,
    ) ||
    AUTH_FLAG_NAMES.some(
      (name) =>
        targets.rollbackPolicy.requiredDisabledAuthenticationFlags[name] !==
        "false",
    )
  ) {
    throw new Error("Disabled authentication flag contract is invalid.");
  }
  const legacyPrevious = targets.rollbackPolicy.legacyPreviousProduction;
  if (
    !exactKeys(legacyPrevious, [
      "deploymentId",
      "sourceCommit",
      "commitMessage",
      "createdOn",
      "methodsSchema",
    ]) ||
    !isDeepStrictEqual(legacyPrevious, PINNED_LEGACY_PREVIOUS_PRODUCTION)
  ) {
    throw new Error("Legacy previous-production adoption contract is invalid.");
  }
  const pagesArtifact = targets?.pagesArtifact;
  if (
    pagesArtifact?.root !== "dist/cloudflare-pages" ||
    pagesArtifact?.releaseMessagePrefix !== "torudake-pages-v1" ||
    pagesArtifact?.manifestEnvironmentVariable !==
      "TORUDAKE_PAGES_ARTIFACT_MANIFEST" ||
    pagesArtifact?.manifestSchemaVersion !== 1 ||
    pagesArtifact?.deployConfirmation !== DEPLOY_CONFIRMATION
  ) {
    throw new Error("Pinned Pages artifact release contract does not match.");
  }
  return targets;
}

function spawnResult(
  spawnCommand,
  executable,
  args,
  { cwd, env, capture = false, label },
) {
  const result = spawnCommand(executable, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    maxBuffer: MAX_COMMAND_JSON_BYTES,
  });
  if (!result || result.status !== 0 || result.error) {
    throw new Error(`${label} failed.`);
  }
  if (capture && typeof result.stdout !== "string") {
    throw new Error(`${label} did not return text output.`);
  }
  return result;
}

function createGitRunner(spawnCommand, env) {
  return (args, cwd) =>
    spawnCommand("git", args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_COMMAND_JSON_BYTES,
    });
}

function readCurrentHead(projectRoot, runGit) {
  const result = runGit(
    ["rev-parse", "--verify", "HEAD^{commit}"],
    projectRoot,
  );
  const sourceCommit =
    result?.status === 0 && typeof result.stdout === "string"
      ? result.stdout.trim()
      : "";
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error("Current Git HEAD could not be resolved as a lowercase commit.");
  }
  assertReviewedCleanHead({ projectRoot, sourceCommit, runGit });
  return sourceCommit;
}

export function pagesBuildCommands(projectRoot = PROJECT_ROOT) {
  return [
    {
      executable: process.execPath,
      args: [resolve(projectRoot, "node_modules", "vinext", "dist", "cli.js"), "build"],
      label: "vinext production build",
    },
    {
      executable: process.execPath,
      args: [resolve(projectRoot, "scripts", "prepare-cloudflare-pages.mjs")],
      label: "Cloudflare Pages artifact preparation",
    },
    {
      executable: process.execPath,
      args: [
        resolve(projectRoot, "node_modules", "vite", "bin", "vite.js"),
        "build",
        "--config",
        resolve(projectRoot, "cloudflare-pages.vite.config.mjs"),
      ],
      label: "Cloudflare Pages worker build",
    },
  ];
}

export function pagesDeployArguments({
  projectRoot = PROJECT_ROOT,
  targets,
  manifest,
  artifactDirectory,
}) {
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit: manifest?.sourceCommit,
  });
  if (
    targets?.pagesProject !== PINNED_TARGET.pagesProject ||
    targets?.productionBranch !== PINNED_TARGET.productionBranch ||
    typeof artifactDirectory !== "string" ||
    !isAbsolute(artifactDirectory)
  ) {
    throw new Error("Pages deploy target and snapshot must be pinned.");
  }
  return [
    resolve(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
    "pages",
    "deploy",
    resolve(artifactDirectory),
    "--project-name",
    targets.pagesProject,
    "--branch",
    targets.productionBranch,
    "--commit-hash",
    manifest.sourceCommit,
    "--commit-message",
    manifest.deploymentMessage,
    "--commit-dirty=false",
    "--no-bundle",
    "--experimental-provision=false",
    "--experimental-auto-create=false",
  ];
}

function parseCommandJson(result, label) {
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_JSON_BYTES) {
    throw new Error(`${label} output exceeds the release limit.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export async function assertWranglerCwdHasNoConfig(wranglerCwd) {
  const resolvedCwd = resolve(wranglerCwd);
  const forbidden = new Set([
    "wrangler.toml",
    "wrangler.json",
    "wrangler.jsonc",
    "wrangler.config.ts",
    "cloudflare.config.ts",
  ]);
  const entries = await readdir(resolvedCwd, { withFileTypes: true }).catch(
    () => null,
  );
  if (
    !entries ||
    entries.some(
      (entry) => entry.isSymbolicLink() || forbidden.has(entry.name.toLowerCase()),
    )
  ) {
    throw new Error("Isolated Wrangler cwd contains a config or link.");
  }
  let cursor = resolvedCwd;
  while (true) {
    const stats = await lstat(cursor, { bigint: true }).catch(() => null);
    if (!stats || !stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error("Isolated Wrangler cwd has a linked or invalid ancestor.");
    }
    const configCandidates = [
      ...forbidden,
      join(".wrangler", "deploy", "config.json"),
    ];
    for (const candidate of configCandidates) {
      if (await lstat(resolve(cursor, candidate)).catch(() => null)) {
        throw new Error(
          "Isolated Wrangler cwd or an ancestor contains a Wrangler config.",
        );
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

function cloudflareApiToken({
  spawnCommand,
  projectRoot,
  wranglerCwd,
  env,
  targets,
}) {
  const wranglerPath = resolve(
    projectRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  const identityResult = spawnResult(
    spawnCommand,
    process.execPath,
    [wranglerPath, "whoami", "--json"],
    {
      cwd: wranglerCwd,
      env,
      capture: true,
      label: "Cloudflare identity verification",
    },
  );
  const identity = parseCommandJson(identityResult, "Cloudflare identity");
  if (
    !Array.isArray(identity?.accounts) ||
    !identity.accounts.some((account) => account?.id === targets.cloudflareAccountId)
  ) {
    throw new Error("Wrangler is not authenticated to the pinned Cloudflare account.");
  }
  const tokenResult = spawnResult(
    spawnCommand,
    process.execPath,
    [wranglerPath, "auth", "token", "--json"],
    {
      cwd: wranglerCwd,
      env,
      capture: true,
      label: "Cloudflare credential retrieval",
    },
  );
  const credential = parseCommandJson(tokenResult, "Cloudflare credential");
  if (
    !["oauth", "api_token"].includes(credential?.type) ||
    typeof credential?.token !== "string" ||
    credential.token.length < 20
  ) {
    throw new Error("Wrangler did not provide a usable Cloudflare credential.");
  }
  return credential.token;
}

async function fetchBoundedJson({
  fetchImpl,
  url,
  method = "GET",
  headers = {},
  body,
  maxBytes = MAX_API_JSON_BYTES,
  timeoutMs = 15_000,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Release verification endpoint returned a non-success response.");
    }
    const value = await readBoundedJsonResponse(response, { maxBytes });
    return { value, response };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCloudflareJson(
  fetchImpl,
  url,
  token,
  { method = "GET", body } = {},
) {
  const result = await fetchBoundedJson({
    fetchImpl,
    url,
    method,
    body,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  });
  return result.value;
}

function pagesDeploymentsApi(targets) {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
    `/pages/projects/${encodeURIComponent(targets.pagesProject)}/deployments`
  );
}

function pagesProjectApi(targets) {
  return (
    `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
    `/pages/projects/${encodeURIComponent(targets.pagesProject)}`
  );
}

async function listAllProductionDeployments({ fetchImpl, token, targets }) {
  const deployments = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page += 1) {
    const envelope = await fetchCloudflareJson(
      fetchImpl,
      `${pagesDeploymentsApi(targets)}?env=production&page=${page}` +
        `&per_page=${DEPLOYMENTS_PER_PAGE}`,
      token,
    );
    if (envelope?.success !== true || !Array.isArray(envelope.result)) {
      throw new Error("Cloudflare Pages deployment list schema is invalid.");
    }
    const totalPages = envelope.result_info?.total_pages;
    if (
      totalPages !== undefined &&
      (!Number.isSafeInteger(totalPages) ||
        totalPages < 1 ||
        totalPages > MAX_DEPLOYMENT_PAGES)
    ) {
      throw new Error("Cloudflare Pages deployment pagination is invalid or excessive.");
    }
    for (const deployment of envelope.result) {
      if (
        !UUID_PATTERN.test(deployment?.id ?? "") ||
        deployment.project_name !== targets.pagesProject ||
        deployment.environment !== "production"
      ) {
        throw new Error("Cloudflare Pages deployment inventory is invalid.");
      }
      const id = deployment.id.toLowerCase();
      if (seen.has(id)) {
        throw new Error("Cloudflare Pages deployment inventory contains duplicate IDs.");
      }
      seen.add(id);
      deployments.push(deployment);
    }
    if (
      (totalPages !== undefined && page >= totalPages) ||
      (totalPages === undefined && envelope.result.length < DEPLOYMENTS_PER_PAGE)
    ) {
      return deployments;
    }
  }
  throw new Error("Cloudflare Pages deployment inventory exceeds the page limit.");
}

async function deploymentDetail({ fetchImpl, token, targets, deploymentId }) {
  const envelope = await fetchCloudflareJson(
    fetchImpl,
    `${pagesDeploymentsApi(targets)}/${encodeURIComponent(deploymentId)}`,
    token,
  );
  if (
    envelope?.success !== true ||
    !envelope.result ||
    typeof envelope.result !== "object" ||
    Array.isArray(envelope.result)
  ) {
    throw new Error("Cloudflare Pages deployment detail schema is invalid.");
  }
  return envelope.result;
}

async function canonicalProductionDeploymentId({ fetchImpl, token, targets }) {
  const envelope = await fetchCloudflareJson(
    fetchImpl,
    pagesProjectApi(targets),
    token,
  );
  const project = envelope?.result;
  if (
    envelope?.success !== true ||
    !project ||
    typeof project !== "object" ||
    Array.isArray(project) ||
    project.name !== targets.pagesProject ||
    project.production_branch !== targets.productionBranch ||
    !UUID_PATTERN.test(project.canonical_deployment?.id ?? "")
  ) {
    throw new Error("Cloudflare Pages canonical project deployment is invalid.");
  }
  return project.canonical_deployment.id.toLowerCase();
}

function isExpectedDeploymentMetadata(deployment, { targets, manifest }) {
  const metadata = deployment?.deployment_trigger?.metadata;
  return (
    deployment?.project_name === targets.pagesProject &&
    deployment?.environment === "production" &&
    deployment?.production_branch === targets.productionBranch &&
    metadata?.branch === targets.productionBranch &&
    metadata?.commit_hash === manifest.sourceCommit &&
    metadata?.commit_message === manifest.deploymentMessage &&
    metadata?.commit_dirty === false
  );
}

function validDeploymentUrl(value, targets, deploymentId) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.port === "" &&
      typeof deploymentId === "string" &&
      url.hostname ===
        `${deploymentId.slice(0, 8).toLowerCase()}.${targets.pagesProject}.pages.dev` &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function validCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3})(\d{0,6})Z$/,
  );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === `${match[1]}.${match[2]}Z`;
}

export function validateLivePagesDeployment(
  deployment,
  { targets, manifest, expectedDeploymentId } = {},
) {
  const errors = [];
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    return ["Cloudflare did not return a Pages deployment object."];
  }
  if (!UUID_PATTERN.test(deployment.id ?? "")) {
    errors.push("Pages deployment ID is invalid.");
  }
  if (
    expectedDeploymentId !== undefined &&
    deployment.id?.toLowerCase() !== expectedDeploymentId.toLowerCase()
  ) {
    errors.push("Pages deployment ID does not match the new deployment.");
  }
  if (!isExpectedDeploymentMetadata(deployment, { targets, manifest })) {
    errors.push("Pages deployment metadata does not bind the reviewed artifact.");
  }
  if (
    deployment.latest_stage?.name !== "deploy" ||
    deployment.latest_stage?.status !== "success" ||
    deployment.is_skipped !== false
  ) {
    errors.push("Pages deployment is not successfully deployed.");
  }
  if (!validDeploymentUrl(deployment.url, targets, deployment.id)) {
    errors.push("Pages deployment URL is invalid.");
  }
  if (deployment.d1_databases?.[targets.d1Binding]?.id !== targets.d1DatabaseId) {
    errors.push("Pages deployment does not bind the pinned D1 database.");
  }
  if (
    deployment.analytics_engine_datasets?.[targets.authObservabilityBinding]
      ?.dataset !== targets.authObservabilityDataset
  ) {
    errors.push("Pages deployment does not bind the pinned Analytics Engine dataset.");
  }
  if (!validCanonicalTimestamp(deployment.created_on)) {
    errors.push("Pages deployment creation time is invalid.");
  }
  return errors;
}

export function validatePreviousPagesDeployment(
  deployment,
  { targets, expectedDeploymentId, expectedManifest } = {},
) {
  const errors = [];
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    return ["Cloudflare did not return the previous Pages deployment."];
  }
  if (
    !UUID_PATTERN.test(deployment.id ?? "") ||
    deployment.id.toLowerCase() !== expectedDeploymentId?.toLowerCase()
  ) {
    errors.push("Previous Pages deployment ID is invalid.");
  }
  if (
    deployment.project_name !== targets.pagesProject ||
    deployment.environment !== "production" ||
    deployment.production_branch !== targets.productionBranch ||
    deployment.latest_stage?.name !== "deploy" ||
    deployment.latest_stage?.status !== "success" ||
    deployment.is_skipped !== false
  ) {
    errors.push("Previous Pages deployment is not a successful production deployment.");
  }
  if (!validDeploymentUrl(deployment.url, targets, deployment.id)) {
    errors.push("Previous Pages deployment URL is invalid.");
  }
  if (deployment.d1_databases?.[targets.d1Binding]?.id !== targets.d1DatabaseId) {
    errors.push("Previous Pages deployment does not bind the pinned D1 database.");
  }
  if (
    deployment.analytics_engine_datasets?.[targets.authObservabilityBinding]
      ?.dataset !== targets.authObservabilityDataset
  ) {
    errors.push("Previous Pages deployment lacks the pinned Analytics Engine dataset.");
  }
  if (!validCanonicalTimestamp(deployment.created_on)) {
    errors.push("Previous Pages deployment creation time is invalid.");
  }
  const metadata = deployment.deployment_trigger?.metadata;
  const messageMatch =
    typeof metadata?.commit_message === "string"
      ? RELEASE_MESSAGE_PATTERN.exec(metadata.commit_message)
      : null;
  const safeLegacyMessage =
    typeof metadata?.commit_message === "string" &&
    metadata.commit_message.length >= 1 &&
    metadata.commit_message.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(metadata.commit_message);
  if (
    metadata?.branch !== targets.productionBranch ||
    !COMMIT_PATTERN.test(metadata?.commit_hash ?? "") ||
    metadata?.commit_dirty !== false ||
    !safeLegacyMessage ||
    (messageMatch && messageMatch[1] !== metadata.commit_hash)
  ) {
    errors.push("Previous Pages deployment provenance metadata is invalid.");
  }
  if (
    expectedManifest &&
    (metadata?.commit_hash !== expectedManifest.sourceCommit ||
      metadata?.commit_message !== expectedManifest.deploymentMessage)
  ) {
    errors.push("Previous Pages deployment does not match the reviewed rollback artifact.");
  }
  return errors;
}

function authenticationProbeContract(targets, mode) {
  const disabledFlags = Object.fromEntries(
    AUTH_FLAG_NAMES.map((name) => [
      name,
      targets.rollbackPolicy.requiredDisabledAuthenticationFlags[name] === "true",
    ]),
  );
  if (mode === "disabled") {
    return {
      methods: { passkey: false, line: false, google: false, email: false },
      flags: disabledFlags,
    };
  }
  if (mode !== "normal") {
    throw new Error("Authentication probe mode is invalid.");
  }
  return {
    methods: { passkey: false, line: true, google: false, email: false },
    flags: {
      ...disabledFlags,
      OIDC_AUTH_ENABLED: true,
      LINE_LOGIN_ENABLED: true,
    },
  };
}

export function isPinnedLegacyPreviousProduction(
  deployment,
  { targets, releaseMode },
) {
  const legacy = targets?.rollbackPolicy?.legacyPreviousProduction;
  return (
    ["disabled_rollback_provisioning", "production"].includes(releaseMode) &&
    legacy?.methodsSchema === "line_only_without_authentication_flags" &&
    UUID_PATTERN.test(legacy?.deploymentId ?? "") &&
    COMMIT_PATTERN.test(legacy?.sourceCommit ?? "") &&
    deployment?.id?.toLowerCase() === legacy.deploymentId.toLowerCase() &&
    deployment?.deployment_trigger?.metadata?.commit_hash ===
      legacy.sourceCommit &&
    deployment?.deployment_trigger?.metadata?.commit_message ===
      legacy.commitMessage &&
    deployment?.created_on === legacy.createdOn
  );
}

export function validateDeploymentProbePayloads(
  health,
  methods,
  {
    targets,
    mode,
    checkedAt = new Date(),
    allowLegacyMethodsWithoutAuthenticationFlags = false,
  },
) {
  const errors = [];
  const checkedTime = new Date(checkedAt).getTime();
  const healthTime = Date.parse(health?.timestamp ?? "");
  if (
    !exactKeys(health, ["status", "requestId", "timestamp"]) ||
    health.status !== "ready" ||
    typeof health.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(health.requestId) ||
    !Number.isFinite(healthTime) ||
    new Date(health.timestamp).toISOString() !== health.timestamp ||
    Math.abs(checkedTime - healthTime) > 10 * 60 * 1000
  ) {
    errors.push("Deployment health payload is not exact and current.");
  }
  const expected = authenticationProbeContract(targets, mode);
  const expectedAccountMethods = {
    passkey: false,
    line: false,
    google: false,
    email: false,
  };
  const legacyMethodsShape =
    allowLegacyMethodsWithoutAuthenticationFlags === true &&
    mode === "normal" &&
    methods &&
    typeof methods === "object" &&
    !Array.isArray(methods) &&
    !Object.hasOwn(methods, "authenticationFlags");
  const expectedMethodKeys = [
    "authenticated",
    "recentlyAuthenticated",
    "accountMethods",
    "passkey",
    "line",
    "google",
    "email",
    ...(legacyMethodsShape ? [] : ["authenticationFlags"]),
  ];
  if (
    !exactKeys(methods, expectedMethodKeys) ||
    methods.authenticated !== false ||
    methods.recentlyAuthenticated !== false ||
    !exactKeys(methods.accountMethods, Object.keys(expectedAccountMethods)) ||
    Object.keys(expectedAccountMethods).some(
      (name) => methods.accountMethods[name] !== expectedAccountMethods[name],
    ) ||
    Object.keys(expected.methods).some(
      (name) => methods[name] !== expected.methods[name],
    ) ||
    (!legacyMethodsShape &&
      (!exactKeys(methods.authenticationFlags, AUTH_FLAG_NAMES) ||
        AUTH_FLAG_NAMES.some(
          (name) => methods.authenticationFlags[name] !== expected.flags[name],
        )))
  ) {
    errors.push("Deployment authentication methods and raw flags do not match mode.");
  }
  return errors;
}

async function probeDeployment({
  deployment,
  mode,
  fetchImpl,
  targets,
  now,
  allowLegacyMethodsWithoutAuthenticationFlags = false,
}) {
  const origin = new URL(deployment.url).origin;
  const probe = async (path) => {
    const result = await fetchBoundedJson({
      fetchImpl,
      url: `${origin}${path}`,
      headers: { Accept: "application/json" },
      maxBytes: MAX_PROBE_JSON_BYTES,
      timeoutMs: 10_000,
    });
    const cacheControl = result.response.headers.get("cache-control") ?? "";
    if (!/(?:^|,)\s*(?:private,\s*)?no-store(?:\s*,|$)/i.test(cacheControl)) {
      throw new Error("Deployment probe response is not marked no-store.");
    }
    return result.value;
  };
  const health = await probe("/api/health");
  const methods = await probe("/api/account/auth/methods");
  const errors = validateDeploymentProbePayloads(health, methods, {
    targets,
    mode,
    checkedAt: now(),
    allowLegacyMethodsWithoutAuthenticationFlags,
  });
  if (errors.length > 0) {
    throw new Error(errors.join(" "));
  }
  const checkedAt = new Date(now()).toISOString();
  return { health, methods, checkedAt };
}

export function validateAnalyticsEngineTables(payload, dataset) {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.data) ||
    typeof dataset !== "string" ||
    !/^[A-Za-z0-9_]{1,64}$/.test(dataset) ||
    payload.data.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        typeof row.name !== "string",
    )
  ) {
    throw new Error("Analytics Engine SHOW TABLES response is malformed.");
  }
  if (payload.data.filter((row) => row.name === dataset).length !== 1) {
    throw new Error("Analytics Engine dataset is not uniquely queryable.");
  }
  return true;
}

async function verifyAnalyticsEngineDataset({ fetchImpl, token, targets, now }) {
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
    "/analytics_engine/sql";
  const result = await fetchBoundedJson({
    fetchImpl,
    url: endpoint,
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain; charset=utf-8",
    },
    body: "SHOW TABLES FORMAT JSON",
    maxBytes: MAX_API_JSON_BYTES,
    timeoutMs: 15_000,
  });
  validateAnalyticsEngineTables(result.value, targets.authObservabilityDataset);
  return { checkedAt: new Date(now()).toISOString() };
}

async function capturePreviousProduction({
  fetchImpl,
  token,
  targets,
  now,
  releaseMode,
}) {
  const inventory = await listAllProductionDeployments({
    fetchImpl,
    token,
    targets,
  });
  const canonicalId = await canonicalProductionDeploymentId({
    fetchImpl,
    token,
    targets,
  });
  if (!inventory.some((deployment) => deployment.id.toLowerCase() === canonicalId)) {
    throw new Error("Canonical production deployment is absent from full history.");
  }
  const detail = await deploymentDetail({
    fetchImpl,
    token,
    targets,
    deploymentId: canonicalId,
  });
  const errors = validatePreviousPagesDeployment(detail, {
    targets,
    expectedDeploymentId: canonicalId,
  });
  if (errors.length > 0) throw new Error(errors.join(" "));
  const allowLegacyMethodsWithoutAuthenticationFlags =
    isPinnedLegacyPreviousProduction(detail, { targets, releaseMode });
  await probeDeployment({
    deployment: detail,
    mode: "normal",
    fetchImpl,
    targets,
    now,
    allowLegacyMethodsWithoutAuthenticationFlags,
  });
  return {
    inventoryIds: new Set(
      inventory.map((deployment) => deployment.id.toLowerCase()),
    ),
    deployment: detail,
    mode: "normal",
    releaseMode,
    allowLegacyMethodsWithoutAuthenticationFlags,
  };
}

async function assertPreviousProductionUnchanged({
  fetchImpl,
  token,
  targets,
  previous,
}) {
  const inventory = await listAllProductionDeployments({
    fetchImpl,
    token,
    targets,
  });
  const currentIds = new Set(
    inventory.map((deployment) => deployment.id.toLowerCase()),
  );
  const inventoryIsExact =
    currentIds.size === previous.inventoryIds.size &&
    [...previous.inventoryIds].every((id) => currentIds.has(id));
  const canonicalId = await canonicalProductionDeploymentId({
    fetchImpl,
    token,
    targets,
  });
  if (
    !inventoryIsExact ||
    canonicalId !== previous.deployment.id.toLowerCase()
  ) {
    throw new Error(
      "Production deployment history or canonical deployment changed immediately before upload.",
    );
  }
}

async function verifyNewDeployment({
  beforeIds,
  fetchImpl,
  token,
  targets,
  manifest,
  sleep,
  mode,
  now,
  onOwnedCandidate,
}) {
  let lastErrors = ["New Pages deployment was not visible."];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const listed = await listAllProductionDeployments({ fetchImpl, token, targets });
    const afterIds = new Set(
      listed.map((deployment) => deployment.id.toLowerCase()),
    );
    if ([...beforeIds].some((id) => !afterIds.has(id))) {
      throw new Error("Production deployment history lost a pre-release deployment.");
    }
    const newIds = [...afterIds].filter((id) => !beforeIds.has(id));
    if (newIds.length > 1) {
      throw new Error("A foreign concurrent production deployment was detected.");
    }
    const candidate =
      newIds.length === 1
        ? listed.find((deployment) => deployment.id.toLowerCase() === newIds[0])
        : null;
    if (candidate) {
      const canonicalId = await canonicalProductionDeploymentId({
        fetchImpl,
        token,
        targets,
      });
      if (canonicalId !== candidate.id.toLowerCase()) {
        if (!beforeIds.has(canonicalId)) {
          throw new Error("A concurrent Pages deployment became canonical.");
        }
        lastErrors = ["Reviewed deployment is not canonical yet."];
        if (attempt < 9) await sleep(2_000);
        continue;
      }
      const detail = await deploymentDetail({
        fetchImpl,
        token,
        targets,
        deploymentId: candidate.id,
      });
      const listedErrors = validateLivePagesDeployment(candidate, {
        targets,
        manifest,
        expectedDeploymentId: candidate.id,
      });
      const detailErrors = validateLivePagesDeployment(detail, {
        targets,
        manifest,
        expectedDeploymentId: candidate.id,
      });
      lastErrors = [...listedErrors, ...detailErrors];
      if (lastErrors.length === 0) {
        onOwnedCandidate?.(detail.id.toLowerCase());
        const probe = await probeDeployment({
          deployment: detail,
          mode,
          fetchImpl,
          targets,
          now,
        });
        const finalInventory = await listAllProductionDeployments({
          fetchImpl,
          token,
          targets,
        });
        const finalIds = new Set(
          finalInventory.map((deployment) => deployment.id.toLowerCase()),
        );
        const finalNewIds = [...finalIds].filter((id) => !beforeIds.has(id));
        const finalCanonicalId = await canonicalProductionDeploymentId({
          fetchImpl,
          token,
          targets,
        });
        if (
          [...beforeIds].some((id) => !finalIds.has(id)) ||
          finalNewIds.length !== 1 ||
          finalNewIds[0] !== candidate.id.toLowerCase() ||
          finalCanonicalId !== candidate.id.toLowerCase()
        ) {
          throw new Error("Production deployment changed during post-deploy probes.");
        }
        return { deployment: detail, probe };
      }
      const terminalFailure = [candidate, detail].some(
        (deployment) =>
          deployment?.latest_stage?.name === "deploy" &&
          ["failure", "failed", "canceled", "cancelled"].includes(
            deployment.latest_stage.status,
          ),
      );
      if (terminalFailure) {
        throw new Error(`Pages deployment failed: ${lastErrors.join(" ")}`);
      }
    }
    if (attempt < 9) await sleep(2_000);
  }
  throw new Error(`Pages deployment verification timed out: ${lastErrors.join(" ")}`);
}

function exactDeploymentIdSet(left, right) {
  return (
    left.size === right.size &&
    [...left].every((deploymentId) => right.has(deploymentId))
  );
}

async function readRollbackControlState({ fetchImpl, token, targets }) {
  const inventory = await listAllProductionDeployments({
    fetchImpl,
    token,
    targets,
  });
  const inventoryIds = new Set(
    inventory.map((deployment) => deployment.id.toLowerCase()),
  );
  const canonicalId = await canonicalProductionDeploymentId({
    fetchImpl,
    token,
    targets,
  });
  if (!inventoryIds.has(canonicalId)) {
    throw new Error("Canonical production is absent from full deployment history.");
  }
  return { inventory, inventoryIds, canonicalId };
}

async function verifyPreviousCanonicalReadback({
  fetchImpl,
  token,
  targets,
  previous,
  expectedInventoryIds,
  sleep,
  now,
}) {
  const previousId = previous.deployment.id.toLowerCase();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const canonicalId = await canonicalProductionDeploymentId({
      fetchImpl,
      token,
      targets,
    });
    if (canonicalId === previousId) {
      const detail = await deploymentDetail({
        fetchImpl,
        token,
        targets,
        deploymentId: canonicalId,
      });
      const errors = validatePreviousPagesDeployment(detail, {
        targets,
        expectedDeploymentId: canonicalId,
        expectedManifest: previous.expectedManifest,
      });
      if (errors.length > 0) throw new Error(errors.join(" "));
      const allowLegacyMethodsWithoutAuthenticationFlags =
        previous.allowLegacyMethodsWithoutAuthenticationFlags === true &&
        isPinnedLegacyPreviousProduction(detail, {
          targets,
          releaseMode: previous.releaseMode,
        });
      if (
        previous.allowLegacyMethodsWithoutAuthenticationFlags === true &&
        !allowLegacyMethodsWithoutAuthenticationFlags
      ) {
        throw new Error(
          "Restored legacy previous Production no longer matches its immutable pin.",
        );
      }
      await probeDeployment({
        deployment: detail,
        mode: previous.mode,
        fetchImpl,
        targets,
        now,
        allowLegacyMethodsWithoutAuthenticationFlags,
      });
      const finalState = await readRollbackControlState({
        fetchImpl,
        token,
        targets,
      });
      if (
        finalState.canonicalId !== previousId ||
        !exactDeploymentIdSet(finalState.inventoryIds, expectedInventoryIds)
      ) {
        throw new Error(
          "Rollback history or canonical deployment changed during recovery readback.",
        );
      }
      return detail;
    }
    if (attempt < 9) await sleep(2_000);
  }
  throw new Error("Previous production deployment did not become canonical after rollback.");
}

async function verifyOwnedReleaseCandidate({
  controlState,
  candidateId,
  fetchImpl,
  token,
  targets,
  manifest,
}) {
  try {
    const listedCandidate = controlState.inventory.find(
      (deployment) => deployment.id.toLowerCase() === candidateId,
    );
    const detail = await deploymentDetail({
      fetchImpl,
      token,
      targets,
      deploymentId: candidateId,
    });
    const ownershipErrors = [
      ...validateLivePagesDeployment(listedCandidate, {
        targets,
        manifest,
        expectedDeploymentId: candidateId,
      }),
      ...validateLivePagesDeployment(detail, {
        targets,
        manifest,
        expectedDeploymentId: candidateId,
      }),
    ];
    if (ownershipErrors.length > 0) {
      throw new Error(ownershipErrors.join(" "));
    }
    return detail;
  } catch (error) {
    throw new Error(
      `Automatic rollback mutation refused because deployment ownership could not be verified: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function rollbackToPrevious({
  fetchImpl,
  token,
  targets,
  previous,
  preservedDeploymentId,
  manifest,
  sleep,
  now,
}) {
  let controlState;
  try {
    controlState = await readRollbackControlState({
      fetchImpl,
      token,
      targets,
    });
  } catch (error) {
    throw new Error(
      `Automatic rollback mutation refused because ownership state could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const previousId = previous.deployment.id.toLowerCase();
  const newIds = [...controlState.inventoryIds].filter(
    (deploymentId) => !previous.inventoryIds.has(deploymentId),
  );
  const historyIsOwned =
    [...previous.inventoryIds].every((deploymentId) =>
      controlState.inventoryIds.has(deploymentId),
    ) &&
    newIds.length <= 1 &&
    (!preservedDeploymentId ||
      (newIds.length === 1 &&
        newIds[0] === preservedDeploymentId.toLowerCase()));
  if (!historyIsOwned) {
    throw new Error(
      "Automatic rollback mutation refused because production history is not uniquely attributable to this release.",
    );
  }
  if (controlState.canonicalId === previousId) {
    if (newIds.length === 1) {
      await verifyOwnedReleaseCandidate({
        controlState,
        candidateId: newIds[0],
        fetchImpl,
        token,
        targets,
        manifest,
      });
    }
    return verifyPreviousCanonicalReadback({
      fetchImpl,
      token,
      targets,
      previous,
      expectedInventoryIds: controlState.inventoryIds,
      sleep,
      now,
    });
  }
  const ownedCandidateId = newIds.length === 1 ? newIds[0] : null;
  if (
    !ownedCandidateId ||
    controlState.canonicalId !== ownedCandidateId ||
    (preservedDeploymentId &&
      ownedCandidateId !== preservedDeploymentId.toLowerCase())
  ) {
    throw new Error(
      "Automatic rollback mutation refused because canonical production is not the unique deployment owned by this release.",
    );
  }
  await verifyOwnedReleaseCandidate({
    controlState,
    candidateId: ownedCandidateId,
    fetchImpl,
    token,
    targets,
    manifest,
  });
  const finalOwnershipState = await readRollbackControlState({
    fetchImpl,
    token,
    targets,
  }).catch((error) => {
    throw new Error(
      `Automatic rollback mutation refused because final ownership state could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  if (
    finalOwnershipState.canonicalId !== ownedCandidateId ||
    !exactDeploymentIdSet(
      finalOwnershipState.inventoryIds,
      controlState.inventoryIds,
    )
  ) {
    throw new Error(
      "Automatic rollback mutation refused because production changed during ownership verification.",
    );
  }
  const envelope = await fetchCloudflareJson(
    fetchImpl,
    `${pagesDeploymentsApi(targets)}/${encodeURIComponent(
      previous.deployment.id,
    )}/rollback`,
    token,
    { method: "POST", body: "{}" },
  );
  if (
    envelope?.success !== true ||
    !envelope.result ||
    typeof envelope.result !== "object" ||
    Array.isArray(envelope.result)
  ) {
    throw new Error("Cloudflare Pages rollback API response is invalid.");
  }
  const rollbackResponseErrors = validatePreviousPagesDeployment(
    envelope.result,
    {
      targets,
      expectedDeploymentId: previous.deployment.id,
      expectedManifest: previous.expectedManifest,
    },
  );
  if (rollbackResponseErrors.length > 0) {
    throw new Error(
      `Cloudflare Pages rollback API returned the wrong deployment: ${rollbackResponseErrors.join(
        " ",
      )}`,
    );
  }
  return verifyPreviousCanonicalReadback({
    fetchImpl,
    token,
    targets,
    previous,
    expectedInventoryIds: finalOwnershipState.inventoryIds,
    sleep,
    now,
  });
}

async function assertSoleCanonicalCandidate({
  beforeIds,
  candidateId,
  fetchImpl,
  token,
  targets,
}) {
  const inventory = await listAllProductionDeployments({
    fetchImpl,
    token,
    targets,
  });
  const ids = new Set(
    inventory.map((deployment) => deployment.id.toLowerCase()),
  );
  const newIds = [...ids].filter((id) => !beforeIds.has(id));
  const canonicalId = await canonicalProductionDeploymentId({
    fetchImpl,
    token,
    targets,
  });
  if (
    [...beforeIds].some((id) => !ids.has(id)) ||
    newIds.length !== 1 ||
    newIds[0] !== candidateId.toLowerCase() ||
    canonicalId !== candidateId.toLowerCase()
  ) {
    throw new Error("Production changed before the release record was finalized.");
  }
}

function deploymentRecordPathFor(manifestPath) {
  const extension = extname(manifestPath);
  const stem = basename(manifestPath, extension);
  return resolve(dirname(manifestPath), `${stem}.deployment.json`);
}

function createDeploymentRecord({
  deployment,
  manifest,
  targets,
  releaseMode,
  verifiedAt,
  probe,
  analyticsEngine,
}) {
  if (releaseMode === "disabled_rollback_provisioning") {
    return {
      schemaVersion: targets.rollbackPolicy.manifestSchemaVersion,
      pagesProject: targets.pagesProject,
      productionBranch: targets.productionBranch,
      sourceCommit: manifest.sourceCommit,
      disabledDeploymentId: deployment.id.toLowerCase(),
      deploymentUrl: new URL(deployment.url).origin,
      deploymentEnvironment: "production",
      deploymentStatus: "success",
      artifact: {
        schemaVersion: targets.pagesArtifact.manifestSchemaVersion,
        root: targets.pagesArtifact.root,
        aggregateSha256: manifest.aggregateSha256,
        fileCount: manifest.fileCount,
        totalBytes: manifest.totalBytes,
        deploymentMessage: manifest.deploymentMessage,
      },
      bindings: {
        [targets.d1Binding]: {
          type: "d1",
          databaseId: targets.d1DatabaseId,
        },
        [targets.authObservabilityBinding]: {
          type: "analytics_engine",
          dataset: targets.authObservabilityDataset,
        },
      },
      authenticationMethods: {
        passkey: probe.methods.passkey,
        line: probe.methods.line,
        google: probe.methods.google,
        email: probe.methods.email,
      },
      authenticationFlags: {
        ...targets.rollbackPolicy.requiredDisabledAuthenticationFlags,
      },
      verification: {
        bindingsFromDeploymentSnapshot: true,
        flagsWereRedeployed: true,
        healthReady: true,
        allPublicAuthenticationMethodsDisabled: true,
        authObservabilityDatasetQueryable: true,
        healthCheckedAt: probe.checkedAt,
        methodsCheckedAt: probe.checkedAt,
        analyticsEngineCheckedAt: analyticsEngine.checkedAt,
        verifiedAt,
      },
    };
  }
  return {
    schemaVersion: PAGES_DEPLOYMENT_RECORD_SCHEMA_VERSION,
    recordType: "torudake-pages-deployment",
    releaseMode,
    pagesProject: targets.pagesProject,
    productionBranch: targets.productionBranch,
    sourceCommit: manifest.sourceCommit,
    artifactSha256: manifest.aggregateSha256,
    deploymentMessage: manifest.deploymentMessage,
    deploymentId: deployment.id.toLowerCase(),
    deploymentUrl: deployment.url,
    deploymentEnvironment: "production",
    deploymentStatus: "success",
    commitDirty: false,
    deployedAt: new Date(deployment.created_on).toISOString(),
    verifiedAt,
  };
}

export function validatePagesDeploymentRecord(
  record,
  { deployment, manifest, targets, releaseMode, probe, analyticsEngine },
) {
  const expected = createDeploymentRecord({
    deployment,
    manifest,
    targets,
    releaseMode,
    verifiedAt:
      releaseMode === "disabled_rollback_provisioning"
        ? record?.verification?.verifiedAt
        : record?.verifiedAt,
    probe,
    analyticsEngine,
  });
  const verificationTimes =
    releaseMode === "disabled_rollback_provisioning"
      ? [
          record?.verification?.healthCheckedAt,
          record?.verification?.methodsCheckedAt,
          record?.verification?.analyticsEngineCheckedAt,
          record?.verification?.verifiedAt,
        ]
      : [record?.verifiedAt];
  if (
    verificationTimes.some(
      (value) =>
        typeof value !== "string" ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value,
    ) ||
    !exactKeys(record, Object.keys(expected)) ||
    !isDeepStrictEqual(record, expected)
  ) {
    throw new Error("Pages deployment record does not match the verified release.");
  }
  return record;
}

async function writeDeploymentRecordExclusive(
  recordPath,
  record,
  {
    externalRoot,
    projectRoot,
    deployment,
    manifest,
    targets,
    releaseMode,
    probe,
    analyticsEngine,
  },
) {
  validatePagesDeploymentRecord(record, {
    deployment,
    manifest,
    targets,
    releaseMode,
    probe,
    analyticsEngine,
  });
  const destination = await assertExternalPagesReleasePath({
    manifestPath: recordPath,
    externalRoot,
    projectRoot,
    mustBeNew: true,
  });
  const payload = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (payload.byteLength > MAX_DEPLOYMENT_RECORD_BYTES) {
    throw new Error("Pages deployment record exceeds its release size limit.");
  }
  const temporaryPath = resolve(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.pending`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, destination);
    const recorded = await readFile(destination);
    if (!recorded.equals(payload)) {
      throw new Error("Pages deployment record failed byte verification.");
    }
    return destination;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function outputJson(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

export async function runPagesReleaseCommand({
  argv,
  env = process.env,
  projectRoot = PROJECT_ROOT,
  spawnCommand = spawnSync,
  fetchImpl = fetch,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  now = () => new Date(),
  output = process.stdout,
  artifactOperations = {},
} = {}) {
  const options = parsePagesReleaseArguments(argv ?? []);
  const targets = await loadPinnedTargets(projectRoot);
  const runGit = createGitRunner(spawnCommand, env);
  const sourceCommit = readCurrentHead(projectRoot, runGit);
  const externalRoot = options.externalRoot ?? dirname(options.manifestPath);
  const operations = {
    assertExternalPath: assertExternalPagesReleasePath,
    createManifest: createPagesArtifactManifest,
    readManifest: readPagesArtifactManifestFile,
    verifyManifest: verifyPagesArtifactManifest,
    verifyArtifactDirectory: verifyPagesArtifactDirectory,
    createSnapshot: createVerifiedPagesArtifactSnapshot,
    createExternalTempDirectory: createExternalReleaseTempDirectory,
    removeExternalTempDirectory: removeExternalReleaseTempDirectory,
    assertWranglerCwd: assertWranglerCwdHasNoConfig,
    writeManifest: writePagesArtifactManifestExclusive,
    writeDeploymentRecord: writeDeploymentRecordExclusive,
    ...artifactOperations,
  };

  if (options.mode === "prepare") {
    await operations.assertExternalPath({
      manifestPath: options.manifestPath,
      externalRoot,
      projectRoot,
      mustBeNew: true,
    });
    if (!options.execute) {
      const result = {
        dryRun: true,
        mode: "prepare",
        sourceCommit,
        manifestPath: options.manifestPath,
        mutationPerformed: false,
      };
      outputJson(output, result);
      return result;
    }
    for (const command of pagesBuildCommands(projectRoot)) {
      spawnResult(spawnCommand, command.executable, command.args, {
        cwd: projectRoot,
        env,
        label: command.label,
      });
    }
    const generatedAt = new Date(now()).toISOString();
    const manifest = await operations.createManifest({
      projectRoot,
      distRoot: resolve(projectRoot, "dist", "cloudflare-pages"),
      sourceCommit,
      generatedAt,
      runGit,
    });
    await operations.writeManifest(options.manifestPath, manifest, {
      externalRoot,
      projectRoot,
    });
    const result = {
      dryRun: false,
      mode: "prepare",
      sourceCommit,
      artifactSha256: manifest.aggregateSha256,
      manifestPath: options.manifestPath,
      mutationPerformed: true,
    };
    outputJson(output, result);
    return result;
  }

  await operations.assertExternalPath({
    manifestPath: options.manifestPath,
    externalRoot,
    projectRoot,
    mustExist: true,
  });
  const manifest = await operations.readManifest(options.manifestPath);
  assertValidPagesArtifactManifest(manifest, {
    expectedSourceCommit: sourceCommit,
  });
  await operations.verifyManifest(manifest, {
    projectRoot,
    distRoot: resolve(projectRoot, "dist", "cloudflare-pages"),
    expectedSourceCommit: sourceCommit,
    runGit,
  });
  const deploymentRecordPath = resolve(
    options.deploymentRecordPath ?? deploymentRecordPathFor(options.manifestPath),
  );
  await operations.assertExternalPath({
    manifestPath: deploymentRecordPath,
    externalRoot,
    projectRoot,
    mustBeNew: true,
  });
  const releaseEnvironment = {
    ...env,
    CLOUDFLARE_ACCOUNT_ID: targets.cloudflareAccountId,
    [targets.pagesArtifact.manifestEnvironmentVariable]: options.manifestPath,
  };
  const preflightArguments = [resolve(projectRoot, "scripts", "release-preflight.mjs")];
  if (options.provisionDisabledRollback) {
    preflightArguments.push(
      "--provision-disabled-rollback",
      "--confirm",
      targets.rollbackPolicy.provisioningConfirmation,
    );
  }
  spawnResult(spawnCommand, process.execPath, preflightArguments, {
    cwd: projectRoot,
    env: releaseEnvironment,
    label: "Pages release preflight",
  });
  if (!options.execute) {
    const result = {
      dryRun: true,
      mode: "deploy",
      releaseMode: options.provisionDisabledRollback
        ? "disabled_rollback_provisioning"
        : "production",
      sourceCommit,
      artifactSha256: manifest.aggregateSha256,
      mutationPerformed: false,
    };
    outputJson(output, result);
    return result;
  }

  const releaseMode = options.provisionDisabledRollback
    ? "disabled_rollback_provisioning"
    : "production";
  const deployedProbeMode =
    releaseMode === "disabled_rollback_provisioning" ? "disabled" : "normal";
  let wranglerCwd = null;
  let snapshotDirectory = null;
  let deployAttempted = false;
  let previous = null;
  let token = null;
  let deployed = null;
  let ownedDeploymentId = null;

  async function cleanupLocalReleaseDirectories() {
    const errors = [];
    if (snapshotDirectory) {
      const path = snapshotDirectory;
      try {
        await operations.removeExternalTempDirectory(path, {
          externalRoot,
          projectRoot,
          prefix: SNAPSHOT_PREFIX,
        });
        snapshotDirectory = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (wranglerCwd) {
      const path = wranglerCwd;
      try {
        await operations.removeExternalTempDirectory(path, {
          externalRoot,
          projectRoot,
          prefix: WRANGLER_CWD_PREFIX,
        });
        wranglerCwd = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `External release temporary cleanup failed: ${errors
          .map((error) => (error instanceof Error ? error.message : String(error)))
          .join(" ")}`,
      );
    }
  }

  try {
    wranglerCwd = await operations.createExternalTempDirectory({
      externalRoot,
      projectRoot,
      prefix: WRANGLER_CWD_PREFIX,
    });
    await operations.assertWranglerCwd(wranglerCwd);
    token = cloudflareApiToken({
      spawnCommand,
      projectRoot,
      wranglerCwd,
      env: releaseEnvironment,
      targets,
    });
    snapshotDirectory = await operations.createSnapshot(manifest, {
      projectRoot,
      externalRoot,
      sourceCommit,
      runGit,
      prefix: SNAPSHOT_PREFIX,
    });
    await operations.verifyArtifactDirectory(manifest, {
      directory: snapshotDirectory,
      expectedSourceCommit: sourceCommit,
    });
    previous = await capturePreviousProduction({
      fetchImpl,
      token,
      targets,
      now,
      releaseMode,
    });
    await operations.verifyArtifactDirectory(manifest, {
      directory: snapshotDirectory,
      expectedSourceCommit: sourceCommit,
    });
    await operations.assertWranglerCwd(wranglerCwd);
    await assertPreviousProductionUnchanged({
      fetchImpl,
      token,
      targets,
      previous,
    });
    deployAttempted = true;
    spawnResult(
      spawnCommand,
      process.execPath,
      pagesDeployArguments({
        projectRoot,
        targets,
        manifest,
        artifactDirectory: snapshotDirectory,
      }),
      {
        cwd: wranglerCwd,
        env: releaseEnvironment,
        label: "Cloudflare Pages deployment",
      },
    );
    await cleanupLocalReleaseDirectories();
    deployed = await verifyNewDeployment({
      beforeIds: previous.inventoryIds,
      fetchImpl,
      token,
      targets,
      manifest,
      sleep,
      mode: deployedProbeMode,
      now,
      onOwnedCandidate: (deploymentId) => {
        ownedDeploymentId = deploymentId;
      },
    });
    const analyticsEngine = await verifyAnalyticsEngineDataset({
      fetchImpl,
      token,
      targets,
      now,
    });
    await assertSoleCanonicalCandidate({
      beforeIds: previous.inventoryIds,
      candidateId: deployed.deployment.id,
      fetchImpl,
      token,
      targets,
    });
    const verifiedAt = new Date(now()).toISOString();
    const record = createDeploymentRecord({
      deployment: deployed.deployment,
      manifest,
      targets,
      releaseMode,
      verifiedAt,
      probe: deployed.probe,
      analyticsEngine,
    });
    await operations.writeDeploymentRecord(deploymentRecordPath, record, {
      externalRoot,
      projectRoot,
      deployment: deployed.deployment,
      manifest,
      targets,
      releaseMode,
      probe: deployed.probe,
      analyticsEngine,
    });
    await assertSoleCanonicalCandidate({
      beforeIds: previous.inventoryIds,
      candidateId: deployed.deployment.id,
      fetchImpl,
      token,
      targets,
    });
    let restoredDeployment = null;
    if (releaseMode === "disabled_rollback_provisioning") {
      restoredDeployment = await rollbackToPrevious({
        fetchImpl,
        token,
        targets,
        previous,
        preservedDeploymentId: deployed.deployment.id,
        manifest,
        sleep,
        now,
      });
    }
    const result = {
      dryRun: false,
      mode: "deploy",
      releaseMode,
      sourceCommit,
      artifactSha256: manifest.aggregateSha256,
      deploymentId: deployed.deployment.id.toLowerCase(),
      deploymentUrl: deployed.deployment.url,
      deploymentRecordPath,
      restoredDeploymentId:
        restoredDeployment?.id?.toLowerCase() ?? null,
      mutationPerformed: true,
    };
    outputJson(output, result);
    return result;
  } catch (error) {
    let releaseError = error instanceof Error ? error : new Error(String(error));
    try {
      await cleanupLocalReleaseDirectories();
    } catch (cleanupError) {
      releaseError = new Error(
        `${releaseError.message} ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
    if (!deployAttempted || !previous || !token) {
      throw releaseError;
    }
    try {
      await rollbackToPrevious({
        fetchImpl,
        token,
        targets,
        previous,
        preservedDeploymentId:
          deployed?.deployment?.id ?? ownedDeploymentId ?? undefined,
        manifest,
        sleep,
        now,
      });
    } catch (rollbackError) {
      throw new Error(
        `Pages release failed after deployment attempt: ${releaseError.message} ` +
          `Automatic rollback also failed: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
      );
    }
    throw new Error(
      `Pages release failed after deployment attempt; previous production was restored: ${releaseError.message}`,
    );
  }
}

async function main() {
  try {
    await runPagesReleaseCommand({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(
      `[BLOCKED] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === SCRIPT_PATH.toLowerCase()
) {
  await main();
}
