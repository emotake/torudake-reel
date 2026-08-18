import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { readBoundedJsonResponse } from "../lib/bounded-json-response.mjs";
import { readBoundedJsonFileSync } from "../lib/bounded-json-file.mjs";
import {
  PAGES_ARTIFACT_ROOT,
  PAGES_ARTIFACT_SCHEMA_VERSION,
  readPagesArtifactManifestFileSync,
  validatePagesArtifactManifest,
  verifyPagesArtifactManifest,
} from "../lib/pages-release-artifact.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_CLOUDFLARE_API_BYTES = 2 * 1024 * 1024;
const MAX_READINESS_BYTES = 32 * 1024;
const MAX_ANALYTICS_ENGINE_BYTES = 64 * 1024;
const MAX_SCHEDULER_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCHEDULER_DRY_RUN_BYTES = 20 * 1024 * 1024;
const MAX_SCHEDULER_MULTIPART_HEADER_BYTES = 8 * 1024;
const MAX_SCHEDULER_METADATA_BYTES = 512 * 1024;
const SCHEDULER_MODULE_NAME = "account-deletion-scheduler.js";
const WRANGLER_BIN = resolve(
  PROJECT_ROOT,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
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

export function parseSchedulerReleaseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== "string")) {
    throw new TypeError("Scheduler release arguments must be strings.");
  }
  if (argv[0] === "--") {
    argv = argv.slice(1);
  }
  if (argv.includes("--")) {
    throw new Error("The package-manager separator is valid only once at the start.");
  }
  const valueFlags = new Set(["--confirm", "--manifest"]);
  const booleanFlags = new Set([
    "--execute",
    "--bootstrap-previous-provenance",
  ]);
  const values = new Map();
  const booleans = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueFlags.has(argument)) {
      if (values.has(argument)) {
        throw new Error(`${argument} may only be specified once.`);
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      values.set(argument, value);
      index += 1;
      continue;
    }
    if (booleanFlags.has(argument)) {
      if (booleans.has(argument)) {
        throw new Error(`${argument} may only be specified once.`);
      }
      booleans.add(argument);
      continue;
    }
    throw new Error(`Unsupported scheduler release argument: ${argument}`);
  }

  const execute = booleans.has("--execute");
  const confirmation = values.get("--confirm");
  const manifestPath = values.get("--manifest");
  if (!execute && (confirmation !== undefined || manifestPath !== undefined)) {
    throw new Error("--confirm and --manifest are valid only with --execute.");
  }
  if (execute && (!confirmation || !manifestPath)) {
    throw new Error("--execute requires both --confirm and --manifest.");
  }
  return {
    execute,
    bootstrapPreviousProvenance: booleans.has(
      "--bootstrap-previous-provenance",
    ),
    confirmation,
    manifestPath,
  };
}

export function schedulerReleaseMessage(sourceCommit, bundleSha256, targets) {
  const prefix = targets?.accountDeletionScheduler?.releaseMessagePrefix;
  if (
    typeof prefix !== "string" ||
    !/^[a-z0-9-]{1,64}$/.test(prefix) ||
    !COMMIT_PATTERN.test(sourceCommit ?? "") ||
    !SHA256_PATTERN.test(bundleSha256 ?? "")
  ) {
    throw new Error("Scheduler release annotation inputs are invalid.");
  }
  return `${prefix} commit=${sourceCommit.toLowerCase()} bundleSha256=${bundleSha256.toLowerCase()}`;
}

export function validateLiveSchedulerSchedule(
  liveSchedule,
  { targets, manifestSchedule } = {},
) {
  const errors = [];
  const expectedCron = targets?.accountDeletionScheduler?.cronSchedule;
  if (
    typeof expectedCron !== "string" ||
    !Array.isArray(liveSchedule?.crons) ||
    liveSchedule.crons.length !== 1 ||
    liveSchedule.crons[0] !== expectedCron
  ) {
    errors.push(
      "Live account-deletion Worker Cron does not exactly match the release contract.",
    );
  }
  if (
    manifestSchedule !== undefined &&
    !isDeepStrictEqual(manifestSchedule, {
      cron: expectedCron,
      liveVerified: true,
    })
  ) {
    errors.push(
      "Account-deletion Worker manifest does not record the verified Cron schedule.",
    );
  }
  return errors;
}

export function parseLiveSchedulerScheduleEnvelope(envelope) {
  const result = envelope?.result;
  const schedules = result?.schedules;
  if (
    envelope?.success !== true ||
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(schedules) ||
    schedules.some(
      (schedule) =>
        !schedule ||
        typeof schedule !== "object" ||
        Array.isArray(schedule) ||
        typeof schedule.cron !== "string",
    )
  ) {
    throw new Error("Cloudflare Worker Cron response schema is invalid.");
  }
  return { crons: schedules.map((schedule) => schedule.cron) };
}

export function validateSchedulerManifest(
  manifest,
  { targets, sourceCommit, schedulerArtifact },
) {
  const errors = [];
  const scheduler = targets?.accountDeletionScheduler;
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !scheduler
  ) {
    return {
      valid: false,
      errors: ["Account-deletion Worker manifest must be an object."],
    };
  }
  const deployedAt = manifest.deployedAt;
  if (typeof deployedAt !== "string" || !Number.isFinite(Date.parse(deployedAt))) {
    errors.push("Account-deletion Worker deployment time is invalid.");
  }
  for (const [label, value] of [
    ["deployment", manifest.activeDeploymentId],
    ["active version", manifest.activeVersionId],
    ["previous version", manifest.previousVersionId],
  ]) {
    if (!UUID_PATTERN.test(value ?? "")) {
      errors.push(`Account-deletion Worker ${label} ID is invalid.`);
    }
  }
  if (manifest.activeVersionId === manifest.previousVersionId) {
    errors.push("Account-deletion Worker rollback version must be distinct.");
  }
  if (manifest.activeDeploymentId === manifest.approvedPrevious?.deploymentId) {
    errors.push("Account-deletion Worker rollback deployment must be distinct.");
  }
  if (!SHA256_PATTERN.test(manifest.scriptEtag ?? "")) {
    errors.push("Account-deletion Worker script ETag is invalid.");
  }
  if (
    typeof manifest.uploadTag !== "string" ||
    !/^torudake-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{8}$/.test(
      manifest.uploadTag,
    )
  ) {
    errors.push("Account-deletion Worker upload tag is invalid.");
  }
  errors.push(
    ...validateLiveSchedulerSchedule(
      { crons: [manifest.schedule?.cron] },
      { targets, manifestSchedule: manifest.schedule },
    ),
  );

  const approvedPrevious = manifest.approvedPrevious;
  if (
    !approvedPrevious ||
    typeof approvedPrevious !== "object" ||
    Array.isArray(approvedPrevious)
  ) {
    errors.push("Account-deletion Worker approved previous release is missing.");
  } else {
    if (
      !UUID_PATTERN.test(approvedPrevious.deploymentId ?? "") ||
      !UUID_PATTERN.test(approvedPrevious.versionId ?? "") ||
      approvedPrevious.versionId !== manifest.previousVersionId ||
      !SHA256_PATTERN.test(approvedPrevious.scriptEtag ?? "") ||
      typeof approvedPrevious.deployedAt !== "string" ||
      !Number.isFinite(Date.parse(approvedPrevious.deployedAt))
    ) {
      errors.push("Account-deletion Worker approved previous identity is invalid.");
    }
    errors.push(
      ...validateLiveSchedulerSchedule(
        { crons: [approvedPrevious.schedule?.cron] },
        { targets, manifestSchedule: approvedPrevious.schedule },
      ),
    );
    if (approvedPrevious.provenance === "external_manifest") {
      if (
        approvedPrevious.manifestSchemaVersion !== scheduler.manifestSchemaVersion ||
        !SHA256_PATTERN.test(approvedPrevious.manifestSha256 ?? "") ||
        !COMMIT_PATTERN.test(approvedPrevious.sourceCommit ?? "") ||
        !SHA256_PATTERN.test(approvedPrevious.bundleSha256 ?? "") ||
        typeof approvedPrevious.deploymentMessage !== "string" ||
        approvedPrevious.deploymentMessage !==
          schedulerReleaseMessage(
            approvedPrevious.sourceCommit,
            approvedPrevious.bundleSha256,
            targets,
          ) ||
        typeof approvedPrevious.uploadTag !== "string" ||
        !/^torudake-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{8}$/.test(
          approvedPrevious.uploadTag,
        )
      ) {
        errors.push(
          "Account-deletion Worker previous release lacks approved manifest provenance.",
        );
      }
    } else if (approvedPrevious.provenance === "bootstrap_confirmation") {
      if (
        approvedPrevious.manifestSchemaVersion !== null ||
        approvedPrevious.manifestSha256 !== null ||
        approvedPrevious.sourceCommit !== null ||
        approvedPrevious.bundleSha256 !== null ||
        approvedPrevious.deploymentMessage !== null ||
        approvedPrevious.uploadTag !== null
      ) {
        errors.push(
          "Account-deletion Worker bootstrap provenance must not claim manifest evidence.",
        );
      }
    } else {
      errors.push("Account-deletion Worker previous provenance is invalid.");
    }
  }
  const expected = {
    schemaVersion: scheduler.manifestSchemaVersion,
    workerName: scheduler.workerName,
    sourceCommit:
      typeof sourceCommit === "string" ? sourceCommit.toLowerCase() : "",
    bundleSha256: schedulerArtifact.bundleSha256,
    deploymentMessage: schedulerArtifact.message,
    uploadTag: manifest.uploadTag,
    activeDeploymentId: manifest.activeDeploymentId,
    activeVersionId: manifest.activeVersionId,
    previousVersionId: manifest.previousVersionId,
    scriptEtag: manifest.scriptEtag,
    deployedAt,
    schedule: {
      cron: scheduler.cronSchedule,
      liveVerified: true,
    },
    approvedPrevious: approvedPrevious
      ? {
          provenance: approvedPrevious.provenance,
          manifestSchemaVersion: approvedPrevious.manifestSchemaVersion,
          manifestSha256: approvedPrevious.manifestSha256,
          deploymentId: approvedPrevious.deploymentId,
          versionId: approvedPrevious.versionId,
          scriptEtag: approvedPrevious.scriptEtag,
          sourceCommit: approvedPrevious.sourceCommit,
          bundleSha256: approvedPrevious.bundleSha256,
          deploymentMessage: approvedPrevious.deploymentMessage,
          uploadTag: approvedPrevious.uploadTag,
          deployedAt: approvedPrevious.deployedAt,
          schedule: {
            cron: scheduler.cronSchedule,
            liveVerified: true,
          },
        }
      : undefined,
    verification: {
      wranglerDryRunPassed: true,
      activeTrafficPercentage: 100,
      liveVersionReadBack: true,
    },
  };
  checkExactObject(
    manifest,
    expected,
    "Account-deletion Worker manifest",
    errors,
  );
  return { valid: errors.length === 0, errors };
}

export function validateStoredSchedulerManifest(manifest, { targets }) {
  if (
    !COMMIT_PATTERN.test(manifest?.sourceCommit ?? "") ||
    !SHA256_PATTERN.test(manifest?.bundleSha256 ?? "")
  ) {
    return {
      valid: false,
      errors: ["Stored account-deletion Worker manifest identity is invalid."],
    };
  }
  let message;
  try {
    message = schedulerReleaseMessage(
      manifest.sourceCommit,
      manifest.bundleSha256,
      targets,
    );
  } catch {
    return {
      valid: false,
      errors: ["Stored account-deletion Worker manifest identity is invalid."],
    };
  }
  return validateSchedulerManifest(manifest, {
    targets,
    sourceCommit: manifest.sourceCommit,
    schedulerArtifact: {
      bundleSha256: manifest.bundleSha256,
      message,
    },
  });
}

export function validateRollbackManifest(
  manifest,
  { targets, sourceCommit, pagesArtifactManifest },
) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { valid: false, errors: ["Rollback manifest must be an object."] };
  }
  const policy = targets?.rollbackPolicy;
  if (!policy || typeof policy !== "object") {
    return {
      valid: false,
      errors: ["Release targets do not define the rollback policy."],
    };
  }
  const deploymentId = manifest.disabledDeploymentId;
  if (
    typeof deploymentId !== "string" ||
    !UUID_PATTERN.test(deploymentId)
  ) {
    errors.push("Rollback manifest deployment ID is invalid.");
  }
  if (
    typeof deploymentId === "string" &&
    typeof policy.telemetryDegradedEmergencyDeployment?.deploymentId ===
      "string" &&
    deploymentId.toLowerCase() ===
      policy.telemetryDegradedEmergencyDeployment.deploymentId.toLowerCase()
  ) {
    errors.push(
      "The telemetry-degraded emergency deployment cannot be a standard rollback target.",
    );
  }
  if (!COMMIT_PATTERN.test(sourceCommit ?? "")) {
    errors.push("The reviewed source commit is unavailable.");
  }
  const artifactValidation = validatePagesArtifactManifest(
    pagesArtifactManifest,
    { expectedSourceCommit: sourceCommit },
  );
  errors.push(...artifactValidation.errors);
  if (
    pagesArtifactManifest?.schemaVersion !==
      targets.pagesArtifact?.manifestSchemaVersion ||
    pagesArtifactManifest?.artifactRoot !== targets.pagesArtifact?.root
  ) {
    errors.push("Rollback Pages artifact does not match the pinned target.");
  }
  const verifiedAt = manifest.verification?.verifiedAt;
  if (
    typeof verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(verifiedAt))
  ) {
    errors.push("Rollback manifest verification time is invalid.");
  }
  const verificationTimes = [
    manifest.verification?.healthCheckedAt,
    manifest.verification?.methodsCheckedAt,
    manifest.verification?.analyticsEngineCheckedAt,
  ];
  if (
    verificationTimes.some(
      (value) =>
        typeof value !== "string" ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString() !== value,
    )
  ) {
    errors.push("Rollback manifest probe verification times are invalid.");
  }

  const expected = {
    schemaVersion: policy.manifestSchemaVersion,
    pagesProject: targets.pagesProject,
    productionBranch: targets.productionBranch,
    sourceCommit,
    disabledDeploymentId: deploymentId,
    deploymentUrl:
      typeof deploymentId === "string"
        ? `https://${deploymentId.slice(0, 8)}.${targets.pagesProject}.pages.dev`
        : "",
    deploymentEnvironment: "production",
    deploymentStatus: "success",
    artifact: {
      schemaVersion: targets.pagesArtifact.manifestSchemaVersion,
      root: targets.pagesArtifact.root,
      aggregateSha256: pagesArtifactManifest?.aggregateSha256,
      fileCount: pagesArtifactManifest?.fileCount,
      totalBytes: pagesArtifactManifest?.totalBytes,
      deploymentMessage: pagesArtifactManifest?.deploymentMessage,
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
      passkey: false,
      line: false,
      google: false,
      email: false,
    },
    authenticationFlags: policy.requiredDisabledAuthenticationFlags,
    verification: {
      bindingsFromDeploymentSnapshot: true,
      flagsWereRedeployed: true,
      healthReady: true,
      allPublicAuthenticationMethodsDisabled: true,
      authObservabilityDatasetQueryable: true,
      healthCheckedAt: manifest.verification?.healthCheckedAt,
      methodsCheckedAt: manifest.verification?.methodsCheckedAt,
      analyticsEngineCheckedAt:
        manifest.verification?.analyticsEngineCheckedAt,
      verifiedAt,
    },
  };
  checkExactObject(manifest, expected, "Rollback manifest", errors);
  return { valid: errors.length === 0, errors };
}

export function validateLiveRollbackDeployment(
  deployment,
  { targets, manifest, sourceCommit, pagesArtifactManifest },
) {
  const errors = [];
  if (!deployment || typeof deployment !== "object" || Array.isArray(deployment)) {
    return ["Cloudflare did not return the rollback deployment."];
  }
  const expectedUrl = manifest?.deploymentUrl;
  const metadata = deployment.deployment_trigger?.metadata;
  if (
    typeof deployment.id !== "string" ||
    deployment.id.toLowerCase() !== manifest.disabledDeploymentId.toLowerCase()
  ) {
    errors.push("Live rollback deployment ID does not match the manifest.");
  }
  if (deployment.project_name !== targets.pagesProject) {
    errors.push("Live rollback deployment belongs to another Pages project.");
  }
  if (
    deployment.environment !== "production" ||
    deployment.production_branch !== targets.productionBranch
  ) {
    errors.push("Live rollback deployment is not on the pinned Production branch.");
  }
  if (
    deployment.latest_stage?.name !== "deploy" ||
    deployment.latest_stage?.status !== "success" ||
    deployment.is_skipped !== false
  ) {
    errors.push("Live rollback deployment is not successfully deployed.");
  }
  if (
    metadata?.branch !== targets.productionBranch ||
    typeof metadata?.commit_hash !== "string" ||
    metadata.commit_hash.toLowerCase() !== sourceCommit.toLowerCase() ||
    metadata.commit_dirty !== false ||
    metadata.commit_message !== pagesArtifactManifest?.deploymentMessage ||
    manifest?.artifact?.deploymentMessage !==
      pagesArtifactManifest?.deploymentMessage
  ) {
    errors.push(
      "Live rollback deployment is not the clean reviewed commit and Pages artifact.",
    );
  }
  if (deployment.url !== expectedUrl) {
    errors.push("Live rollback deployment URL does not match the manifest.");
  }
  if (
    deployment.d1_databases?.[targets.d1Binding]?.id !== targets.d1DatabaseId
  ) {
    errors.push("Live rollback deployment does not bind the pinned D1 database.");
  }
  if (
    deployment.analytics_engine_datasets?.[targets.authObservabilityBinding]
      ?.dataset !== targets.authObservabilityDataset
  ) {
    errors.push(
      "Live rollback deployment does not bind the pinned Analytics Engine dataset.",
    );
  }
  return errors;
}

function isNoStoreResponse(value) {
  return (
    typeof value === "string" &&
    /(?:^|,)\s*(?:private,\s*)?no-store(?:\s*,|$)/i.test(value)
  );
}

export function validateRollbackReadiness(
  health,
  methods,
  targets,
  {
    checkedAt = new Date(),
    healthCacheControl = "",
    methodsCacheControl = "",
  } = {},
) {
  const errors = [];
  const checkedTime = new Date(checkedAt).getTime();
  const healthTime = Date.parse(health?.timestamp ?? "");
  if (
    !isDeepStrictEqual(
      health && typeof health === "object" && !Array.isArray(health)
        ? Object.keys(health).sort()
        : [],
      ["requestId", "status", "timestamp"],
    ) ||
    health.status !== "ready" ||
    typeof health.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(health.requestId) ||
    !Number.isFinite(checkedTime) ||
    !Number.isFinite(healthTime) ||
    new Date(health.timestamp).toISOString() !== health.timestamp ||
    Math.abs(checkedTime - healthTime) > 10 * 60 * 1000
  ) {
    errors.push("Rollback deployment health endpoint is not exact and current.");
  }
  if (
    !isNoStoreResponse(healthCacheControl) ||
    !isNoStoreResponse(methodsCacheControl)
  ) {
    errors.push("Rollback deployment probe responses are not marked no-store.");
  }
  const methodNames = ["passkey", "line", "google", "email"];
  const expectedAccountMethods = Object.fromEntries(
    methodNames.map((name) => [name, false]),
  );
  const expectedFlags = Object.fromEntries(
    Object.keys(targets.rollbackPolicy.requiredDisabledAuthenticationFlags).map(
      (name) => [name, false],
    ),
  );
  if (
    !isDeepStrictEqual(
      methods && typeof methods === "object" && !Array.isArray(methods)
        ? Object.keys(methods).sort()
        : [],
      [
        "accountMethods",
        "authenticated",
        "authenticationFlags",
        "email",
        "google",
        "line",
        "passkey",
        "recentlyAuthenticated",
      ],
    ) ||
    methods.authenticated !== false ||
    methods.recentlyAuthenticated !== false ||
    !isDeepStrictEqual(methods.accountMethods, expectedAccountMethods) ||
    methodNames.some((name) => methods[name] !== false) ||
    !isDeepStrictEqual(methods.authenticationFlags, expectedFlags)
  ) {
    errors.push(
      "Rollback deployment authentication methods and five raw flags are not exactly disabled.",
    );
  }
  return errors;
}

export function validateAnalyticsEngineDatasetList(payload, expectedDataset) {
  const errors = [];
  if (
    typeof expectedDataset !== "string" ||
    !/^[A-Za-z0-9_]{1,64}$/.test(expectedDataset)
  ) {
    return ["Pinned Analytics Engine dataset name is invalid."];
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    !Array.isArray(payload.data) ||
    payload.data.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        typeof row.name !== "string",
    )
  ) {
    return ["Analytics Engine SHOW TABLES response is invalid."];
  }
  const matches = payload.data.filter((row) => row.name === expectedDataset);
  if (matches.length !== 1) {
    errors.push("Pinned Analytics Engine dataset is not uniquely queryable.");
  }
  return errors;
}

export function validateLiveSchedulerDeployment(
  status,
  version,
  { targets, expectedMessage },
) {
  const errors = [];
  const scheduler = targets.accountDeletionScheduler;
  const activeVersions = Array.isArray(status?.versions) ? status.versions : [];
  if (
    !UUID_PATTERN.test(status?.id ?? "") ||
    status?.strategy !== "percentage" ||
    activeVersions.length !== 1 ||
    activeVersions[0]?.percentage !== 100 ||
    !UUID_PATTERN.test(activeVersions[0]?.version_id ?? "")
  ) {
    errors.push("Account-deletion Worker is not a single 100% active version.");
    return errors;
  }
  const activeVersionId = activeVersions[0].version_id;
  const liveMessage = version?.annotations?.["workers/message"];
  const messageMatches =
    expectedMessage === null
      ? liveMessage == null
      : liveMessage === expectedMessage;
  if (
    version?.id !== activeVersionId ||
    version?.metadata?.source !== "wrangler" ||
    typeof version?.metadata?.created_on !== "string" ||
    !Number.isFinite(Date.parse(version.metadata.created_on)) ||
    !messageMatches
  ) {
    errors.push(
      "Active account-deletion Worker does not carry the reviewed commit and bundle hash.",
    );
  }
  if (
    version?.resources?.script_runtime?.compatibility_date !==
      scheduler.compatibilityDate ||
    typeof version?.resources?.script?.etag !== "string" ||
    version.resources.script.etag.length === 0
  ) {
    errors.push("Active account-deletion Worker runtime metadata is invalid.");
  }
  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings
    : [];
  const byName = Object.fromEntries(bindings.map((binding) => [binding.name, binding]));
  if (
    bindings.length !== 3 ||
    byName.TORUDAKE_SITE_ORIGIN?.type !== "plain_text" ||
    byName.TORUDAKE_SITE_ORIGIN?.text !== targets.productionUrl ||
    byName.ACCOUNT_DELETION_BATCH_LIMIT?.type !== "plain_text" ||
    byName.ACCOUNT_DELETION_BATCH_LIMIT?.text !== "5" ||
    byName.ACCOUNT_DELETION_OPERATIONS_SECRET?.type !== "secret_text"
  ) {
    errors.push("Active account-deletion Worker bindings do not match the contract.");
  }
  return errors;
}

export function classifySchedulerRecoveryState(
  status,
  { previousVersionId, uploadedVersionId } = {},
) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  const ids = versions.map((entry) => entry?.version_id);
  const percentages = versions.map((entry) => entry?.percentage);
  const validShape =
    UUID_PATTERN.test(status?.id ?? "") &&
    status?.strategy === "percentage" &&
    versions.length >= 1 &&
    versions.length <= 2 &&
    versions.every(
      (entry) =>
        UUID_PATTERN.test(entry?.version_id ?? "") &&
        typeof entry?.percentage === "number" &&
        Number.isFinite(entry.percentage) &&
        entry.percentage > 0 &&
        entry.percentage <= 100,
    ) &&
    new Set(ids.map((id) => id.toLowerCase())).size === ids.length &&
    percentages.reduce((sum, value) => sum + value, 0) === 100;
  if (!validShape || !UUID_PATTERN.test(previousVersionId ?? "")) {
    return "foreign_or_ambiguous";
  }
  if (
    versions.length === 1 &&
    ids[0].toLowerCase() === previousVersionId.toLowerCase() &&
    percentages[0] === 100
  ) {
    return "previous_active";
  }
  if (
    !UUID_PATTERN.test(uploadedVersionId ?? "") ||
    uploadedVersionId.toLowerCase() === previousVersionId.toLowerCase()
  ) {
    return "foreign_or_ambiguous";
  }
  const ownedIds = new Set([
    previousVersionId.toLowerCase(),
    uploadedVersionId.toLowerCase(),
  ]);
  if (
    ids.every((id) => ownedIds.has(id.toLowerCase())) &&
    ids.some((id) => id.toLowerCase() === uploadedVersionId.toLowerCase())
  ) {
    return "owned_activation";
  }
  return "foreign_or_ambiguous";
}

export function validateSchedulerRollbackVersion(
  version,
  { targets, expectedVersionId },
) {
  const errors = [];
  const scheduler = targets.accountDeletionScheduler;
  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings
    : [];
  const byName = Object.fromEntries(bindings.map((binding) => [binding.name, binding]));
  if (
    version?.id !== expectedVersionId ||
    version?.metadata?.source !== "wrangler" ||
    typeof version?.metadata?.created_on !== "string" ||
    !Number.isFinite(Date.parse(version.metadata.created_on)) ||
    !SHA256_PATTERN.test(version?.resources?.script?.etag ?? "") ||
    version?.resources?.script_runtime?.compatibility_date !==
      scheduler.compatibilityDate ||
    bindings.length !== 3 ||
    byName.TORUDAKE_SITE_ORIGIN?.type !== "plain_text" ||
    byName.TORUDAKE_SITE_ORIGIN?.text !== targets.productionUrl ||
    byName.ACCOUNT_DELETION_BATCH_LIMIT?.type !== "plain_text" ||
    byName.ACCOUNT_DELETION_BATCH_LIMIT?.text !== "5" ||
    byName.ACCOUNT_DELETION_OPERATIONS_SECRET?.type !== "secret_text"
  ) {
    errors.push(
      "Account-deletion Worker rollback version is unavailable or has unsafe bindings.",
    );
  }
  return errors;
}

export function validateLiveSchedulerManifestMatch(
  status,
  version,
  liveSchedule,
  { targets, manifest },
) {
  const errors = validateLiveSchedulerDeployment(status, version, {
    targets,
    expectedMessage: manifest?.deploymentMessage,
  });
  errors.push(
    ...validateLiveSchedulerSchedule(liveSchedule, {
      targets,
      manifestSchedule: manifest?.schedule,
    }),
  );
  const activeVersionId = status?.versions?.[0]?.version_id;
  if (
    status?.id !== manifest?.activeDeploymentId ||
    activeVersionId !== manifest?.activeVersionId ||
    version?.resources?.script?.etag !== manifest?.scriptEtag ||
    version?.annotations?.["workers/tag"] !== manifest?.uploadTag ||
    version?.metadata?.created_on !== manifest?.deployedAt
  ) {
    errors.push(
      "Live account-deletion Worker does not match the approved external manifest.",
    );
  }
  return errors;
}

export function validateSchedulerBootstrapCandidate(
  status,
  version,
  liveSchedule,
  { targets },
) {
  const errors = [
    ...validateLiveSchedulerDeployment(status, version, {
      targets,
      expectedMessage: null,
    }),
    ...validateSchedulerRollbackVersion(version, {
      targets,
      expectedVersionId: status?.versions?.[0]?.version_id,
    }),
    ...validateLiveSchedulerSchedule(liveSchedule, { targets }),
  ];
  if (
    version?.annotations?.["workers/message"] != null ||
    version?.annotations?.["workers/tag"] != null
  ) {
    errors.push(
      "Scheduler provenance bootstrap is limited to the legacy unannotated Worker.",
    );
  }
  return errors;
}

export function validateApprovedPreviousSchedulerVersion(
  version,
  { targets, approvedPrevious },
) {
  const errors = validateSchedulerRollbackVersion(version, {
    targets,
    expectedVersionId: approvedPrevious?.versionId,
  });
  const liveMessage = version?.annotations?.["workers/message"];
  const liveTag = version?.annotations?.["workers/tag"];
  const messageMatches =
    approvedPrevious?.deploymentMessage === null
      ? liveMessage == null
      : liveMessage === approvedPrevious?.deploymentMessage;
  const tagMatches =
    approvedPrevious?.uploadTag === null
      ? liveTag == null
      : liveTag === approvedPrevious?.uploadTag;
  if (
    version?.resources?.script?.etag !== approvedPrevious?.scriptEtag ||
    version?.metadata?.created_on !== approvedPrevious?.deployedAt ||
    !messageMatches ||
    !tagMatches
  ) {
    errors.push(
      "Account-deletion Worker rollback version does not match its approved provenance.",
    );
  }
  return errors;
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
  const result = run(process.execPath, [
    WRANGLER_BIN,
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

export function runLocalChecks({
  root = PROJECT_ROOT,
  requirePagesArtifactManifest = false,
  pagesArtifactManifestPath,
  requireRollbackManifest = false,
  rollbackManifestPath,
  requireSchedulerManifest = false,
  schedulerManifestPath,
} = {}) {
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
    cloudflareAccountId: "e7572bf15e2fc4346e54f72ed7cb3ff0",
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
    pagesArtifact: {
      root: "dist/cloudflare-pages",
      releaseMessagePrefix: "torudake-pages-v1",
      manifestEnvironmentVariable: "TORUDAKE_PAGES_ARTIFACT_MANIFEST",
      manifestSchemaVersion: 1,
      deployConfirmation: "deploy-cloudflare-pages",
    },
    accountDeletionScheduler: {
      workerName: "torudake-reel-account-deletion-scheduler",
      config: "wrangler.account-deletion-scheduler.jsonc",
      source: "workers/account-deletion-scheduler.mjs",
      compatibilityDate: "2026-08-13",
      cronSchedule: "15 18 * * *",
      releaseMessagePrefix: "torudake-release-v1",
      provisioningConfirmation: "deploy-account-deletion-scheduler",
      bootstrapProvenanceConfirmation:
        "bootstrap-account-deletion-scheduler-provenance",
      manifestEnvironmentVariable:
        "TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST",
      manifestSchemaVersion: 2,
    },
    rollbackPolicy: {
      manifestEnvironmentVariable: "TORUDAKE_ROLLBACK_MANIFEST",
      manifestSchemaVersion: 2,
      provisioningConfirmation: "provision-disabled-line-rollback",
      requiredDisabledAuthenticationFlags: {
        OIDC_AUTH_ENABLED: "false",
        LINE_LOGIN_ENABLED: "false",
        GOOGLE_OIDC_ENABLED: "false",
        EMAIL_AUTH_ENABLED: "false",
        PASSKEY_AUTH_ENABLED: "false",
      },
      legacyPreviousProduction: {
        deploymentId: "f8bee356-6458-4c91-9e29-b3febcd5e4fc",
        sourceCommit: "35abc4dde3d45a48b2d422da8f37a3b314e036ee",
        commitMessage: "fix: harden LINE login lifecycle and observability",
        createdOn: "2026-08-18T08:51:43.113033Z",
        methodsSchema: "line_only_without_authentication_flags",
      },
      telemetryDegradedEmergencyDeployment: {
        deploymentId: "04519766-9146-440a-9467-57e9ac56e4a5",
        sourceCommit: "38f8a256c58362862b96d8437c49f0556c6d0dc6",
        classification: "emergency_only",
        degradation: "auth_observability_binding_absent",
      },
    },
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

  const schedulerConfig = readJson(
    resolve(root, targets.accountDeletionScheduler.config),
  );
  checkExactObject(
    schedulerConfig,
    {
      $schema: "./node_modules/wrangler/config-schema.json",
      name: targets.accountDeletionScheduler.workerName,
      main: targets.accountDeletionScheduler.source,
      compatibility_date: targets.accountDeletionScheduler.compatibilityDate,
      workers_dev: false,
      observability: {
        enabled: true,
        logs: {
          enabled: true,
          head_sampling_rate: 1,
          invocation_logs: true,
          persist: true,
        },
      },
      vars: {
        TORUDAKE_SITE_ORIGIN: targets.productionUrl,
        ACCOUNT_DELETION_BATCH_LIMIT: "5",
      },
      triggers: { crons: [targets.accountDeletionScheduler.cronSchedule] },
    },
    "Account-deletion Worker configuration",
    errors,
  );
  if (!existsSync(resolve(root, targets.accountDeletionScheduler.source))) {
    errors.push("Account-deletion Worker source is missing.");
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

  const headResult = runGit(["rev-parse", "HEAD"]);
  const sourceCommit = headResult.status === 0 ? headResult.stdout.trim() : "";
  if (!COMMIT_PATTERN.test(sourceCommit)) {
    errors.push("Unable to resolve the reviewed release commit.");
  }

  let pagesArtifactManifest = null;
  const pagesManifestPath =
    typeof pagesArtifactManifestPath === "string"
      ? pagesArtifactManifestPath.trim()
      : "";
  if (!pagesManifestPath) {
    if (requirePagesArtifactManifest) {
      errors.push(
        `${targets.pagesArtifact.manifestEnvironmentVariable} must point to the externally recorded Pages artifact manifest before Pages provisioning or activation.`,
      );
    } else {
      notes.push(
        "Pages artifact manifest is not required for scheduler-only provisioning; this does not authorize a Pages deployment.",
      );
    }
  } else if (!isAbsolute(pagesManifestPath)) {
    errors.push("Pages artifact manifest path must be absolute.");
  } else {
    const resolvedPagesManifestPath = resolve(pagesManifestPath);
    const repositoryRelativePath = relative(root, resolvedPagesManifestPath);
    if (!isDDrivePath(resolvedPagesManifestPath)) {
      errors.push("Pages artifact manifest must be stored on drive D:.");
    } else if (
      repositoryRelativePath === "" ||
      (!repositoryRelativePath.startsWith("..") &&
        !isAbsolute(repositoryRelativePath))
    ) {
      errors.push("Pages artifact manifest must remain outside the repository.");
    } else if (!existsSync(resolvedPagesManifestPath)) {
      errors.push("Pages artifact manifest file does not exist.");
    } else {
      try {
        const parsedManifest = readPagesArtifactManifestFileSync(
          resolvedPagesManifestPath,
        );
        const validation = validatePagesArtifactManifest(parsedManifest, {
          expectedSourceCommit: sourceCommit,
        });
        if (
          parsedManifest?.schemaVersion !==
            targets.pagesArtifact.manifestSchemaVersion ||
          parsedManifest?.artifactRoot !== targets.pagesArtifact.root ||
          PAGES_ARTIFACT_SCHEMA_VERSION !==
            targets.pagesArtifact.manifestSchemaVersion ||
          PAGES_ARTIFACT_ROOT !== targets.pagesArtifact.root
        ) {
          validation.errors.push(
            "Pages artifact manifest does not match the pinned release target.",
          );
          validation.valid = false;
        }
        errors.push(...validation.errors);
        if (validation.valid) {
          pagesArtifactManifest = parsedManifest;
          notes.push(
            "Pages artifact manifest matches the reviewed commit and pinned schema.",
          );
        }
      } catch (error) {
        errors.push(
          `Pages artifact manifest could not be read safely: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  let rollbackManifest = null;
  const manifestPath =
    typeof rollbackManifestPath === "string"
      ? rollbackManifestPath.trim()
      : "";
  if (!manifestPath) {
    if (requireRollbackManifest) {
      errors.push(
        `${targets.rollbackPolicy.manifestEnvironmentVariable} must point to the externally verified disabled rollback manifest before production activation.`,
      );
    } else {
      notes.push(
        "Disabled rollback manifest is not required in offline or rollback-provisioning mode; this does not authorize production activation.",
      );
    }
  } else if (!isAbsolute(manifestPath)) {
    errors.push("Rollback manifest path must be absolute.");
  } else {
    const resolvedManifestPath = resolve(manifestPath);
    const repositoryRelativePath = relative(root, resolvedManifestPath);
    if (!isDDrivePath(resolvedManifestPath)) {
      errors.push("Rollback manifest must be stored on drive D:.");
    } else if (
      repositoryRelativePath === "" ||
      (!repositoryRelativePath.startsWith("..") &&
        !isAbsolute(repositoryRelativePath))
    ) {
      errors.push("Rollback manifest must remain outside the repository.");
    } else if (!existsSync(resolvedManifestPath)) {
      errors.push("Rollback manifest file does not exist.");
    } else {
      try {
        const parsedManifest = readPagesArtifactManifestFileSync(
          resolvedManifestPath,
        );
        const validation = validateRollbackManifest(
          parsedManifest,
          { targets, sourceCommit, pagesArtifactManifest },
        );
        errors.push(...validation.errors);
        if (validation.valid) {
          rollbackManifest = parsedManifest;
          notes.push(
            "Telemetry-preserving disabled rollback deployment manifest matches the reviewed release commit.",
          );
        }
      } catch {
        errors.push("Rollback manifest could not be read safely or is invalid.");
      }
    }
  }

  let schedulerManifest = null;
  const workerManifestPath =
    typeof schedulerManifestPath === "string"
      ? schedulerManifestPath.trim()
      : "";
  if (!workerManifestPath) {
    if (requireSchedulerManifest) {
      errors.push(
        `${targets.accountDeletionScheduler.manifestEnvironmentVariable} must point to the externally recorded live Worker manifest before Pages activation or rollback provisioning.`,
      );
    } else {
      notes.push(
        "Account-deletion Worker manifest is not required in offline or scheduler-provisioning mode; this does not authorize Pages activation.",
      );
    }
  } else if (!isAbsolute(workerManifestPath)) {
    errors.push("Account-deletion Worker manifest path must be absolute.");
  } else {
    const resolvedWorkerManifestPath = resolve(workerManifestPath);
    const repositoryRelativePath = relative(root, resolvedWorkerManifestPath);
    if (!isDDrivePath(resolvedWorkerManifestPath)) {
      errors.push("Account-deletion Worker manifest must be stored on drive D:.");
    } else if (
      repositoryRelativePath === "" ||
      (!repositoryRelativePath.startsWith("..") &&
        !isAbsolute(repositoryRelativePath))
    ) {
      errors.push(
        "Account-deletion Worker manifest must remain outside the repository.",
      );
    } else if (!existsSync(resolvedWorkerManifestPath)) {
      errors.push("Account-deletion Worker manifest file does not exist.");
    } else {
      try {
        const { value: parsedManifest } = readBoundedJsonFileSync(
          resolvedWorkerManifestPath,
          { maxBytes: MAX_SCHEDULER_MANIFEST_BYTES },
        );
        if (
          !parsedManifest ||
          typeof parsedManifest !== "object" ||
          Array.isArray(parsedManifest)
        ) {
          throw new Error("invalid manifest");
        }
        schedulerManifest = parsedManifest;
      } catch {
        errors.push(
          "Account-deletion Worker manifest could not be read safely or is not valid JSON.",
        );
      }
    }
  }

  return {
    errors,
    migrations,
    notes,
    pagesArtifactManifest,
    rollbackManifest,
    schedulerManifest,
    sourceCommit,
    targets,
  };
}

function runWranglerJson(args, label) {
  const result = run(process.execPath, [WRANGLER_BIN, ...args]);
  if (result.status !== 0) {
    throw new Error(`${label} could not be verified with Wrangler.`);
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

export function schedulerBundleSha256(bundleBytes) {
  if (!(bundleBytes instanceof Uint8Array) || bundleBytes.byteLength === 0) {
    throw new Error("Scheduler bundle bytes are unavailable.");
  }
  return createHash("sha256").update(bundleBytes).digest("hex");
}

export function assertSchedulerBundleIntegrity(bundleBytes, expectedSha256) {
  const actualSha256 = schedulerBundleSha256(bundleBytes);
  if (
    !SHA256_PATTERN.test(expectedSha256 ?? "") ||
    actualSha256 !== expectedSha256
  ) {
    throw new Error("Scheduler bundle bytes do not match the reviewed SHA-256.");
  }
  return actualSha256;
}

function parseSchedulerMultipartHeaders(headerBytes) {
  if (
    headerBytes.byteLength === 0 ||
    headerBytes.byteLength > MAX_SCHEDULER_MULTIPART_HEADER_BYTES
  ) {
    throw new Error("Scheduler dry-run multipart headers are invalid.");
  }
  for (const byte of headerBytes) {
    if (byte !== 0x0d && byte !== 0x0a && (byte < 0x20 || byte > 0x7e)) {
      throw new Error("Scheduler dry-run multipart headers are not ASCII.");
    }
  }
  const headers = new Map();
  for (const line of headerBytes.toString("ascii").split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator < 1 || line[separator + 1] !== " ") {
      throw new Error("Scheduler dry-run multipart header syntax is invalid.");
    }
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 2);
    if (!/^[a-z0-9-]+$/.test(name) || !value || headers.has(name)) {
      throw new Error("Scheduler dry-run multipart headers are ambiguous.");
    }
    headers.set(name, value);
  }
  return headers;
}

export function extractSchedulerModuleFromWranglerDryRun(
  dryRunBytes,
  {
    expectedModuleName = SCHEDULER_MODULE_NAME,
    expectedCompatibilityDate,
    expectedProductionUrl,
  } = {},
) {
  if (
    !(dryRunBytes instanceof Uint8Array) ||
    dryRunBytes.byteLength === 0 ||
    dryRunBytes.byteLength > MAX_SCHEDULER_DRY_RUN_BYTES
  ) {
    throw new Error("Scheduler dry-run multipart bytes are unavailable or oversized.");
  }
  if (!/^[a-z0-9._-]+$/i.test(expectedModuleName)) {
    throw new Error("Scheduler dry-run expected module name is invalid.");
  }
  const bytes = Buffer.from(
    dryRunBytes.buffer,
    dryRunBytes.byteOffset,
    dryRunBytes.byteLength,
  );
  const firstLineEnd = bytes.indexOf("\r\n");
  if (firstLineEnd < 3 || firstLineEnd > 72) {
    throw new Error("Scheduler dry-run multipart boundary is invalid.");
  }
  if (
    bytes.subarray(0, firstLineEnd).some((byte) => byte < 0x21 || byte > 0x7e)
  ) {
    throw new Error("Scheduler dry-run multipart boundary is not ASCII.");
  }
  const delimiter = bytes.subarray(0, firstLineEnd).toString("ascii");
  if (!/^--[-a-z0-9'()+_,.\/:=?]{1,70}$/i.test(delimiter)) {
    throw new Error("Scheduler dry-run multipart boundary is invalid.");
  }
  const boundaryNeedle = Buffer.from(`\r\n${delimiter}`, "ascii");
  const headerTerminator = Buffer.from("\r\n\r\n", "ascii");
  const parts = [];
  let cursor = firstLineEnd + 2;
  let closed = false;
  while (!closed) {
    if (parts.length >= 3) {
      throw new Error("Scheduler dry-run multipart contains unexpected parts.");
    }
    const headerEnd = bytes.indexOf(headerTerminator, cursor);
    if (
      headerEnd < cursor ||
      headerEnd - cursor > MAX_SCHEDULER_MULTIPART_HEADER_BYTES
    ) {
      throw new Error("Scheduler dry-run multipart headers are invalid.");
    }
    const headers = parseSchedulerMultipartHeaders(
      bytes.subarray(cursor, headerEnd),
    );
    const bodyStart = headerEnd + headerTerminator.byteLength;
    const bodyEnd = bytes.indexOf(boundaryNeedle, bodyStart);
    if (bodyEnd < bodyStart) {
      throw new Error("Scheduler dry-run multipart body is incomplete.");
    }
    parts.push({ headers, body: bytes.subarray(bodyStart, bodyEnd) });
    cursor = bodyEnd + boundaryNeedle.byteLength;
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) {
      cursor += 2;
      if (!bytes.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
        throw new Error("Scheduler dry-run multipart closing boundary is invalid.");
      }
      cursor += 2;
      closed = true;
    } else if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("\r\n"))) {
      cursor += 2;
    } else {
      throw new Error("Scheduler dry-run multipart boundary delimiter is invalid.");
    }
  }
  if (cursor !== bytes.byteLength || parts.length !== 2) {
    throw new Error("Scheduler dry-run multipart contains unexpected trailing data.");
  }

  const [metadataPart, modulePart] = parts;
  if (
    metadataPart.headers.size !== 1 ||
    metadataPart.headers.get("content-disposition") !==
      'form-data; name="metadata"' ||
    metadataPart.body.byteLength === 0 ||
    metadataPart.body.byteLength > MAX_SCHEDULER_METADATA_BYTES
  ) {
    throw new Error("Scheduler dry-run metadata part is invalid.");
  }
  let metadata;
  try {
    if (
      metadataPart.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ) {
      throw new Error("BOM is not permitted.");
    }
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(metadataPart.body),
    );
  } catch {
    throw new Error("Scheduler dry-run metadata is not valid UTF-8 JSON.");
  }
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !isDeepStrictEqual(Object.keys(metadata).sort(), [
      "bindings",
      "compatibility_date",
      "compatibility_flags",
      "main_module",
      "observability",
      "package_dependencies",
    ]) ||
    metadata.main_module !== expectedModuleName ||
    (expectedCompatibilityDate !== undefined &&
      metadata.compatibility_date !== expectedCompatibilityDate) ||
    !isDeepStrictEqual(metadata.compatibility_flags, []) ||
    !isDeepStrictEqual(metadata.observability, {
      enabled: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
      },
    })
  ) {
    throw new Error("Scheduler dry-run metadata does not match the release target.");
  }
  const expectedBindings = [
    {
      name: "TORUDAKE_SITE_ORIGIN",
      type: "plain_text",
      text: expectedProductionUrl,
    },
    {
      name: "ACCOUNT_DELETION_BATCH_LIMIT",
      type: "plain_text",
      text: "5",
    },
  ];
  if (
    typeof expectedProductionUrl !== "string" ||
    !isDeepStrictEqual(metadata.bindings, expectedBindings) ||
    !Array.isArray(metadata.package_dependencies) ||
    metadata.package_dependencies.length > 128 ||
    new Set(metadata.package_dependencies.map((entry) => entry?.name)).size !==
      metadata.package_dependencies.length ||
    metadata.package_dependencies.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        !isDeepStrictEqual(Object.keys(entry).sort(), [
          "installedVersion",
          "name",
          "packageJsonVersion",
        ]) ||
        [entry.name, entry.packageJsonVersion, entry.installedVersion].some(
          (value) =>
            typeof value !== "string" ||
            value.length < 1 ||
            value.length > 256 ||
            /[^\x20-\x7e]/.test(value),
        ),
    )
  ) {
    throw new Error("Scheduler dry-run metadata projection is invalid.");
  }

  const expectedDisposition =
    `form-data; name="${expectedModuleName}"; ` +
    `filename="${expectedModuleName}"`;
  if (
    modulePart.headers.size !== 2 ||
    modulePart.headers.get("content-disposition") !== expectedDisposition ||
    modulePart.headers.get("content-type") !==
      "application/javascript+module" ||
    modulePart.body.byteLength === 0
  ) {
    throw new Error("Scheduler dry-run module part is invalid.");
  }
  try {
    if (
      modulePart.body.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))
    ) {
      throw new Error("BOM is not permitted.");
    }
    new TextDecoder("utf-8", { fatal: true }).decode(modulePart.body);
  } catch {
    throw new Error("Scheduler dry-run module is not valid UTF-8.");
  }
  return {
    bundleBytes: Buffer.from(modulePart.body),
    metadata,
  };
}

export function buildSchedulerDryRun(targets, sourceCommit) {
  const tempRoot = resolve(process.env.TEMP ?? "");
  if (!isDDrivePath(tempRoot) || !existsSync(tempRoot)) {
    throw new Error("Scheduler dry-run requires an existing D-drive TEMP directory.");
  }
  const directory = mkdtempSync(join(tempRoot, "torudake-scheduler-preflight-"));
  const outfile = resolve(directory, "account-deletion-scheduler.multipart");
  try {
    const result = run(process.execPath, [
      WRANGLER_BIN,
      "deploy",
      "--config",
      resolve(PROJECT_ROOT, targets.accountDeletionScheduler.config),
      "--dry-run",
      "--outfile",
      outfile,
    ]);
    if (result.status !== 0 || !existsSync(outfile)) {
      throw new Error("Account-deletion Worker Wrangler dry-run failed.");
    }
    const dryRunBytes = readFileSync(outfile);
    const { bundleBytes } = extractSchedulerModuleFromWranglerDryRun(
      dryRunBytes,
      {
        expectedCompatibilityDate:
          targets.accountDeletionScheduler.compatibilityDate,
        expectedProductionUrl: targets.productionUrl,
      },
    );
    const bundleSha256 = schedulerBundleSha256(bundleBytes);
    return {
      bundleBytes,
      bundleSha256,
      message: schedulerReleaseMessage(sourceCommit, bundleSha256, targets),
    };
  } finally {
    const relativeDirectory = relative(tempRoot, directory);
    if (
      relativeDirectory &&
      !relativeDirectory.startsWith("..") &&
      !isAbsolute(relativeDirectory)
    ) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

async function fetchBoundedJsonResponse(url, options, maxBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      ...options,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    return {
      value: await readBoundedJsonResponse(response, { maxBytes }),
      response,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBoundedJson(url, options, maxBytes) {
  return (await fetchBoundedJsonResponse(url, options, maxBytes)).value;
}

function cloudflareApiCredentials(targets) {
  const identity = runWranglerJson(["whoami", "--json"], "Cloudflare identity");
  if (
    !Array.isArray(identity.accounts) ||
    !identity.accounts.some(
      (account) => account?.id === targets.cloudflareAccountId,
    )
  ) {
    throw new Error("Wrangler is not authenticated to the pinned Cloudflare account.");
  }
  const credential = runWranglerJson(
    ["auth", "token", "--json"],
    "Cloudflare API credential",
  );
  if (
    !["oauth", "api_token"].includes(credential?.type) ||
    typeof credential?.token !== "string" ||
    credential.token.length < 20
  ) {
    throw new Error("Wrangler did not provide a usable Cloudflare API credential.");
  }
  return credential.token;
}

export async function readLiveSchedulerSchedule(targets) {
  const token = cloudflareApiCredentials(targets);
  const scheduler = targets?.accountDeletionScheduler;
  if (
    typeof targets?.cloudflareAccountId !== "string" ||
    typeof scheduler?.workerName !== "string"
  ) {
    throw new Error("Account-deletion Worker schedule target is invalid.");
  }
  const envelope = await fetchBoundedJson(
    `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
      `/workers/scripts/${encodeURIComponent(scheduler.workerName)}/schedules`,
    { headers: { Authorization: `Bearer ${token}` } },
    MAX_CLOUDFLARE_API_BYTES,
  );
  return parseLiveSchedulerScheduleEnvelope(envelope);
}

export async function runRemotePagesRollbackChecks(
  targets,
  manifest,
  sourceCommit,
  pagesArtifactManifest,
) {
  const errors = [];
  const notes = [];
  try {
    const token = cloudflareApiCredentials(targets);
    const apiBase =
      `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}` +
      `/pages/projects/${encodeURIComponent(targets.pagesProject)}/deployments`;
    const headers = { Authorization: `Bearer ${token}` };
    const detailEnvelope = await fetchBoundedJson(
      `${apiBase}/${encodeURIComponent(manifest.disabledDeploymentId)}`,
      { headers },
      MAX_CLOUDFLARE_API_BYTES,
    );
    if (detailEnvelope?.success !== true) {
      throw new Error("Cloudflare Pages deployment detail schema is invalid.");
    }
    errors.push(
      ...validateLiveRollbackDeployment(detailEnvelope.result, {
        targets,
        manifest,
        sourceCommit,
        pagesArtifactManifest,
      }),
    );
    const healthResult = await fetchBoundedJsonResponse(
      `${manifest.deploymentUrl}/api/health`,
      { headers: { Accept: "application/json" } },
      MAX_READINESS_BYTES,
    );
    const methodsResult = await fetchBoundedJsonResponse(
      `${manifest.deploymentUrl}/api/account/auth/methods`,
      { headers: { Accept: "application/json" } },
      MAX_READINESS_BYTES,
    );
    errors.push(
      ...validateRollbackReadiness(
        healthResult.value,
        methodsResult.value,
        targets,
        {
          checkedAt: new Date(),
          healthCacheControl:
            healthResult.response.headers.get("cache-control") ?? "",
          methodsCacheControl:
            methodsResult.response.headers.get("cache-control") ?? "",
        },
      ),
    );
    const analyticsTables = await fetchBoundedJson(
      `https://api.cloudflare.com/client/v4/accounts/${targets.cloudflareAccountId}/analytics_engine/sql`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "text/plain; charset=utf-8",
        },
        body: "SHOW TABLES FORMAT JSON",
      },
      MAX_ANALYTICS_ENGINE_BYTES,
    );
    errors.push(
      ...validateAnalyticsEngineDatasetList(
        analyticsTables,
        targets.authObservabilityDataset,
      ),
    );
    if (errors.length === 0) {
      notes.push(
        "Live rollback deployment, D1/Analytics Engine bindings, dataset queryability, readiness, and five disabled auth flags are verified.",
      );
    }
  } catch (error) {
    errors.push(
      `Live rollback verification failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { errors, notes };
}

export async function runRemoteSchedulerChecks(
  targets,
  schedulerArtifact,
  schedulerManifest,
) {
  const errors = [];
  const notes = [];
  const scheduler = targets.accountDeletionScheduler;
  try {
    const common = [
      "--name",
      scheduler.workerName,
      "--config",
      resolve(PROJECT_ROOT, scheduler.config),
      "--json",
    ];
    const status = runWranglerJson(
      ["deployments", "status", ...common],
      "Account-deletion Worker deployment",
    );
    const versionId = status?.versions?.[0]?.version_id;
    if (!UUID_PATTERN.test(versionId ?? "")) {
      throw new Error("Account-deletion Worker active version is unavailable.");
    }
    const version = runWranglerJson(
      ["versions", "view", versionId, ...common],
      "Account-deletion Worker version",
    );
    const liveSchedule = await readLiveSchedulerSchedule(targets);
    errors.push(
      ...validateLiveSchedulerManifestMatch(
        status,
        version,
        liveSchedule,
        {
          targets,
          manifest: schedulerManifest,
        },
      ),
    );
    if (schedulerManifest.deploymentMessage !== schedulerArtifact.message) {
      errors.push(
        "Active account-deletion Worker manifest does not match the local dry-run artifact.",
      );
    }
    const rollbackVersion = runWranglerJson(
      [
        "versions",
        "view",
        schedulerManifest.approvedPrevious.versionId,
        ...common,
      ],
      "Account-deletion Worker rollback version",
    );
    errors.push(
      ...validateApprovedPreviousSchedulerVersion(rollbackVersion, {
        targets,
        approvedPrevious: schedulerManifest.approvedPrevious,
      }),
    );
    if (errors.length === 0) {
      notes.push(
        "Active account-deletion Worker, approved rollback version, and exact live Cron match the reviewed manifests.",
      );
    }
  } catch (error) {
    errors.push(
      `Account-deletion Worker verification failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { errors, notes };
}

export async function runRemoteSchedulerBootstrapChecks(targets) {
  const errors = [];
  const notes = [];
  const scheduler = targets.accountDeletionScheduler;
  try {
    const common = [
      "--name",
      scheduler.workerName,
      "--config",
      resolve(PROJECT_ROOT, scheduler.config),
      "--json",
    ];
    const status = runWranglerJson(
      ["deployments", "status", ...common],
      "Account-deletion Worker bootstrap deployment",
    );
    const versionId = status?.versions?.[0]?.version_id;
    if (!UUID_PATTERN.test(versionId ?? "")) {
      throw new Error("Account-deletion Worker bootstrap version is unavailable.");
    }
    const version = runWranglerJson(
      ["versions", "view", versionId, ...common],
      "Account-deletion Worker bootstrap version",
    );
    const liveSchedule = await readLiveSchedulerSchedule(targets);
    errors.push(
      ...validateSchedulerBootstrapCandidate(
        status,
        version,
        liveSchedule,
        { targets },
      ),
    );
    if (errors.length === 0) {
      notes.push(
        "Legacy unannotated scheduler and exact live Cron are eligible for one-time provenance bootstrap.",
      );
    }
  } catch (error) {
    errors.push(
      `Account-deletion Worker bootstrap verification failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { errors, notes };
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

function printResult(
  result,
  {
    offline,
    rollbackProvisioning,
    schedulerProvisioning,
    schedulerBootstrapProvenance,
  },
) {
  for (const note of result.notes) console.log(`[OK] ${note}`);
  if (offline) {
    console.log(
      "[INFO] Remote Cloudflare checks and Worker dry-run were skipped; offline mode never authorizes a release.",
    );
  }
  if (rollbackProvisioning) {
    console.log(
      "[INFO] Rollback-provisioning mode authorizes only creation of the disabled rollback snapshot; it never authorizes normal production activation.",
    );
  }
  if (schedulerProvisioning) {
    console.log(
      schedulerBootstrapProvenance
        ? "[INFO] Scheduler bootstrap-provenance mode authorizes only the one-time adoption of the legacy unannotated rollback version and deployment of its annotated successor; it never authorizes Pages activation."
        : "[INFO] Scheduler-provisioning mode requires the current external Worker manifest and authorizes only deployment of its annotated successor; it never authorizes Pages activation.",
    );
  }
  for (const error of result.errors) console.error(`[BLOCKED] ${error}`);
}

async function main() {
  const offline = process.argv.includes("--offline");
  const rollbackProvisioning = process.argv.includes(
    "--provision-disabled-rollback",
  );
  const schedulerProvisioning = process.argv.includes(
    "--provision-account-deletion-scheduler",
  );
  const schedulerBootstrapProvenance = process.argv.includes(
    "--bootstrap-previous-provenance",
  );
  const pagesArtifactManifestPath =
    process.env.TORUDAKE_PAGES_ARTIFACT_MANIFEST;
  const local = runLocalChecks({
    requirePagesArtifactManifest: !schedulerProvisioning,
    pagesArtifactManifestPath,
    requireRollbackManifest:
      !offline && !rollbackProvisioning && !schedulerProvisioning,
    rollbackManifestPath: process.env.TORUDAKE_ROLLBACK_MANIFEST,
    requireSchedulerManifest:
      !offline && (!schedulerProvisioning || !schedulerBootstrapProvenance),
    schedulerManifestPath:
      process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST,
  });
  const modeCount = [offline, rollbackProvisioning, schedulerProvisioning].filter(
    Boolean,
  ).length;
  if (modeCount > 1) {
    local.errors.push(
      "Offline, rollback-provisioning, and scheduler-provisioning modes are mutually exclusive.",
    );
  }
  if (schedulerBootstrapProvenance && !schedulerProvisioning) {
    local.errors.push(
      "Scheduler provenance bootstrap is valid only with --provision-account-deletion-scheduler.",
    );
  }
  if (
    schedulerBootstrapProvenance &&
    typeof process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST ===
      "string" &&
    process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST.trim()
  ) {
    local.errors.push(
      "Scheduler provenance bootstrap requires the prior manifest environment variable to be unset.",
    );
  }
  if (
    rollbackProvisioning &&
    argumentValue("--confirm") !==
      local.targets.rollbackPolicy.provisioningConfirmation
  ) {
    local.errors.push(
      `Rollback provisioning requires --confirm ${local.targets.rollbackPolicy.provisioningConfirmation}.`,
    );
  }
  if (
    schedulerProvisioning &&
    argumentValue("--confirm") !==
      (schedulerBootstrapProvenance
        ? local.targets.accountDeletionScheduler.bootstrapProvenanceConfirmation
        : local.targets.accountDeletionScheduler.provisioningConfirmation)
  ) {
    local.errors.push(
      `Scheduler provisioning requires --confirm ${
        schedulerBootstrapProvenance
          ? local.targets.accountDeletionScheduler.bootstrapProvenanceConfirmation
          : local.targets.accountDeletionScheduler.provisioningConfirmation
      }.`,
    );
  }

  if (local.pagesArtifactManifest) {
    try {
      await verifyPagesArtifactManifest(local.pagesArtifactManifest, {
        projectRoot: PROJECT_ROOT,
        expectedSourceCommit: local.sourceCommit,
      });
      local.notes.push(
        "Pages deployment directory matches every file in its reviewed external manifest.",
      );
    } catch (error) {
      local.errors.push(
        `Pages artifact verification failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const remote = { errors: [], notes: [] };
  if (!offline) {
    const environmentErrors = [];
    checkDDriveEnvironment(environmentErrors);
    remote.errors.push(...environmentErrors);
    if (environmentErrors.length === 0) {
      const d1 = runRemoteD1Checks(local.targets, local.migrations);
      remote.errors.push(...d1.errors);
      remote.notes.push(...d1.notes);

      let schedulerArtifact = null;
      try {
        schedulerArtifact = buildSchedulerDryRun(
          local.targets,
          local.sourceCommit,
        );
        remote.notes.push(
          "Account-deletion Worker passed Wrangler dry-run and has a deterministic bundle hash.",
        );
        if (schedulerProvisioning) {
          remote.notes.push(
            `Required Worker deployment message: ${schedulerArtifact.message}`,
          );
        }
      } catch (error) {
        remote.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }

      if (schedulerArtifact && schedulerProvisioning) {
        if (schedulerBootstrapProvenance) {
          const bootstrap = await runRemoteSchedulerBootstrapChecks(
            local.targets,
          );
          remote.errors.push(...bootstrap.errors);
          remote.notes.push(...bootstrap.notes);
        } else if (local.schedulerManifest) {
          const storedValidation = validateStoredSchedulerManifest(
            local.schedulerManifest,
            { targets: local.targets },
          );
          remote.errors.push(...storedValidation.errors);
          if (storedValidation.valid) {
            const scheduler = await runRemoteSchedulerChecks(
              local.targets,
              { message: local.schedulerManifest.deploymentMessage },
              local.schedulerManifest,
            );
            remote.errors.push(...scheduler.errors);
            remote.notes.push(...scheduler.notes);
          }
        }
      } else if (schedulerArtifact && !schedulerProvisioning) {
        if (local.schedulerManifest) {
          const manifestValidation = validateSchedulerManifest(
            local.schedulerManifest,
            {
              targets: local.targets,
              sourceCommit: local.sourceCommit,
              schedulerArtifact,
            },
          );
          remote.errors.push(...manifestValidation.errors);
          if (manifestValidation.valid) {
            const scheduler = await runRemoteSchedulerChecks(
              local.targets,
              schedulerArtifact,
              local.schedulerManifest,
            );
            remote.errors.push(...scheduler.errors);
            remote.notes.push(...scheduler.notes);
          }
        }
      }

      if (
        !rollbackProvisioning &&
        !schedulerProvisioning &&
        local.rollbackManifest
      ) {
        const pages = await runRemotePagesRollbackChecks(
          local.targets,
          local.rollbackManifest,
          local.sourceCommit,
          local.pagesArtifactManifest,
        );
        remote.errors.push(...pages.errors);
        remote.notes.push(...pages.notes);
      }
    }
  }
  const result = {
    errors: [...local.errors, ...remote.errors],
    notes: [...local.notes, ...remote.notes],
  };
  printResult(result, {
    offline,
    rollbackProvisioning,
    schedulerProvisioning,
    schedulerBootstrapProvenance,
  });
  process.exitCode = result.errors.length === 0 ? 0 : 1;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === SCRIPT_PATH.toLowerCase()
) {
  await main();
}
