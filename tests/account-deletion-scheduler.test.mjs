import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  executeDueAccountDeletions,
  isValidAccountDeletionExecutionResult,
} from "../workers/account-deletion-scheduler.mjs";

const SECRET = "scheduler-secret-that-is-at-least-thirty-two-characters";
const ACCOUNT_REFERENCE = "a".repeat(24);

function validExecutionBody(overrides = {}) {
  return {
    dryRun: false,
    limit: 5,
    requestId: "scheduler-request-0001",
    scanned: 1,
    ready: 0,
    completed: 1,
    blocked: 0,
    failed: 0,
    skipped: 0,
    results: [
      {
        accountReference: ACCOUNT_REFERENCE,
        outcome: "completed",
        reasonCode: null,
      },
    ],
    challengeRetention: {
      status: "purged",
      accountAuthChallenges: 1,
      accountEmailChallenges: 2,
      accountOauthChallenges: 3,
      accountRecoveryChallenges: 4,
      total: 10,
      batches: 1,
      hasMore: false,
    },
    ...overrides,
  };
}

test("scheduled executor uses the dedicated secret and both confirmations", async () => {
  let captured;
  const result = await executeDueAccountDeletions(
    { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
    async (url, init) => {
      captured = { url, init };
      return Response.json(validExecutionBody());
    },
  );

  assert.equal(result.completed, 1);
  assert.equal(
    captured.url,
    "https://torudake-reel.pages.dev/api/internal/account-deletions",
  );
  assert.equal(captured.init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(
    captured.init.headers["X-Operations-Confirm"],
    "execute-due-account-deletions",
  );
  assert.deepEqual(JSON.parse(captured.init.body), {
    dryRun: false,
    limit: 5,
    confirmation: "execute-due-account-deletions",
  });
  assert.equal(result.challengeRetention.total, 10);
});

test("scheduled executor fails closed on missing secret and reported failures", async () => {
  await assert.rejects(
    executeDueAccountDeletions({}, async () => {
      throw new Error("fetch must not run");
    }),
    /secret is unavailable/,
  );
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () =>
        Response.json(
          validExecutionBody({
            requestId: "scheduler-request-0002",
            completed: 0,
            failed: 1,
            results: [
              {
                accountReference: ACCOUNT_REFERENCE,
                outcome: "failed",
                reasonCode: "media_deletion_failed",
              },
            ],
          }),
        ),
    ),
    /reported failures/,
  );
});

test("scheduler retries for failed or incomplete challenge retention", async () => {
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () =>
        Response.json(
          validExecutionBody({
            requestId: "scheduler-request-0003",
            scanned: 0,
            completed: 0,
            results: [],
            challengeRetention: {
              status: "failed",
              reason: "challenge_retention_failed",
            },
          }),
        ),
    ),
    /challenge retention failed/,
  );

  const backlogged = validExecutionBody();
  backlogged.challengeRetention.hasMore = true;
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () => Response.json(backlogged),
    ),
    /retention remains backlogged/,
  );
});

test("scheduler rejects missing base schema and request ID", async () => {
  const missingRetention = validExecutionBody();
  delete missingRetention.challengeRetention;
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () => Response.json(missingRetention),
    ),
    /scheduler failed/,
  );

  const missingReady = validExecutionBody();
  delete missingReady.ready;
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () => Response.json(missingReady),
    ),
    /scheduler failed/,
  );

  const missingRequestId = validExecutionBody();
  delete missingRequestId.requestId;
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () => Response.json(missingRequestId),
    ),
    /scheduler failed.*requestId=missing/,
  );
});

test("manual and scheduled operations share strict count and mode invariants", async () => {
  const dryRun = {
    dryRun: true,
    limit: 5,
    requestId: "manual-request-0001",
    scanned: 0,
    ready: 0,
    completed: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    results: [],
    challengeRetention: { status: "skipped", reason: "dry_run" },
  };
  assert.equal(
    isValidAccountDeletionExecutionResult(dryRun, {
      expectedDryRun: true,
      expectedLimit: 5,
    }),
    true,
  );

  const invalidBodies = [
    { ...validExecutionBody(), limit: 6 },
    { ...validExecutionBody(), scanned: 0 },
    { ...validExecutionBody(), ready: 1, completed: 0 },
    { ...validExecutionBody(), results: [] },
    {
      ...validExecutionBody(),
      results: [
        {
          accountReference: ACCOUNT_REFERENCE,
          outcome: "failed",
          reasonCode: "failed",
        },
      ],
    },
    { ...dryRun, completed: 1, scanned: 1 },
  ];
  for (const body of invalidBodies) {
    assert.equal(
      isValidAccountDeletionExecutionResult(body, {
        expectedDryRun: body.dryRun,
        expectedLimit: 5,
      }),
      false,
    );
  }

  const unexpectedRetention = validExecutionBody();
  unexpectedRetention.challengeRetention.unexpected = "field";
  assert.equal(
    isValidAccountDeletionExecutionResult(unexpectedRetention, {
      expectedDryRun: false,
      expectedLimit: 5,
    }),
    false,
  );

  const manualSource = await readFile(
    new URL("../scripts/operations/account-deletions.mjs", import.meta.url),
    "utf8",
  );
  assert.match(manualSource, /readBoundedJsonResponse\(/);
  assert.match(manualSource, /isValidAccountDeletionExecutionResult\(/);
});

test("scheduler bounds a successful HTTP response before JSON parsing", async () => {
  await assert.rejects(
    executeDueAccountDeletions(
      { ACCOUNT_DELETION_OPERATIONS_SECRET: SECRET },
      async () =>
        new Response(`{"padding":"${"x".repeat(70 * 1024)}"}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ),
    /scheduler failed/,
  );
});

test("scheduler config is private, daily, bounded, observable, and release-gated", async () => {
  const config = JSON.parse(
    await readFile(
      new URL("../wrangler.account-deletion-scheduler.jsonc", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.triggers.crons, ["15 18 * * *"]);
  assert.equal(config.vars.ACCOUNT_DELETION_BATCH_LIMIT, "5");
  assert.equal(config.observability.logs.persist, true);
  assert.equal(
    Object.hasOwn(config.vars, "ACCOUNT_DELETION_OPERATIONS_SECRET"),
    false,
  );
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(
    packageJson.scripts["ops:dry-run-account-deletion-scheduler"],
    /--dry-run/,
  );
  assert.match(
    packageJson.scripts["ops:deploy-account-deletion-scheduler"],
    /deploy-account-deletion-scheduler\.mjs/,
  );
  const deploySource = await readFile(
    new URL(
      "../scripts/operations/deploy-account-deletion-scheduler.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const uploadIndex = deploySource.indexOf('"upload"');
  const snapshotCreationIndex = deploySource.indexOf(
    "bundleSnapshot = createBundleSnapshot(",
  );
  const preUploadIntegrityIndex = deploySource.lastIndexOf(
    "assertBundleSnapshot(",
    uploadIndex,
  );
  const postUploadIntegrityIndex = deploySource.indexOf(
    "assertBundleSnapshot(",
    uploadIndex,
  );
  const postUploadDryRunIndex = deploySource.indexOf(
    "const postUploadArtifact = buildSchedulerDryRun(",
    uploadIndex,
  );
  const snapshotCleanupIndex = deploySource.indexOf(
    "cleanupBundleSnapshot(bundleSnapshot)",
    postUploadDryRunIndex,
  );
  const triggerIndex = deploySource.indexOf('"triggers"', uploadIndex);
  const activationIndex = deploySource.indexOf(
    "activationAttempted = true",
    triggerIndex,
  );
  const manifestFinalizeIndex = deploySource.indexOf(
    "linkSync(pendingPath, manifestPath)",
    activationIndex,
  );
  const previousReadIndex = deploySource.indexOf("const previous = liveStatus()");
  const manifestApprovalIndex = deploySource.indexOf(
    "validateLiveSchedulerManifestMatch(",
    previousReadIndex,
  );
  const bootstrapApprovalIndex = deploySource.indexOf(
    "validateSchedulerBootstrapCandidate(",
    previousReadIndex,
  );
  assert.ok(
    uploadIndex >= 0 &&
      uploadIndex < triggerIndex &&
      triggerIndex < activationIndex &&
      activationIndex < manifestFinalizeIndex,
    "release order must be upload, Cron deploy/read-back, activation, then manifest finalization",
  );
  assert.ok(
    manifestApprovalIndex > previousReadIndex &&
      manifestApprovalIndex < uploadIndex,
    "the existing external manifest must approve the previous version before upload",
  );
  assert.ok(
    bootstrapApprovalIndex > previousReadIndex &&
      bootstrapApprovalIndex < uploadIndex,
    "the isolated bootstrap candidate must be approved before upload",
  );
  assert.ok(
    snapshotCreationIndex > bootstrapApprovalIndex &&
      snapshotCreationIndex < preUploadIntegrityIndex &&
      preUploadIntegrityIndex < uploadIndex &&
      uploadIndex < postUploadIntegrityIndex &&
      postUploadIntegrityIndex < postUploadDryRunIndex &&
      postUploadDryRunIndex < snapshotCleanupIndex &&
      snapshotCleanupIndex < triggerIndex,
    "the exact private bundle snapshot must be hashed before and after upload, rebuilt, and removed before trigger deployment",
  );
  assert.match(
    deploySource,
    /"upload",\s*bundleSnapshot\.path,\s*"--no-bundle",/,
  );
  assert.match(
    deploySource,
    /"--no-bundle",[\s\S]*\.\.\.wranglerTargetArguments\(\),[\s\S]*"--message",\s*artifact\.message,[\s\S]*"--tag",\s*uploadTag,[\s\S]*"--strict"/,
  );
  assert.match(
    deploySource,
    /artifact\.bundleBytes\.equals\(postUploadArtifact\.bundleBytes\)/,
  );
  assert.match(deploySource, /versions\?\.length !== 1/);
  assert.match(deploySource, /previous\.versions\[0\]\?\.percentage !== 100/);
  assert.match(
    deploySource,
    /await restorePreviousVersion\(previousVersionId, approvedPrevious, \{/,
  );
  assert.match(
    deploySource,
    /parseSchedulerReleaseArguments\(process\.argv\.slice\(2\)\)/,
  );
  assert.match(
    deploySource,
    /const expectedConfirmation = bootstrapPreviousProvenance[\s\S]*bootstrapProvenanceConfirmation[\s\S]*provisioningConfirmation/,
  );
  assert.match(
    deploySource,
    /if \(!execute\)[\s\S]*else if \(confirmation !== expectedConfirmation\)[\s\S]*await uploadVerifyAndActivate/,
  );
  assert.match(
    deploySource,
    /if \(triggerDeploymentAttempted\)[\s\S]*await recoverFailedSchedulerRelease\(/,
  );
  assert.match(
    deploySource,
    /async function recoverFailedSchedulerRelease[\s\S]*classifySchedulerRecoveryState[\s\S]*foreign or ambiguous active Worker[\s\S]*automatic version and Cron rollback were prohibited/,
  );
  assert.match(
    deploySource,
    /recoveryState === "previous_active"[\s\S]*current\.id !== approvedPrevious\?\.deploymentId[\s\S]*guardPreviousDeployment[\s\S]*await restoreConfiguredSchedule\(\{/,
  );
  assert.match(
    deploySource,
    /recoveryState === "owned_activation"[\s\S]*await restorePreviousVersion[\s\S]*uploadedScriptEtag[\s\S]*uploadTag/,
  );
  assert.match(
    deploySource,
    /async function requireOwnedRecoveryActivation[\s\S]*readLiveSchedulerSchedule\(targets\)[\s\S]*validateApprovedPreviousSchedulerVersion[\s\S]*active uploaded Worker no longer matches this release immediately before rollback/,
  );
  assert.match(
    deploySource,
    /async function restorePreviousVersion[\s\S]*await requireOwnedRecoveryActivation[\s\S]*const rollback = spawnSync[\s\S]*guardRestoredDeployment[\s\S]*await restoreConfiguredSchedule\(\{/,
  );
  assert.match(
    deploySource,
    /async function restoreConfiguredSchedule[\s\S]*await beforeMutation\(\)[\s\S]*const triggerRollback = spawnSync[\s\S]*await requireExactLiveSchedule[\s\S]*await afterMutation\(\)/,
  );
  const ownedBarriers = [
    ...deploySource.matchAll(/await requireOwnedActiveDeployment\(\{/g),
  ].map((match) => match.index);
  assert.equal(
    ownedBarriers.length,
    3,
    "activation must be verified initially and immediately before and after manifest finalization",
  );
  assert.ok(
    ownedBarriers[0] < ownedBarriers[1] &&
      ownedBarriers[1] < manifestFinalizeIndex &&
      manifestFinalizeIndex < ownedBarriers[2],
    "live ownership barriers must surround manifest finalization",
  );
  assert.match(
    deploySource,
    /if \(manifestFinalized\)[\s\S]*unlinkSync\(manifestPath\)/,
  );
  assert.match(deploySource, /readLiveSchedulerSchedule\(targets\)/);
  assert.match(deploySource, /--bootstrap-previous-provenance/);
  assert.match(
    deploySource,
    /bootstrap-account-deletion-scheduler-provenance|bootstrapProvenanceConfirmation/,
  );
  assert.match(
    deploySource,
    /TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST/,
  );
  assert.match(deploySource, /openSync\(pendingPath, "wx", 0o600\)/);
  assert.match(deploySource, /linkSync\(pendingPath, manifestPath\)/);
  assert.match(deploySource, /readBoundedJsonFileSync\(manifestPath/);
});
