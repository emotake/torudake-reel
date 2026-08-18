import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  computePagesArtifactAggregate,
  pagesReleaseMessage,
} from "../lib/pages-release-artifact.mjs";
import { readBoundedJsonFileSync } from "../lib/bounded-json-file.mjs";

import {
  READ_ONLY_D1_QUERIES,
  assertSchedulerBundleIntegrity,
  assertReadOnlySql,
  classifySchedulerRecoveryState,
  compareMigrationLedger,
  discoverMigrationNames,
  extractSchedulerModuleFromWranglerDryRun,
  extractRowsFromWranglerJson,
  isDDrivePath,
  isUnsafeGitRemote,
  parseLiveSchedulerScheduleEnvelope,
  parseSchedulerReleaseArguments,
  schedulerBundleSha256,
  schedulerReleaseMessage,
  validateApprovedPreviousSchedulerVersion,
  validateAnalyticsEngineDatasetList,
  validateLiveRollbackDeployment,
  validateLiveSchedulerDeployment,
  validateLiveSchedulerManifestMatch,
  validateLiveSchedulerSchedule,
  validateRollbackManifest,
  validateRollbackReadiness,
  runLocalChecks,
  validateSchedulerBootstrapCandidate,
  validateSchedulerManifest,
  validateSchedulerRollbackVersion,
  validateStoredSchedulerManifest,
} from "../scripts/release-preflight.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

function analyticsEngineDatasetListFixture(
  datasets = ["torudake_line_auth_events"],
  { rowsBeforeLimit = 10 } = {},
) {
  const data = datasets.map((dataset) => ({ dataset }));
  return {
    meta: [{ name: "dataset", type: "String" }],
    data,
    rows: data.length,
    ...(rowsBeforeLimit === undefined
      ? {}
      : { rows_before_limit_at_least: rowsBeforeLimit }),
  };
}

test("scheduler provenance JSON uses a bounded descriptor-stable reader", async () => {
  const directory = await mkdtemp(join(tmpdir(), "torudake-bounded-json-"));
  try {
    const path = join(directory, "manifest.json");
    const payload = Buffer.from('{"schemaVersion":2}\n', "utf8");
    await writeFile(path, payload);
    const read = readBoundedJsonFileSync(path, { maxBytes: payload.length });
    assert.deepEqual(read.value, { schemaVersion: 2 });
    assert.deepEqual(read.bytes, payload);
    assert.throws(
      () => readBoundedJsonFileSync(path, { maxBytes: payload.length - 1 }),
      /bounded regular file|byte limit/,
    );

    const readerSource = await readFile(
      new URL("../lib/bounded-json-file.mjs", import.meta.url),
      "utf8",
    );
    assert.match(readerSource, /O_NOFOLLOW/);
    assert.match(readerSource, /fstatSync/);
    assert.match(readerSource, /lstatSync/);

    const schedulerDeploySource = await readFile(
      new URL(
        "../scripts/operations/deploy-account-deletion-scheduler.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(schedulerDeploySource, /readBoundedJsonFileSync/);
    assert.match(schedulerDeploySource, /linkSync\(pendingPath, manifestPath\)/);
    assert.match(schedulerDeploySource, /validateExternalManifestParent/);
    assert.match(schedulerDeploySource, /realpathSync\(PROJECT_ROOT\)/);
    assert.doesNotMatch(
      schedulerDeploySource,
      /JSON\.parse\(raw\.toString\("utf8"\)\)/,
    );
    assert.doesNotMatch(
      schedulerDeploySource,
      /renameSync\(pendingPath, manifestPath\)/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Analytics Engine release gate requires exactly one queryable pinned dataset", () => {
  assert.deepEqual(
    validateAnalyticsEngineDatasetList(
      analyticsEngineDatasetListFixture(),
      "torudake_line_auth_events",
    ),
    [],
  );
  assert.deepEqual(
    validateAnalyticsEngineDatasetList(
      analyticsEngineDatasetListFixture([
        "torudake_line_auth_events",
        "another_dataset",
      ]),
      "torudake_line_auth_events",
    ),
    [],
  );
  assert.match(
    validateAnalyticsEngineDatasetList(
      analyticsEngineDatasetListFixture([]),
      "torudake_line_auth_events",
    ).join(" "),
    /not uniquely queryable/,
  );
  assert.match(
    validateAnalyticsEngineDatasetList(
      analyticsEngineDatasetListFixture([
        "torudake_line_auth_events",
        "torudake_line_auth_events",
      ]),
      "torudake_line_auth_events",
    ).join(" "),
    /not uniquely queryable/,
  );
  assert.match(
    validateAnalyticsEngineDatasetList(
      {
        ...analyticsEngineDatasetListFixture(),
        data: [{ name: "torudake_line_auth_events" }],
      },
      "torudake_line_auth_events",
    ).join(" "),
    /response is invalid/,
  );
  assert.match(
    validateAnalyticsEngineDatasetList(
      {
        ...analyticsEngineDatasetListFixture(),
        data: [
          {
            dataset: "torudake_line_auth_events",
            unexpected: true,
          },
        ],
      },
      "torudake_line_auth_events",
    ).join(" "),
    /response is invalid/,
  );
  for (const mutate of [
    (payload) => {
      payload.meta[0].type = "string";
    },
    (payload) => {
      payload.rows = 0;
    },
    (payload) => {
      payload.rows_before_limit_at_least = 0;
    },
    (payload) => {
      payload.unexpected = true;
    },
  ]) {
    const payload = analyticsEngineDatasetListFixture();
    mutate(payload);
    assert.match(
      validateAnalyticsEngineDatasetList(
        payload,
        "torudake_line_auth_events",
      ).join(" "),
      /response is invalid/,
    );
  }
  for (const payload of [
    { data: [{ dataset: "torudake_line_auth_events" }] },
    { ...analyticsEngineDatasetListFixture(), rows: 1.5 },
    { ...analyticsEngineDatasetListFixture(), rows: -1 },
    {
      ...analyticsEngineDatasetListFixture(),
      rows_before_limit_at_least: 1.5,
    },
  ]) {
    assert.match(
      validateAnalyticsEngineDatasetList(
        payload,
        "torudake_line_auth_events",
      ).join(" "),
      /response is invalid/,
    );
  }
  assert.deepEqual(
    validateAnalyticsEngineDatasetList(
      analyticsEngineDatasetListFixture(["torudake_line_auth_events"], {
        rowsBeforeLimit: undefined,
      }),
      "torudake_line_auth_events",
    ),
    [],
  );
});

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
  assert.equal(
    targets.cloudflareAccountId,
    "e7572bf15e2fc4346e54f72ed7cb3ff0",
  );
  assert.equal(targets.pagesProject, "torudake-reel");
  assert.equal(targets.productionBranch, "main");
  assert.equal(targets.d1Database, "torudake-reel-db");
  assert.equal(targets.d1Binding, "DB");
  assert.equal(targets.authObservabilityBinding, "AUTH_OBSERVABILITY");
  assert.equal(targets.authObservabilityDataset, "torudake_line_auth_events");
  assert.deepEqual(targets.pagesArtifact, {
    root: "dist/cloudflare-pages",
    releaseMessagePrefix: "torudake-pages-v1",
    manifestEnvironmentVariable: "TORUDAKE_PAGES_ARTIFACT_MANIFEST",
    manifestSchemaVersion: 1,
    deployConfirmation: "deploy-cloudflare-pages",
  });
  assert.equal(
    targets.rollbackPolicy.manifestEnvironmentVariable,
    "TORUDAKE_ROLLBACK_MANIFEST",
  );
  assert.equal(targets.rollbackPolicy.manifestSchemaVersion, 2);
  assert.deepEqual(targets.accountDeletionScheduler, {
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
  });
  assert.deepEqual(targets.rollbackPolicy.requiredDisabledAuthenticationFlags, {
    OIDC_AUTH_ENABLED: "false",
    LINE_LOGIN_ENABLED: "false",
    GOOGLE_OIDC_ENABLED: "false",
    EMAIL_AUTH_ENABLED: "false",
    PASSKEY_AUTH_ENABLED: "false",
  });
  assert.deepEqual(targets.rollbackPolicy.legacyPreviousProduction, {
    deploymentId: "f8bee356-6458-4c91-9e29-b3febcd5e4fc",
    sourceCommit: "35abc4dde3d45a48b2d422da8f37a3b314e036ee",
    commitMessage: "fix: harden LINE login lifecycle and observability",
    createdOn: "2026-08-18T08:51:43.113033Z",
    methodsSchema: "line_only_without_authentication_flags",
  });
  assert.deepEqual(targets.rollbackPolicy.telemetryDegradedEmergencyDeployment, {
    deploymentId: "04519766-9146-440a-9467-57e9ac56e4a5",
    sourceCommit: "38f8a256c58362862b96d8437c49f0556c6d0dc6",
    classification: "emergency_only",
    degradation: "auth_observability_binding_absent",
  });
  assert.equal(
    existsSync(new URL("../wrangler.jsonc", import.meta.url)),
    false,
    "a partial root Wrangler config would overwrite dashboard-managed Pages bindings and variables",
  );
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

  const local = runLocalChecks({ root: projectRoot });
  assert.equal(
    local.errors.includes("Release targets does not match the release contract."),
    false,
    local.errors.join("\n"),
  );
});

test("standard rollback manifest requires the same artifact, durable telemetry, and disabled auth", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const sourceCommit = "a".repeat(40);
  const artifactFiles = [
    { path: "_worker.js", size: 20, sha256: "e".repeat(64) },
  ];
  const artifactSha256 = computePagesArtifactAggregate(artifactFiles);
  const pagesArtifactManifest = {
    schemaVersion: 1,
    artifactRoot: "dist/cloudflare-pages",
    sourceCommit,
    generatedAt: "2026-08-18T08:59:00.000Z",
    fileCount: 1,
    totalBytes: 20,
    aggregateSha256: artifactSha256,
    deploymentMessage: pagesReleaseMessage(sourceCommit, artifactSha256),
    files: artifactFiles,
  };
  const manifest = {
    schemaVersion: 2,
    pagesProject: "torudake-reel",
    productionBranch: "main",
    sourceCommit,
    disabledDeploymentId: "11111111-2222-4333-8444-555555555555",
    deploymentUrl: "https://11111111.torudake-reel.pages.dev",
    deploymentEnvironment: "production",
    deploymentStatus: "success",
    artifact: {
      schemaVersion: 1,
      root: "dist/cloudflare-pages",
      aggregateSha256: artifactSha256,
      fileCount: 1,
      totalBytes: 20,
      deploymentMessage: pagesArtifactManifest.deploymentMessage,
    },
    bindings: {
      DB: {
        type: "d1",
        databaseId: "c0b9cc06-fc19-4e02-acac-2c19d32f3fdc",
      },
      AUTH_OBSERVABILITY: {
        type: "analytics_engine",
        dataset: "torudake_line_auth_events",
      },
    },
    authenticationMethods: {
      passkey: false,
      line: false,
      google: false,
      email: false,
    },
    authenticationFlags: {
      OIDC_AUTH_ENABLED: "false",
      LINE_LOGIN_ENABLED: "false",
      GOOGLE_OIDC_ENABLED: "false",
      EMAIL_AUTH_ENABLED: "false",
      PASSKEY_AUTH_ENABLED: "false",
    },
    verification: {
      bindingsFromDeploymentSnapshot: true,
      flagsWereRedeployed: true,
      healthReady: true,
      allPublicAuthenticationMethodsDisabled: true,
      authObservabilityDatasetQueryable: true,
      healthCheckedAt: "2026-08-18T08:59:57.000Z",
      methodsCheckedAt: "2026-08-18T08:59:58.000Z",
      analyticsEngineCheckedAt: "2026-08-18T08:59:59.000Z",
      verifiedAt: "2026-08-18T09:00:00.000Z",
    },
  };

  assert.deepEqual(
    validateRollbackManifest(manifest, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }),
    { valid: true, errors: [] },
  );

  const missingTelemetry = structuredClone(manifest);
  delete missingTelemetry.bindings.AUTH_OBSERVABILITY;
  assert.equal(
    validateRollbackManifest(missingTelemetry, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const enabledLine = structuredClone(manifest);
  enabledLine.authenticationFlags.LINE_LOGIN_ENABLED = "true";
  assert.equal(
    validateRollbackManifest(enabledLine, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const enabledEmail = structuredClone(manifest);
  enabledEmail.authenticationFlags.EMAIL_AUTH_ENABLED = "true";
  assert.equal(
    validateRollbackManifest(enabledEmail, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const enabledMethod = structuredClone(manifest);
  enabledMethod.authenticationMethods.line = true;
  assert.equal(
    validateRollbackManifest(enabledMethod, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const missingProbeTime = structuredClone(manifest);
  delete missingProbeTime.verification.analyticsEngineCheckedAt;
  assert.equal(
    validateRollbackManifest(missingProbeTime, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const wrongArtifact = structuredClone(manifest);
  wrongArtifact.artifact.aggregateSha256 = "0".repeat(64);
  assert.equal(
    validateRollbackManifest(wrongArtifact, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const emergency = structuredClone(manifest);
  emergency.disabledDeploymentId = "04519766-9146-440a-9467-57e9ac56e4a5";
  emergency.deploymentUrl = "https://04519766.torudake-reel.pages.dev";
  assert.match(
    validateRollbackManifest(emergency, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).errors.join(" "),
    /emergency deployment cannot be a standard rollback target/,
  );

  const uppercaseEmergency = structuredClone(emergency);
  uppercaseEmergency.disabledDeploymentId =
    uppercaseEmergency.disabledDeploymentId.toUpperCase();
  assert.match(
    validateRollbackManifest(uppercaseEmergency, {
      targets,
      sourceCommit,
      pagesArtifactManifest,
    }).errors.join(" "),
    /emergency deployment cannot be a standard rollback target/,
  );

  assert.equal(
    validateRollbackManifest(manifest, {
      targets,
      sourceCommit: "b".repeat(40),
      pagesArtifactManifest,
    }).valid,
    false,
  );

  const preflightSource = await readFile(
    new URL("../scripts/release-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    preflightSource,
    /requireRollbackManifest:[\s\S]*!offline\s*&&\s*!rollbackProvisioning\s*&&\s*!schedulerProvisioning/,
  );
  assert.match(preflightSource, /--provision-disabled-rollback/);
  assert.match(preflightSource, /--provision-account-deletion-scheduler/);
  assert.match(preflightSource, /runRemotePagesRollbackChecks/);
  assert.doesNotMatch(preflightSource, /per_page=25/);
  assert.match(
    preflightSource,
    /\$\{apiBase\}\/\$\{encodeURIComponent\(manifest\.disabledDeploymentId\)\}/,
  );
  assert.match(preflightSource, /verifyPagesArtifactManifest/);
  assert.match(preflightSource, /TORUDAKE_PAGES_ARTIFACT_MANIFEST/);
  assert.match(preflightSource, /runRemoteSchedulerChecks/);
  assert.match(
    preflightSource,
    /Rollback-provisioning mode authorizes only creation of the disabled rollback snapshot/,
  );
});

test("online rollback verification uses live Pages metadata, bindings, and five flags", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const sourceCommit = "a".repeat(40);
  const artifactSha256 = "e".repeat(64);
  const pagesArtifactManifest = {
    aggregateSha256: artifactSha256,
    deploymentMessage: pagesReleaseMessage(sourceCommit, artifactSha256),
  };
  const manifest = {
    disabledDeploymentId: "11111111-2222-4333-8444-555555555555",
    deploymentUrl: "https://11111111.torudake-reel.pages.dev",
    artifact: {
      deploymentMessage: pagesArtifactManifest.deploymentMessage,
    },
  };
  const deployment = {
    id: manifest.disabledDeploymentId,
    project_name: targets.pagesProject,
    environment: "production",
    production_branch: "main",
    url: manifest.deploymentUrl,
    latest_stage: { name: "deploy", status: "success" },
    is_skipped: false,
    deployment_trigger: {
      metadata: {
        branch: "main",
        commit_hash: sourceCommit,
        commit_dirty: false,
        commit_message: pagesArtifactManifest.deploymentMessage,
      },
    },
    d1_databases: { DB: { id: targets.d1DatabaseId } },
    analytics_engine_datasets: {
      AUTH_OBSERVABILITY: { dataset: targets.authObservabilityDataset },
    },
  };
  assert.deepEqual(
    validateLiveRollbackDeployment(deployment, {
      targets,
      manifest,
      sourceCommit,
      pagesArtifactManifest,
    }),
    [],
  );
  const wrongBinding = structuredClone(deployment);
  wrongBinding.analytics_engine_datasets.AUTH_OBSERVABILITY.dataset = "wrong";
  assert.match(
    validateLiveRollbackDeployment(wrongBinding, {
      targets,
      manifest,
      sourceCommit,
      pagesArtifactManifest,
    }).join(" "),
    /Analytics Engine/,
  );
  const forgedArtifact = structuredClone(deployment);
  forgedArtifact.deployment_trigger.metadata.commit_message =
    "torudake-pages-v1 forged";
  assert.match(
    validateLiveRollbackDeployment(forgedArtifact, {
      targets,
      manifest,
      sourceCommit,
      pagesArtifactManifest,
    }).join(" "),
    /reviewed commit and Pages artifact/,
  );
  const missingSkippedState = structuredClone(deployment);
  delete missingSkippedState.is_skipped;
  assert.match(
    validateLiveRollbackDeployment(missingSkippedState, {
      targets,
      manifest,
      sourceCommit,
      pagesArtifactManifest,
    }).join(" "),
    /successfully deployed/,
  );

  const flags = Object.fromEntries(
    Object.keys(targets.rollbackPolicy.requiredDisabledAuthenticationFlags).map(
      (name) => [name, false],
    ),
  );
  const health = {
    status: "ready",
    requestId: "release-health-0001",
    timestamp: "2026-08-18T09:00:00.000Z",
  };
  const methods = {
    authenticated: false,
    recentlyAuthenticated: false,
    accountMethods: {
      passkey: false,
      line: false,
      google: false,
      email: false,
    },
    passkey: false,
    line: false,
    google: false,
    email: false,
    authenticationFlags: flags,
  };
  const probeOptions = {
    checkedAt: new Date("2026-08-18T09:00:30.000Z"),
    healthCacheControl: "private, no-store",
    methodsCacheControl: "no-store",
  };
  assert.deepEqual(
    validateRollbackReadiness(health, methods, targets, probeOptions),
    [],
  );
  const enabledFlag = structuredClone(methods);
  enabledFlag.authenticationFlags.EMAIL_AUTH_ENABLED = true;
  assert.match(
    validateRollbackReadiness(
      health,
      enabledFlag,
      targets,
      probeOptions,
    ).join(" "),
    /five raw flags/,
  );
  const staleHealth = structuredClone(health);
  staleHealth.timestamp = "2026-08-18T08:30:00.000Z";
  assert.match(
    validateRollbackReadiness(
      staleHealth,
      methods,
      targets,
      probeOptions,
    ).join(" "),
    /not exact and current/,
  );
  const extraHealth = { ...health, cached: true };
  assert.match(
    validateRollbackReadiness(
      extraHealth,
      methods,
      targets,
      probeOptions,
    ).join(" "),
    /not exact and current/,
  );
  for (const invalidHealth of [
    { ...health, requestId: "short" },
    { ...health, timestamp: "2026-08-18T09:00:00Z" },
  ]) {
    assert.match(
      validateRollbackReadiness(
        invalidHealth,
        methods,
        targets,
        probeOptions,
      ).join(" "),
      /not exact and current/,
    );
  }
  const authenticatedMethods = structuredClone(methods);
  authenticatedMethods.authenticated = true;
  assert.match(
    validateRollbackReadiness(
      health,
      authenticatedMethods,
      targets,
      probeOptions,
    ).join(" "),
    /authentication methods/,
  );
  const accountMethod = structuredClone(methods);
  accountMethod.accountMethods.line = true;
  assert.match(
    validateRollbackReadiness(
      health,
      accountMethod,
      targets,
      probeOptions,
    ).join(" "),
    /authentication methods/,
  );
  assert.match(
    validateRollbackReadiness(health, methods, targets, {
      ...probeOptions,
      methodsCacheControl: "public, max-age=300",
    }).join(" "),
    /not marked no-store/,
  );
});

test("scheduler release hashes and verifies the exact Worker module bytes", () => {
  const bundleBytes = Buffer.from(
    "export default { async scheduled() { return undefined; } };\n",
  );
  const expectedSha256 = createHash("sha256").update(bundleBytes).digest("hex");

  assert.equal(schedulerBundleSha256(bundleBytes), expectedSha256);
  assert.equal(
    assertSchedulerBundleIntegrity(bundleBytes, expectedSha256),
    expectedSha256,
  );

  const substitutedBytes = Buffer.from(bundleBytes);
  substitutedBytes[0] ^= 1;
  assert.throws(
    () => assertSchedulerBundleIntegrity(substitutedBytes, expectedSha256),
    /do not match the reviewed SHA-256/,
  );
  assert.throws(
    () => schedulerBundleSha256(new Uint8Array()),
    /bundle bytes are unavailable/,
  );
});

test("scheduler dry-run extraction ignores multipart boundaries and hashes only the module", () => {
  const moduleBytes = Buffer.from(
    "export default { async scheduled() { return undefined; } };\n",
    "utf8",
  );
  const metadata = JSON.stringify({
    main_module: "account-deletion-scheduler.js",
    bindings: [
      {
        name: "TORUDAKE_SITE_ORIGIN",
        type: "plain_text",
        text: "https://torudake-reel.pages.dev",
      },
      {
        name: "ACCOUNT_DELETION_BATCH_LIMIT",
        type: "plain_text",
        text: "5",
      },
    ],
    compatibility_date: "2026-08-13",
    compatibility_flags: [],
    observability: {
      enabled: true,
      logs: {
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: true,
        persist: true,
      },
    },
    package_dependencies: [
      {
        name: "wrangler",
        packageJsonVersion: "4.118.0",
        installedVersion: "4.118.0",
      },
    ],
  });
  const multipart = (
    boundary,
    {
      moduleName = "account-deletion-scheduler.js",
      metadataPayload = metadata,
    } = {},
  ) =>
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="metadata"\r\n\r\n' +
          `${metadataPayload}\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${moduleName}"; ` +
          `filename="${moduleName}"\r\n` +
          "Content-Type: application/javascript+module\r\n\r\n",
        "utf8",
      ),
      moduleBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]);

  const first = extractSchedulerModuleFromWranglerDryRun(
    multipart("----formdata-undici-012345678901"),
    {
      expectedCompatibilityDate: "2026-08-13",
      expectedProductionUrl: "https://torudake-reel.pages.dev",
    },
  );
  const second = extractSchedulerModuleFromWranglerDryRun(
    multipart("----formdata-undici-987654321098"),
    {
      expectedCompatibilityDate: "2026-08-13",
      expectedProductionUrl: "https://torudake-reel.pages.dev",
    },
  );
  assert.deepEqual(first.bundleBytes, moduleBytes);
  assert.deepEqual(second.bundleBytes, moduleBytes);
  assert.equal(
    schedulerBundleSha256(first.bundleBytes),
    schedulerBundleSha256(second.bundleBytes),
  );
  assert.equal(first.metadata.main_module, "account-deletion-scheduler.js");

  assert.throws(
    () =>
      extractSchedulerModuleFromWranglerDryRun(
        multipart("----formdata-undici-111111111111", {
          moduleName: "other-worker.js",
        }),
        {
          expectedCompatibilityDate: "2026-08-13",
          expectedProductionUrl: "https://torudake-reel.pages.dev",
        },
      ),
    /module part is invalid/,
  );
  assert.throws(
    () =>
      extractSchedulerModuleFromWranglerDryRun(
        multipart("----formdata-undici-222222222222"),
        {
          expectedCompatibilityDate: "2026-08-14",
          expectedProductionUrl: "https://torudake-reel.pages.dev",
        },
      ),
    /metadata does not match/,
  );
  const wrongBindings = JSON.parse(metadata);
  wrongBindings.bindings[0].text = "https://example.invalid";
  assert.throws(
    () =>
      extractSchedulerModuleFromWranglerDryRun(
        multipart("----formdata-undici-222222222223", {
          metadataPayload: JSON.stringify(wrongBindings),
        }),
        {
          expectedCompatibilityDate: "2026-08-13",
          expectedProductionUrl: "https://torudake-reel.pages.dev",
        },
      ),
    /metadata projection is invalid/,
  );
  assert.throws(
    () =>
      extractSchedulerModuleFromWranglerDryRun(
        Buffer.concat([
          multipart("----formdata-undici-333333333333"),
          Buffer.from("trailing"),
        ]),
      ),
    /trailing data/,
  );
});

test("scheduler mutation CLI rejects ambiguous or ignored arguments", () => {
  assert.deepEqual(parseSchedulerReleaseArguments(["--"]), {
    execute: false,
    bootstrapPreviousProvenance: false,
    confirmation: undefined,
    manifestPath: undefined,
  });
  assert.deepEqual(parseSchedulerReleaseArguments([]), {
    execute: false,
    bootstrapPreviousProvenance: false,
    confirmation: undefined,
    manifestPath: undefined,
  });
  assert.deepEqual(
    parseSchedulerReleaseArguments(["--bootstrap-previous-provenance"]),
    {
      execute: false,
      bootstrapPreviousProvenance: true,
      confirmation: undefined,
      manifestPath: undefined,
    },
  );
  assert.deepEqual(
    parseSchedulerReleaseArguments([
      "--execute",
      "--confirm",
      "deploy-account-deletion-scheduler",
      "--manifest",
      "D:\\private\\scheduler.json",
    ]),
    {
      execute: true,
      bootstrapPreviousProvenance: false,
      confirmation: "deploy-account-deletion-scheduler",
      manifestPath: "D:\\private\\scheduler.json",
    },
  );
  assert.deepEqual(
    parseSchedulerReleaseArguments([
      "--bootstrap-previous-provenance",
      "--manifest",
      "D:\\private\\scheduler.json",
      "--execute",
      "--confirm",
      "bootstrap-account-deletion-scheduler-provenance",
    ]).bootstrapPreviousProvenance,
    true,
  );

  for (const argv of [
    ["--dry-run"],
    ["positional"],
    ["--unknown"],
    ["--bootstrap-previous-provenance", "--bootstrap-previous-provenance"],
    ["--execute", "--execute", "--confirm", "x", "--manifest", "y"],
    ["--execute", "--confirm", "x", "--confirm", "y", "--manifest", "z"],
    ["--execute", "--confirm", "x", "--manifest", "y", "--manifest", "z"],
    ["--execute", "--manifest"],
    ["--execute", "--confirm", "--manifest", "x"],
    ["--execute", "--confirm", "x"],
    ["--execute", "--manifest", "x"],
    ["--confirm", "x"],
    ["--manifest", "x"],
    ["--", "--", "--execute", "--confirm", "x", "--manifest", "y"],
  ]) {
    assert.throws(() => parseSchedulerReleaseArguments(argv));
  }
  assert.throws(() => parseSchedulerReleaseArguments(["--execute", 7]));
});

test("scheduler recovery mutates traffic only while the active set is owned", () => {
  const previousVersionId = "11111111-2222-4333-8444-555555555555";
  const uploadedVersionId = "22222222-3333-4444-8555-666666666666";
  const foreignVersionId = "33333333-4444-4555-8666-777777777777";
  const deployment = (versions) => ({
    id: "44444444-5555-4666-8777-888888888888",
    strategy: "percentage",
    versions,
  });
  const options = { previousVersionId, uploadedVersionId };

  assert.equal(
    classifySchedulerRecoveryState(
      deployment([{ version_id: previousVersionId, percentage: 100 }]),
      options,
    ),
    "previous_active",
  );
  assert.equal(
    classifySchedulerRecoveryState(
      deployment([{ version_id: uploadedVersionId, percentage: 100 }]),
      options,
    ),
    "owned_activation",
  );
  assert.equal(
    classifySchedulerRecoveryState(
      deployment([
        { version_id: previousVersionId, percentage: 25 },
        { version_id: uploadedVersionId, percentage: 75 },
      ]),
      options,
    ),
    "owned_activation",
  );
  for (const status of [
    deployment([{ version_id: foreignVersionId, percentage: 100 }]),
    deployment([
      { version_id: uploadedVersionId, percentage: 50 },
      { version_id: foreignVersionId, percentage: 50 },
    ]),
    deployment([{ version_id: uploadedVersionId, percentage: 90 }]),
    { id: "invalid", strategy: "percentage", versions: [] },
  ]) {
    assert.equal(
      classifySchedulerRecoveryState(status, options),
      "foreign_or_ambiguous",
    );
  }
});

test("scheduler release proof joins local bundle, external ETag, and live version", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const sourceCommit = "b".repeat(40);
  const bundleSha256 = "c".repeat(64);
  const message = schedulerReleaseMessage(sourceCommit, bundleSha256, targets);
  const deploymentId = "11111111-2222-4333-8444-555555555555";
  const activeVersionId = "22222222-3333-4444-8555-666666666666";
  const previousVersionId = "33333333-4444-4555-8666-777777777777";
  const previousDeploymentId = "44444444-5555-4666-8777-888888888888";
  const scriptEtag = "d".repeat(64);
  const previousScriptEtag = "e".repeat(64);
  const previousSourceCommit = "a".repeat(40);
  const previousBundleSha256 = "f".repeat(64);
  const previousMessage = schedulerReleaseMessage(
    previousSourceCommit,
    previousBundleSha256,
    targets,
  );
  const previousUploadTag = "torudake-aaaaaaaaaaaa-ffffffffffff-87654321";
  const uploadTag = "torudake-bbbbbbbbbbbb-cccccccccccc-12345678";
  const manifest = {
    schemaVersion: 2,
    workerName: targets.accountDeletionScheduler.workerName,
    sourceCommit,
    bundleSha256,
    deploymentMessage: message,
    uploadTag,
    activeDeploymentId: deploymentId,
    activeVersionId,
    previousVersionId,
    scriptEtag,
    deployedAt: "2026-08-18T09:00:00.000Z",
    schedule: {
      cron: "15 18 * * *",
      liveVerified: true,
    },
    approvedPrevious: {
      provenance: "external_manifest",
      manifestSchemaVersion: 2,
      manifestSha256: "9".repeat(64),
      deploymentId: previousDeploymentId,
      versionId: previousVersionId,
      scriptEtag: previousScriptEtag,
      sourceCommit: previousSourceCommit,
      bundleSha256: previousBundleSha256,
      deploymentMessage: previousMessage,
      uploadTag: previousUploadTag,
      deployedAt: "2026-08-17T09:00:00.000Z",
      schedule: {
        cron: "15 18 * * *",
        liveVerified: true,
      },
    },
    verification: {
      wranglerDryRunPassed: true,
      activeTrafficPercentage: 100,
      liveVersionReadBack: true,
    },
  };
  assert.deepEqual(
    validateSchedulerManifest(manifest, {
      targets,
      sourceCommit,
      schedulerArtifact: { bundleSha256, message },
    }),
    { valid: true, errors: [] },
  );
  assert.deepEqual(validateStoredSchedulerManifest(manifest, { targets }), {
    valid: true,
    errors: [],
  });
  const bootstrapManifest = structuredClone(manifest);
  bootstrapManifest.approvedPrevious = {
    ...bootstrapManifest.approvedPrevious,
    provenance: "bootstrap_confirmation",
    manifestSchemaVersion: null,
    manifestSha256: null,
    sourceCommit: null,
    bundleSha256: null,
    deploymentMessage: null,
    uploadTag: null,
  };
  assert.deepEqual(
    validateSchedulerManifest(bootstrapManifest, {
      targets,
      sourceCommit,
      schedulerArtifact: { bundleSha256, message },
    }),
    { valid: true, errors: [] },
  );
  const forgedProvenance = structuredClone(manifest);
  forgedProvenance.approvedPrevious.manifestSha256 = null;
  assert.equal(
    validateStoredSchedulerManifest(forgedProvenance, { targets }).valid,
    false,
  );
  const status = {
    id: deploymentId,
    strategy: "percentage",
    versions: [{ version_id: activeVersionId, percentage: 100 }],
  };
  const version = {
    id: activeVersionId,
    metadata: {
      source: "wrangler",
      created_on: "2026-08-18T09:00:00.000Z",
    },
    annotations: {
      "workers/message": message,
      "workers/tag": uploadTag,
    },
    resources: {
      script: { etag: scriptEtag },
      script_runtime: { compatibility_date: "2026-08-13" },
      bindings: [
        {
          name: "ACCOUNT_DELETION_BATCH_LIMIT",
          type: "plain_text",
          text: "5",
        },
        { name: "ACCOUNT_DELETION_OPERATIONS_SECRET", type: "secret_text" },
        {
          name: "TORUDAKE_SITE_ORIGIN",
          type: "plain_text",
          text: targets.productionUrl,
        },
      ],
    },
  };
  assert.deepEqual(
    validateLiveSchedulerDeployment(status, version, {
      targets,
      expectedMessage: message,
    }),
    [],
  );
  const liveSchedule = { crons: ["15 18 * * *"] };
  assert.deepEqual(
    validateLiveSchedulerSchedule(liveSchedule, {
      targets,
      manifestSchedule: manifest.schedule,
    }),
    [],
  );
  assert.deepEqual(
    validateLiveSchedulerManifestMatch(status, version, liveSchedule, {
      targets,
      manifest,
    }),
    [],
  );
  assert.match(
    validateLiveSchedulerManifestMatch(
      status,
      version,
      { crons: ["0 0 * * *"] },
      { targets, manifest },
    ).join(" "),
    /Cron/,
  );
  const driftCases = [
    () => {
      const changed = structuredClone(status);
      changed.id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      return [changed, version, liveSchedule];
    },
    () => {
      const changed = structuredClone(version);
      changed.resources.script.etag = "0".repeat(64);
      return [status, changed, liveSchedule];
    },
    () => {
      const changed = structuredClone(version);
      changed.annotations["workers/message"] = "wrong";
      return [status, changed, liveSchedule];
    },
    () => {
      const changed = structuredClone(version);
      changed.annotations["workers/tag"] = "wrong";
      return [status, changed, liveSchedule];
    },
    () => {
      const changed = structuredClone(version);
      changed.metadata.created_on = "2026-08-18T09:01:00.000Z";
      return [status, changed, liveSchedule];
    },
    () => [status, version, { crons: ["0 0 * * *"] }],
  ];
  for (const driftCase of driftCases) {
    const [changedStatus, changedVersion, changedSchedule] = driftCase();
    assert.notEqual(
      validateLiveSchedulerManifestMatch(
        changedStatus,
        changedVersion,
        changedSchedule,
        { targets, manifest },
      ).length,
      0,
    );
  }
  assert.deepEqual(
    validateSchedulerRollbackVersion(version, {
      targets,
      expectedVersionId: activeVersionId,
    }),
    [],
  );
  const unsafeRollback = structuredClone(version);
  unsafeRollback.resources.bindings = unsafeRollback.resources.bindings.filter(
    (binding) => binding.name !== "ACCOUNT_DELETION_OPERATIONS_SECRET",
  );
  assert.match(
    validateSchedulerRollbackVersion(unsafeRollback, {
      targets,
      expectedVersionId: activeVersionId,
    }).join(" "),
    /unsafe bindings/,
  );
  const approvedRollback = structuredClone(version);
  approvedRollback.id = previousVersionId;
  approvedRollback.metadata.created_on = manifest.approvedPrevious.deployedAt;
  approvedRollback.resources.script.etag = previousScriptEtag;
  approvedRollback.annotations["workers/message"] = previousMessage;
  approvedRollback.annotations["workers/tag"] = previousUploadTag;
  assert.deepEqual(
    validateApprovedPreviousSchedulerVersion(approvedRollback, {
      targets,
      approvedPrevious: manifest.approvedPrevious,
    }),
    [],
  );
  approvedRollback.resources.script.etag = "0".repeat(64);
  assert.match(
    validateApprovedPreviousSchedulerVersion(approvedRollback, {
      targets,
      approvedPrevious: manifest.approvedPrevious,
    }).join(" "),
    /approved provenance/,
  );
  const forged = structuredClone(version);
  forged.resources.script.etag = "e".repeat(64);
  assert.notEqual(forged.resources.script.etag, manifest.scriptEtag);
  const wrongMessage = structuredClone(version);
  wrongMessage.annotations["workers/message"] = "forged";
  assert.match(
    validateLiveSchedulerDeployment(status, wrongMessage, {
      targets,
      expectedMessage: message,
    }).join(" "),
    /reviewed commit and bundle hash/,
  );
  const preflightSource = await readFile(
    new URL("../scripts/release-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.match(preflightSource, /validateLiveSchedulerManifestMatch/);
  assert.match(preflightSource, /readLiveSchedulerSchedule/);
  assert.match(preflightSource, /validateApprovedPreviousSchedulerVersion/);
});

test("scheduler Cron parser accepts only the live Cloudflare envelope shape and exact schedule", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const liveEnvelope = {
    success: true,
    result: {
      schedules: [
        {
          cron: "15 18 * * *",
          created_on: "2026-08-13T12:35:12.000Z",
          modified_on: "2026-08-13T12:35:12.000Z",
        },
      ],
    },
    errors: [],
    messages: [],
  };
  assert.deepEqual(parseLiveSchedulerScheduleEnvelope(liveEnvelope), {
    crons: ["15 18 * * *"],
  });
  for (const malformed of [
    { success: true, result: [{ cron: "15 18 * * *" }] },
    { success: true, result: { schedules: "15 18 * * *" } },
    { success: true, result: { schedules: [{ cron: 15 }] } },
    { success: false, result: { schedules: [] } },
  ]) {
    assert.throws(
      () => parseLiveSchedulerScheduleEnvelope(malformed),
      /Cron response schema is invalid/,
    );
  }
  for (const crons of [
    [],
    ["0 0 * * *"],
    ["15 18 * * *", "0 0 * * *"],
    ["15 18 * * *", "15 18 * * *"],
  ]) {
    assert.match(
      validateLiveSchedulerSchedule({ crons }, { targets }).join(" "),
      /Cron/,
    );
  }
});

test("scheduler provenance bootstrap is isolated to the legacy unannotated Worker", async () => {
  const targets = JSON.parse(
    await readFile(new URL("../config/release-targets.json", import.meta.url), "utf8"),
  );
  const versionId = "22222222-3333-4444-8555-666666666666";
  const status = {
    id: "11111111-2222-4333-8444-555555555555",
    strategy: "percentage",
    versions: [{ version_id: versionId, percentage: 100 }],
  };
  const legacyVersion = {
    id: versionId,
    metadata: {
      source: "wrangler",
      created_on: "2026-08-13T12:35:12.000Z",
    },
    annotations: {
      "workers/message": null,
      "workers/tag": null,
    },
    resources: {
      script: { etag: "d".repeat(64) },
      script_runtime: { compatibility_date: "2026-08-13" },
      bindings: [
        {
          name: "ACCOUNT_DELETION_BATCH_LIMIT",
          type: "plain_text",
          text: "5",
        },
        { name: "ACCOUNT_DELETION_OPERATIONS_SECRET", type: "secret_text" },
        {
          name: "TORUDAKE_SITE_ORIGIN",
          type: "plain_text",
          text: targets.productionUrl,
        },
      ],
    },
  };
  assert.deepEqual(
    validateSchedulerBootstrapCandidate(
      status,
      legacyVersion,
      { crons: ["15 18 * * *"] },
      { targets },
    ),
    [],
  );
  const annotated = structuredClone(legacyVersion);
  annotated.annotations["workers/message"] = "already released";
  assert.match(
    validateSchedulerBootstrapCandidate(
      status,
      annotated,
      { crons: ["15 18 * * *"] },
      { targets },
    ).join(" "),
    /legacy unannotated/,
  );
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
  assert.equal(migrations.at(-1), "0026_odd_blob.sql");
  assert.equal(migrations.length, 27);

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

test("canonical release docs require all external manifests and verified wrappers", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /TORUDAKE_PAGES_ARTIFACT_MANIFEST/);
  assert.match(readme, /TORUDAKE_ROLLBACK_MANIFEST/);
  assert.match(readme, /TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST/);
  assert.match(readme, /previousSchedulerManifest/);
  assert.match(readme, /newSchedulerManifest/);
  assert.match(readme, /--bootstrap-previous-provenance/);
  assert.match(readme, /bootstrap-account-deletion-scheduler-provenance/);
  assert.match(readme, /wrangler triggers deploy/);
  assert.match(readme, /release:pages -- --prepare/);
  assert.match(readme, /release:pages -- --deploy/);
  assert.match(readme, /deploy-cloudflare-pages/);
  assert.match(readme, /artifact SHA入りmessage/);
  assert.match(readme, /reviewed-clean-release-worktree/);
  assert.doesNotMatch(readme, /torudake-release-src-20260810/);
  assert.match(
    readme,
    /release:pages -- --prepare[\s\S]*ops:deploy-account-deletion-scheduler -- --execute[\s\S]*TORUDAKE_ROLLBACK_MANIFEST[\s\S]*run release:preflight[\s\S]*release:pages -- --deploy/,
  );

  const operations = await readFile(
    new URL("../docs/operations/production-operations.md", import.meta.url),
    "utf8",
  );
  assert.match(operations, /versions upload/);
  assert.match(operations, /wrangler triggers deploy/);
  assert.match(operations, /Schedules API/);
  assert.match(operations, /Manifest schema v2/);
  assert.match(operations, /bootstrap_confirmation/);
  assert.match(operations, /Cloudflare-generated active deployment ID/);
  assert.match(operations, /descriptor-stable reader/);
  assert.match(operations, /exclusively\s+hard-linking/);
  assert.match(operations, /Pages artifact preparation and verified deploy/);
  assert.match(operations, /TORUDAKE_PAGES_ARTIFACT_MANIFEST/);
  assert.match(operations, /torudake-pages-v1 commit=/);
  assert.match(operations, /"schemaVersion": 2/);
  assert.match(operations, /previousVersionId/);
  assert.match(operations, /ID-addressed detail API/);
});
