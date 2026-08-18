#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { readBoundedJsonFileSync } from "../../lib/bounded-json-file.mjs";

import {
  PROJECT_ROOT,
  assertSchedulerBundleIntegrity,
  buildSchedulerDryRun,
  classifySchedulerRecoveryState,
  isDDrivePath,
  parseSchedulerReleaseArguments,
  readLiveSchedulerSchedule,
  runLocalChecks,
  validateApprovedPreviousSchedulerVersion,
  validateLiveSchedulerDeployment,
  validateLiveSchedulerManifestMatch,
  validateLiveSchedulerSchedule,
  validateSchedulerBootstrapCandidate,
  validateSchedulerManifest,
  validateStoredSchedulerManifest,
} from "../release-preflight.mjs";

const MAX_SCHEDULER_MANIFEST_BYTES = 1024 * 1024;

const releaseOptions = parseSchedulerReleaseArguments(process.argv.slice(2));
const {
  execute,
  bootstrapPreviousProvenance,
  confirmation,
  manifestPath: requestedManifestPath,
} = releaseOptions;
const targets = JSON.parse(
  readFileSync(resolve(PROJECT_ROOT, "config", "release-targets.json"), "utf8"),
);
const local = runLocalChecks({
  requireRollbackManifest: false,
  requireSchedulerManifest: execute && !bootstrapPreviousProvenance,
  schedulerManifestPath:
    process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST,
});
if (local.errors.length > 0) {
  throw new Error(`Scheduler release blocked: ${local.errors.join(" ")}`);
}
if (
  bootstrapPreviousProvenance &&
  typeof process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST ===
    "string" &&
  process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST.trim()
) {
  throw new Error(
    "Bootstrap provenance requires TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST to be unset.",
  );
}
const artifact = buildSchedulerDryRun(targets, local.sourceCommit);
const expectedConfirmation = bootstrapPreviousProvenance
  ? targets.accountDeletionScheduler.bootstrapProvenanceConfirmation
  : targets.accountDeletionScheduler.provisioningConfirmation;

if (!execute) {
  console.log(
    JSON.stringify({
      dryRun: true,
      sourceCommit: local.sourceCommit,
      bundleSha256: artifact.bundleSha256,
      deploymentMessage: artifact.message,
      bootstrapPreviousProvenance,
    }),
  );
} else if (confirmation !== expectedConfirmation) {
  throw new Error(
    `Deployment requires --execute --confirm ${expectedConfirmation}.`,
  );
} else {
  await uploadVerifyAndActivate(requestedManifestPath, {
    bootstrapPreviousProvenance,
  });
}

async function uploadVerifyAndActivate(
  manifestValue,
  { bootstrapPreviousProvenance },
) {
  const manifestPath = validateManifestPath(manifestValue);
  const pendingPath = `${manifestPath}.pending`;
  let pendingHandle = openSync(pendingPath, "wx", 0o600);
  let activationAttempted = false;
  let bundleSnapshot = null;
  let manifestFinalized = false;
  let triggerDeploymentAttempted = false;
  let previousVersionId = null;
  let uploadedVersionId = null;
  let uploadedScriptEtag = null;
  let uploadTag = null;
  let approvedPrevious = null;
  let ownedActivationDeploymentId = null;
  try {
    const preflightArguments = [
      resolve(PROJECT_ROOT, "scripts", "release-preflight.mjs"),
      "--provision-account-deletion-scheduler",
    ];
    if (bootstrapPreviousProvenance) {
      preflightArguments.push("--bootstrap-previous-provenance");
    }
    preflightArguments.push("--confirm", expectedConfirmation);
    const preflight = spawnSync(
      process.execPath,
      preflightArguments,
      { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
    );
    if (preflight.status !== 0) {
      throw new Error("Scheduler provisioning preflight did not pass.");
    }

    const previous = liveStatus();
    previousVersionId = previous?.versions?.[0]?.version_id;
    if (
      previous?.strategy !== "percentage" ||
      previous?.versions?.length !== 1 ||
      previous.versions[0]?.percentage !== 100 ||
      !isUuid(previousVersionId)
    ) {
      throw new Error(
        "Existing Worker must be one UUID version at 100% traffic before release.",
      );
    }
    const previousVersion = liveVersion(previousVersionId);
    const previousSchedule = await requireExactLiveSchedule({ attempts: 1 });
    if (bootstrapPreviousProvenance) {
      const bootstrapErrors = validateSchedulerBootstrapCandidate(
        previous,
        previousVersion,
        previousSchedule,
        { targets },
      );
      if (bootstrapErrors.length > 0) {
        throw new Error(
          `Legacy Worker is ineligible for provenance bootstrap: ${bootstrapErrors.join(" ")}`,
        );
      }
      approvedPrevious = {
        provenance: "bootstrap_confirmation",
        manifestSchemaVersion: null,
        manifestSha256: null,
        deploymentId: previous.id,
        versionId: previousVersionId,
        scriptEtag: previousVersion.resources.script.etag,
        sourceCommit: null,
        bundleSha256: null,
        deploymentMessage: null,
        uploadTag: null,
        deployedAt: previousVersion.metadata.created_on,
        schedule: {
          cron: targets.accountDeletionScheduler.cronSchedule,
          liveVerified: true,
        },
      };
    } else {
      const stored = readStoredSchedulerManifest();
      const storedValidation = validateStoredSchedulerManifest(stored.manifest, {
        targets,
      });
      const liveErrors = storedValidation.valid
        ? validateLiveSchedulerManifestMatch(
            previous,
            previousVersion,
            previousSchedule,
            { targets, manifest: stored.manifest },
          )
        : [];
      if (!storedValidation.valid || liveErrors.length > 0) {
        throw new Error(
          `Current Worker is not an approved previous release: ${[
            ...storedValidation.errors,
            ...liveErrors,
          ].join(" ")}`,
        );
      }
      approvedPrevious = {
        provenance: "external_manifest",
        manifestSchemaVersion: stored.manifest.schemaVersion,
        manifestSha256: stored.sha256,
        deploymentId: stored.manifest.activeDeploymentId,
        versionId: stored.manifest.activeVersionId,
        scriptEtag: stored.manifest.scriptEtag,
        sourceCommit: stored.manifest.sourceCommit,
        bundleSha256: stored.manifest.bundleSha256,
        deploymentMessage: stored.manifest.deploymentMessage,
        uploadTag: stored.manifest.uploadTag,
        deployedAt: stored.manifest.deployedAt,
        schedule: stored.manifest.schedule,
      };
    }

    bundleSnapshot = createBundleSnapshot(
      artifact.bundleBytes,
      artifact.bundleSha256,
    );
    uploadTag =
      `torudake-${local.sourceCommit.slice(0, 12).toLowerCase()}-` +
      `${artifact.bundleSha256.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    assertBundleSnapshot(bundleSnapshot, artifact.bundleSha256);
    const upload = spawnSync(
      process.execPath,
      [
        wranglerPath(),
        "versions",
        "upload",
        bundleSnapshot.path,
        "--no-bundle",
        ...wranglerTargetArguments(),
        "--message",
        artifact.message,
        "--tag",
        uploadTag,
        "--strict",
      ],
      { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
    );
    assertBundleSnapshot(bundleSnapshot, artifact.bundleSha256);
    if (upload.status !== 0) {
      throw new Error("Account-deletion Worker version upload failed.");
    }

    const versions = wranglerJson([
      "versions",
      "list",
      ...wranglerTargetArguments(),
      "--json",
    ]);
    const uploaded = Array.isArray(versions)
      ? versions.find(
          (version) => version?.annotations?.["workers/tag"] === uploadTag,
        )
      : null;
    if (!isUuid(uploaded?.id)) {
      throw new Error("Uploaded Worker version could not be read back by tag.");
    }
    uploadedVersionId = uploaded.id;
    const postUploadLocal = runLocalChecks({
      requireRollbackManifest: false,
      requireSchedulerManifest: !bootstrapPreviousProvenance,
      schedulerManifestPath:
        process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST,
    });
    if (
      postUploadLocal.errors.length > 0 ||
      postUploadLocal.sourceCommit !== local.sourceCommit
    ) {
      throw new Error("Local release changed while the Worker version was uploading.");
    }
    const postUploadArtifact = buildSchedulerDryRun(
      targets,
      postUploadLocal.sourceCommit,
    );
    if (
      postUploadArtifact.bundleSha256 !== artifact.bundleSha256 ||
      postUploadArtifact.message !== artifact.message ||
      !artifact.bundleBytes.equals(postUploadArtifact.bundleBytes)
    ) {
      throw new Error("Worker dry-run artifact changed during version upload.");
    }
    cleanupBundleSnapshot(bundleSnapshot);
    bundleSnapshot = null;
    if (
      !bootstrapPreviousProvenance &&
      readStoredSchedulerManifest().sha256 !== approvedPrevious.manifestSha256
    ) {
      throw new Error(
        "Approved previous Worker manifest changed during version upload.",
      );
    }
    const uploadedVersion = liveVersion(uploaded.id);
    const stagedStatus = {
      id: previous.id,
      strategy: "percentage",
      versions: [{ version_id: uploaded.id, percentage: 100 }],
    };
    const stagedErrors = validateLiveSchedulerDeployment(
      stagedStatus,
      uploadedVersion,
      { targets, expectedMessage: artifact.message },
    );
    if (
      stagedErrors.length > 0 ||
      uploadedVersion.annotations?.["workers/tag"] !== uploadTag
    ) {
      throw new Error(
        `Uploaded Worker failed pre-activation verification: ${stagedErrors.join(" ") || "upload tag mismatch"}`,
      );
    }
    uploadedScriptEtag = uploadedVersion.resources.script.etag;

    triggerDeploymentAttempted = true;
    const triggerDeployment = spawnSync(
      process.execPath,
      [
        wranglerPath(),
        "triggers",
        "deploy",
        ...wranglerTargetArguments(),
      ],
      { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
    );
    if (triggerDeployment.status !== 0) {
      throw new Error("Account-deletion Worker Cron deployment failed.");
    }
    await requireExactLiveSchedule({ attempts: 5 });
    const preActivation = liveStatus();
    if (
      preActivation?.id !== previous.id ||
      preActivation?.strategy !== "percentage" ||
      preActivation?.versions?.length !== 1 ||
      preActivation.versions[0]?.version_id !== previousVersionId ||
      preActivation.versions[0]?.percentage !== 100
    ) {
      throw new Error(
        "Active Worker changed after provenance approval and before activation.",
      );
    }

    activationAttempted = true;
    const activation = spawnSync(
      process.execPath,
      [
        wranglerPath(),
        "versions",
        "deploy",
        `${uploaded.id}@100%`,
        ...wranglerTargetArguments(),
        "--message",
        `activate ${artifact.message}`,
        "--yes",
      ],
      { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
    );
    if (activation.status !== 0) {
      throw new Error("Account-deletion Worker activation failed.");
    }

    const activeState = await requireOwnedActiveDeployment({
      previousDeploymentId: previous.id,
      uploadedVersionId,
      expectedMessage: artifact.message,
      expectedUploadTag: uploadTag,
    });
    const active = activeState.status;
    const activeVersion = activeState.version;
    ownedActivationDeploymentId = active.id;

    const manifest = {
      schemaVersion: targets.accountDeletionScheduler.manifestSchemaVersion,
      workerName: targets.accountDeletionScheduler.workerName,
      sourceCommit: local.sourceCommit.toLowerCase(),
      bundleSha256: artifact.bundleSha256,
      deploymentMessage: artifact.message,
      uploadTag,
      activeDeploymentId: active.id,
      activeVersionId: uploaded.id,
      previousVersionId,
      scriptEtag: activeVersion.resources.script.etag,
      deployedAt: activeVersion.metadata.created_on,
      schedule: {
        cron: targets.accountDeletionScheduler.cronSchedule,
        liveVerified: true,
      },
      approvedPrevious,
      verification: {
        wranglerDryRunPassed: true,
        activeTrafficPercentage: 100,
        liveVersionReadBack: true,
      },
    };
    const manifestValidation = validateSchedulerManifest(manifest, {
      targets,
      sourceCommit: local.sourceCommit,
      schedulerArtifact: artifact,
    });
    if (!manifestValidation.valid) {
      throw new Error(
        `Worker manifest failed its release schema: ${manifestValidation.errors.join(" ")}`,
      );
    }
    const manifestPayload = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    if (manifestPayload.byteLength > MAX_SCHEDULER_MANIFEST_BYTES) {
      throw new Error("Worker manifest exceeds its release size limit.");
    }
    writeFileSync(pendingHandle, manifestPayload, {
      encoding: "utf8",
    });
    fsyncSync(pendingHandle);
    closeSync(pendingHandle);
    pendingHandle = null;
    await requireOwnedActiveDeployment({
      previousDeploymentId: previous.id,
      uploadedVersionId,
      expectedDeploymentId: active.id,
      expectedMessage: artifact.message,
      expectedUploadTag: uploadTag,
      expectedScriptEtag: activeVersion.resources.script.etag,
    });
    if (validateManifestPath(manifestPath) !== manifestPath) {
      throw new Error("Worker manifest path changed before finalization.");
    }
    linkSync(pendingPath, manifestPath);
    manifestFinalized = true;
    unlinkSync(pendingPath);
    const recordedManifest = readBoundedJsonFileSync(manifestPath, {
      maxBytes: MAX_SCHEDULER_MANIFEST_BYTES,
    });
    if (!recordedManifest.bytes.equals(manifestPayload)) {
      throw new Error("Worker manifest failed exact-byte finalization.");
    }
    await requireOwnedActiveDeployment({
      previousDeploymentId: previous.id,
      uploadedVersionId,
      expectedDeploymentId: active.id,
      expectedMessage: artifact.message,
      expectedUploadTag: uploadTag,
      expectedScriptEtag: activeVersion.resources.script.etag,
    });
    console.log(`Worker manifest written to ${manifestPath}`);
  } catch (error) {
    let manifestCleanupError = null;
    if (manifestFinalized) {
      try {
        unlinkSync(manifestPath);
        manifestFinalized = false;
      } catch (cleanupError) {
        manifestCleanupError = cleanupError;
      }
    }
    if (triggerDeploymentAttempted) {
      try {
        await recoverFailedSchedulerRelease({
          activationAttempted,
          previousVersionId,
          uploadedVersionId,
          uploadedScriptEtag,
          uploadTag,
          approvedPrevious,
          ownedActivationDeploymentId,
        });
      } catch (rollbackError) {
        throw new Error(
          `Worker release failed and ownership-safe automatic recovery could not be verified: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}${
            manifestCleanupError
              ? ` Finalized manifest cleanup also failed: ${manifestCleanupError instanceof Error ? manifestCleanupError.message : String(manifestCleanupError)}`
              : ""
          }`,
          { cause: error },
        );
      }
    }
    if (manifestCleanupError) {
      throw new Error(
        `Worker release failed and its finalized manifest could not be removed: ${manifestCleanupError instanceof Error ? manifestCleanupError.message : String(manifestCleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (bundleSnapshot !== null) {
      try {
        cleanupBundleSnapshot(bundleSnapshot);
      } catch (cleanupError) {
        console.error(
          `Unable to remove the private scheduler bundle snapshot: ${
            cleanupError instanceof Error ? cleanupError.message : "unknown error"
          }`,
        );
      }
    }
    if (pendingHandle !== null) closeSync(pendingHandle);
    if (existsSync(pendingPath)) unlinkSync(pendingPath);
  }
}

function createBundleSnapshot(bundleBytes, expectedSha256) {
  assertSchedulerBundleIntegrity(bundleBytes, expectedSha256);
  const tempRoot = resolve(process.env.TEMP ?? "");
  if (!isDDrivePath(tempRoot) || !existsSync(tempRoot)) {
    throw new Error(
      "Scheduler upload snapshot requires an existing D-drive TEMP directory.",
    );
  }
  const directory = mkdtempSync(join(tempRoot, "torudake-scheduler-upload-"));
  const path = resolve(directory, "account-deletion-scheduler.mjs");
  let handle = null;
  try {
    handle = openSync(path, "wx", 0o600);
    writeFileSync(handle, bundleBytes);
    fsyncSync(handle);
    closeSync(handle);
    handle = null;
    const snapshot = { directory, path, tempRoot };
    assertBundleSnapshot(snapshot, expectedSha256);
    return snapshot;
  } catch (error) {
    if (handle !== null) closeSync(handle);
    const snapshot = { directory, path, tempRoot };
    try {
      cleanupBundleSnapshot(snapshot);
    } catch {
      // Preserve the original snapshot creation error.
    }
    throw error;
  }
}

function assertBundleSnapshot(snapshot, expectedSha256) {
  validateBundleSnapshotLocation(snapshot);
  return assertSchedulerBundleIntegrity(
    readFileSync(snapshot.path),
    expectedSha256,
  );
}

function cleanupBundleSnapshot(snapshot) {
  validateBundleSnapshotLocation(snapshot);
  rmSync(snapshot.directory, { recursive: true, force: true });
}

function validateBundleSnapshotLocation(snapshot) {
  const directory = resolve(snapshot?.directory ?? "");
  const tempRoot = resolve(snapshot?.tempRoot ?? "");
  const path = resolve(snapshot?.path ?? "");
  const relativeDirectory = relative(tempRoot, directory);
  if (
    !isDDrivePath(tempRoot) ||
    !relativeDirectory ||
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    !basename(directory).startsWith("torudake-scheduler-upload-") ||
    dirname(path) !== directory ||
    basename(path) !== "account-deletion-scheduler.mjs"
  ) {
    throw new Error("Scheduler bundle snapshot path is unsafe.");
  }
}

async function requireOwnedActiveDeployment({
  previousDeploymentId,
  uploadedVersionId,
  expectedDeploymentId,
  expectedMessage,
  expectedUploadTag,
  expectedScriptEtag,
}) {
  const initialStatus = liveStatus();
  const version = liveVersion(uploadedVersionId);
  await requireExactLiveSchedule({ attempts: 3 });
  const finalStatus = liveStatus();
  const errors = [initialStatus, finalStatus].flatMap((status) =>
    validateLiveSchedulerDeployment(status, version, {
      targets,
      expectedMessage,
    }),
  );
  if (
    errors.length > 0 ||
    initialStatus.id === previousDeploymentId ||
    finalStatus.id !== initialStatus.id ||
    (expectedDeploymentId !== undefined &&
      finalStatus.id !== expectedDeploymentId) ||
    finalStatus.versions?.length !== 1 ||
    finalStatus.versions[0]?.version_id !== uploadedVersionId ||
    finalStatus.versions[0]?.percentage !== 100 ||
    version.annotations?.["workers/tag"] !== expectedUploadTag ||
    (expectedScriptEtag !== undefined &&
      version.resources?.script?.etag !== expectedScriptEtag)
  ) {
    throw new Error(
      `Activated Worker failed ownership and live verification: ${errors.join(" ") || "deployment, version, ETag, or tag mismatch"}`,
    );
  }
  return { status: finalStatus, version };
}

async function recoverFailedSchedulerRelease({
  activationAttempted,
  previousVersionId,
  uploadedVersionId,
  uploadedScriptEtag,
  uploadTag,
  approvedPrevious,
  ownedActivationDeploymentId,
}) {
  const current = liveStatus();
  const recoveryState = classifySchedulerRecoveryState(current, {
    previousVersionId,
    uploadedVersionId,
  });
  if (recoveryState === "previous_active") {
    if (current.id !== approvedPrevious?.deploymentId) {
      throw new Error(
        "The previous version is active under a foreign deployment; automatic Cron recovery was prohibited.",
      );
    }
    const guardPreviousDeployment = ({ requireExactSchedule }) =>
      requireApprovedPreviousActiveDeployment({
        previousVersionId,
        uploadedVersionId,
        approvedPrevious,
        expectedDeploymentId: current.id,
        requireExactSchedule,
      });
    await restoreConfiguredSchedule({
      beforeMutation: () =>
        guardPreviousDeployment({ requireExactSchedule: false }),
      afterMutation: () =>
        guardPreviousDeployment({ requireExactSchedule: true }),
    });
    return;
  }
  if (activationAttempted && recoveryState === "owned_activation") {
    await restorePreviousVersion(previousVersionId, approvedPrevious, {
      uploadedVersionId,
      uploadedScriptEtag,
      uploadTag,
      expectedActiveDeploymentId:
        ownedActivationDeploymentId ?? current.id,
    });
    return;
  }
  throw new Error(
    "A foreign or ambiguous active Worker was detected; automatic version and Cron rollback were prohibited.",
  );
}

async function requireOwnedRecoveryActivation({
  previousVersionId,
  uploadedVersionId,
  uploadedScriptEtag,
  uploadTag,
  approvedPrevious,
  expectedDeploymentId,
}) {
  const initialStatus = liveStatus();
  const previousVersion = liveVersion(previousVersionId);
  const uploadedVersion = liveVersion(uploadedVersionId);
  await readLiveSchedulerSchedule(targets);
  const finalStatus = liveStatus();
  const previousErrors = validateApprovedPreviousSchedulerVersion(
    previousVersion,
    { targets, approvedPrevious },
  );
  const uploadedErrors = validateLiveSchedulerDeployment(
    {
      id: finalStatus.id,
      strategy: "percentage",
      versions: [{ version_id: uploadedVersionId, percentage: 100 }],
    },
    uploadedVersion,
    { targets, expectedMessage: artifact.message },
  );
  if (
    classifySchedulerRecoveryState(initialStatus, {
      previousVersionId,
      uploadedVersionId,
    }) !== "owned_activation" ||
    classifySchedulerRecoveryState(finalStatus, {
      previousVersionId,
      uploadedVersionId,
    }) !== "owned_activation" ||
    initialStatus.id !== expectedDeploymentId ||
    finalStatus.id !== expectedDeploymentId ||
    previousErrors.length > 0 ||
    uploadedErrors.length > 0 ||
    uploadedVersion.resources?.script?.etag !== uploadedScriptEtag ||
    uploadedVersion.annotations?.["workers/tag"] !== uploadTag
  ) {
    throw new Error(
      `The active uploaded Worker no longer matches this release immediately before rollback: ${[
        ...previousErrors,
        ...uploadedErrors,
      ].join(" ") || "active set, deployment, ETag, or tag mismatch"}`,
    );
  }
}

async function requireApprovedPreviousActiveDeployment({
  previousVersionId,
  uploadedVersionId,
  approvedPrevious,
  expectedDeploymentId,
  requireExactSchedule,
}) {
  const initialStatus = liveStatus();
  const previousVersion = liveVersion(previousVersionId);
  const schedule = await readLiveSchedulerSchedule(targets);
  const finalStatus = liveStatus();
  const provenanceErrors = validateApprovedPreviousSchedulerVersion(
    previousVersion,
    { targets, approvedPrevious },
  );
  const scheduleErrors = requireExactSchedule
    ? validateLiveSchedulerSchedule(schedule, { targets })
    : [];
  if (
    classifySchedulerRecoveryState(initialStatus, {
      previousVersionId,
      uploadedVersionId,
    }) !== "previous_active" ||
    classifySchedulerRecoveryState(finalStatus, {
      previousVersionId,
      uploadedVersionId,
    }) !== "previous_active" ||
    initialStatus.id !== expectedDeploymentId ||
    finalStatus.id !== expectedDeploymentId ||
    provenanceErrors.length > 0 ||
    scheduleErrors.length > 0
  ) {
    throw new Error(
      `Approved previous Worker changed while Cron recovery was being verified: ${[
        ...provenanceErrors,
        ...scheduleErrors,
      ].join(" ") || "active deployment mismatch"}`,
    );
  }
}

async function restorePreviousVersion(
  previousVersionId,
  approvedPrevious,
  {
    uploadedVersionId,
    uploadedScriptEtag,
    uploadTag,
    expectedActiveDeploymentId,
  },
) {
  await requireOwnedRecoveryActivation({
    previousVersionId,
    uploadedVersionId,
    uploadedScriptEtag,
    uploadTag,
    approvedPrevious,
    expectedDeploymentId: expectedActiveDeploymentId,
  });
  const rollback = spawnSync(
    process.execPath,
    [
      wranglerPath(),
      "versions",
      "deploy",
      `${previousVersionId}@100%`,
      ...wranglerTargetArguments(),
      "--message",
      "automatic rollback after failed account-deletion Worker release",
      "--yes",
    ],
    { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
  );
  if (rollback.status !== 0) {
    throw new Error("Wrangler rollback command failed.");
  }
  const restored = liveStatus();
  if (
    classifySchedulerRecoveryState(restored, {
      previousVersionId,
      uploadedVersionId: null,
    }) !== "previous_active"
  ) {
    throw new Error("Previous Worker version was not restored at 100% traffic.");
  }
  const restoredVersion = liveVersion(previousVersionId);
  const provenanceErrors = validateApprovedPreviousSchedulerVersion(
    restoredVersion,
    { targets, approvedPrevious },
  );
  if (provenanceErrors.length > 0) {
    throw new Error(provenanceErrors.join(" "));
  }
  const guardRestoredDeployment = ({ requireExactSchedule }) =>
    requireApprovedPreviousActiveDeployment({
      previousVersionId,
      uploadedVersionId: null,
      approvedPrevious,
      expectedDeploymentId: restored.id,
      requireExactSchedule,
    });
  await restoreConfiguredSchedule({
    beforeMutation: () =>
      guardRestoredDeployment({ requireExactSchedule: false }),
    afterMutation: () =>
      guardRestoredDeployment({ requireExactSchedule: true }),
  });
}

async function restoreConfiguredSchedule({ beforeMutation, afterMutation }) {
  await beforeMutation();
  const triggerRollback = spawnSync(
    process.execPath,
    [wranglerPath(), "triggers", "deploy", ...wranglerTargetArguments()],
    { cwd: PROJECT_ROOT, stdio: "inherit", windowsHide: true },
  );
  if (triggerRollback.status !== 0) {
    throw new Error("Wrangler Cron restoration command failed.");
  }
  await requireExactLiveSchedule({ attempts: 5 });
  await afterMutation();
}

async function requireExactLiveSchedule({ attempts }) {
  let lastError = "Cloudflare Worker Cron could not be read.";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const schedule = await readLiveSchedulerSchedule(targets);
      const errors = validateLiveSchedulerSchedule(schedule, { targets });
      if (errors.length === 0) return schedule;
      lastError = errors.join(" ");
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) await delay(2_000);
  }
  throw new Error(`Live Cron verification failed closed: ${lastError}`);
}

function readStoredSchedulerManifest() {
  const path = validateStoredManifestPath(
    process.env.TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST,
  );
  let read;
  try {
    read = readBoundedJsonFileSync(path, {
      maxBytes: MAX_SCHEDULER_MANIFEST_BYTES,
    });
  } catch {
    throw new Error(
      "Approved previous Worker manifest could not be read safely or is not valid JSON.",
    );
  }
  return {
    manifest: read.value,
    sha256: createHash("sha256").update(read.bytes).digest("hex"),
  };
}

function wranglerPath() {
  return resolve(
    PROJECT_ROOT,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
}

function wranglerTargetArguments() {
  return [
    "--name",
    targets.accountDeletionScheduler.workerName,
    "--config",
    resolve(PROJECT_ROOT, targets.accountDeletionScheduler.config),
  ];
}

function wranglerJson(args) {
  const result = spawnSync(process.execPath, [wranglerPath(), ...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error("Unable to read back the account-deletion Worker.");
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("Account-deletion Worker read-back returned invalid JSON.");
  }
}

function liveStatus() {
  return wranglerJson([
    "deployments",
    "status",
    ...wranglerTargetArguments(),
    "--json",
  ]);
}

function liveVersion(versionId) {
  return wranglerJson([
    "versions",
    "view",
    versionId,
    ...wranglerTargetArguments(),
    "--json",
  ]);
}

function validateManifestPath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error("--manifest must be an absolute path outside the repository.");
  }
  const path = resolve(value);
  const repositoryRelativePath = relative(PROJECT_ROOT, path);
  if (
    !isDDrivePath(path) ||
    repositoryRelativePath === "" ||
    (!repositoryRelativePath.startsWith("..") &&
      !isAbsolute(repositoryRelativePath)) ||
    !existsSync(dirname(path)) ||
    existsSync(path)
  ) {
    throw new Error(
      "Worker manifest must be a new file in an existing D-drive directory outside the repository.",
    );
  }
  validateExternalManifestParent(path);
  return path;
}

function validateStoredManifestPath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(
      "TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST must be an absolute path.",
    );
  }
  const path = resolve(value);
  const repositoryRelativePath = relative(PROJECT_ROOT, path);
  if (
    !isDDrivePath(path) ||
    repositoryRelativePath === "" ||
    (!repositoryRelativePath.startsWith("..") &&
      !isAbsolute(repositoryRelativePath)) ||
    !existsSync(path)
  ) {
    throw new Error(
      "Approved previous Worker manifest must be an existing D-drive file outside the repository.",
    );
  }
  validateExternalManifestParent(path);
  return path;
}

function validateExternalManifestParent(path) {
  const parent = dirname(path);
  let cursor = parent;
  while (true) {
    const stats = lstatSync(cursor, { bigint: true });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        "Worker manifest path must not traverse a link or reparse point.",
      );
    }
    const next = dirname(cursor);
    if (next === cursor) break;
    cursor = next;
  }
  const realParent = realpathSync(parent);
  const realProjectRoot = realpathSync(PROJECT_ROOT);
  const realRepositoryRelativePath = relative(realProjectRoot, realParent);
  if (
    !isDDrivePath(realParent) ||
    realRepositoryRelativePath === "" ||
    (!realRepositoryRelativePath.startsWith("..") &&
      !isAbsolute(realRepositoryRelativePath))
  ) {
    throw new Error(
      "Worker manifest parent must resolve to a D-drive directory outside the repository.",
    );
  }
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
