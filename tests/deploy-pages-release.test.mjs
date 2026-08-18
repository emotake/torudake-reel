import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  DEPLOY_CONFIRMATION,
  PREPARE_CONFIRMATION,
  assertWranglerCwdHasNoConfig,
  isPinnedLegacyPreviousProduction,
  listAllProductionDeployments,
  pagesBuildCommands,
  pagesDeployArguments,
  parsePagesReleaseArguments,
  runPagesReleaseCommand,
  validateAnalyticsEngineTables,
  validateDeploymentProbePayloads,
  validateLivePagesDeployment,
  validatePagesDeploymentRecord,
  validatePreviousPagesDeployment,
} from "../scripts/operations/deploy-pages-release.mjs";
import {
  computePagesArtifactAggregate,
  pagesReleaseMessage,
} from "../lib/pages-release-artifact.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const FILE_HASH = "b".repeat(64);
const DEPLOYMENT_ID = "11111111-2222-4333-8444-555555555555";
const OLD_DEPLOYMENT_ID = "f8bee356-6458-4c91-9e29-b3febcd5e4fc";
const LEGACY_SOURCE_COMMIT =
  "35abc4dde3d45a48b2d422da8f37a3b314e036ee";
const LEGACY_COMMIT_MESSAGE =
  "fix: harden LINE login lifecycle and observability";
const LEGACY_CREATED_ON = "2026-08-18T08:51:43.113033Z";
const FOREIGN_DEPLOYMENT_ID = "33333333-4444-4555-8666-777777777777";
const ALTERNATE_DEPLOYMENT_ID = "44444444-5555-4666-8777-888888888888";
const NOW = "2026-08-18T12:00:00.000Z";

function targetsFixture() {
  return {
    hosting: "cloudflare-pages-direct-upload",
    cloudflareAccountId: "e7572bf15e2fc4346e54f72ed7cb3ff0",
    pagesProject: "torudake-reel",
    productionBranch: "main",
    productionUrl: "https://torudake-reel.pages.dev",
    d1Binding: "DB",
    d1DatabaseId: "c0b9cc06-fc19-4e02-acac-2c19d32f3fdc",
    authObservabilityBinding: "AUTH_OBSERVABILITY",
    authObservabilityDataset: "torudake_line_auth_events",
    pagesArtifact: {
      root: "dist/cloudflare-pages",
      releaseMessagePrefix: "torudake-pages-v1",
      manifestEnvironmentVariable: "TORUDAKE_PAGES_ARTIFACT_MANIFEST",
      manifestSchemaVersion: 1,
      deployConfirmation: "deploy-cloudflare-pages",
    },
    rollbackPolicy: {
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
        deploymentId: OLD_DEPLOYMENT_ID,
        sourceCommit: LEGACY_SOURCE_COMMIT,
        commitMessage: LEGACY_COMMIT_MESSAGE,
        createdOn: LEGACY_CREATED_ON,
        methodsSchema: "line_only_without_authentication_flags",
      },
    },
  };
}

function manifestFixture() {
  const files = [{ path: "_worker.js", size: 20, sha256: FILE_HASH }];
  const aggregateSha256 = computePagesArtifactAggregate(files);
  return {
    schemaVersion: 1,
    artifactRoot: "dist/cloudflare-pages",
    sourceCommit: SOURCE_COMMIT,
    generatedAt: "2026-08-18T11:00:00.000Z",
    fileCount: 1,
    totalBytes: 20,
    aggregateSha256,
    deploymentMessage: pagesReleaseMessage(SOURCE_COMMIT, aggregateSha256),
    files,
  };
}

function deploymentFixture(manifest = manifestFixture()) {
  return {
    id: DEPLOYMENT_ID,
    project_name: "torudake-reel",
    environment: "production",
    production_branch: "main",
    url: "https://11111111.torudake-reel.pages.dev/",
    created_on: "2026-08-18T11:59:00.000Z",
    latest_stage: { name: "deploy", status: "success" },
    is_skipped: false,
    deployment_trigger: {
      metadata: {
        branch: "main",
        commit_hash: SOURCE_COMMIT,
        commit_message: manifest.deploymentMessage,
        commit_dirty: false,
      },
    },
    d1_databases: {
      DB: { id: "c0b9cc06-fc19-4e02-acac-2c19d32f3fdc" },
    },
    analytics_engine_datasets: {
      AUTH_OBSERVABILITY: { dataset: "torudake_line_auth_events" },
    },
  };
}

function historicalDeploymentFixture(manifest, index) {
  return {
    ...deploymentFixture(manifest),
    id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    url: `https://history-${index}.torudake-reel.pages.dev/`,
  };
}

async function createProject(t) {
  const base = process.platform === "win32" ? "D:\\CodexTemp" : tmpdir();
  await mkdir(base, { recursive: true });
  const container = await mkdtemp(join(base, "torudake-pages-wrapper-"));
  t.after(async () => {
    await rm(container, { recursive: true, force: true });
  });
  const projectRoot = join(container, "project");
  const externalRoot = join(container, "release");
  await mkdir(join(projectRoot, "config"), { recursive: true });
  await mkdir(externalRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "config", "release-targets.json"),
    JSON.stringify(targetsFixture()),
  );
  return {
    projectRoot,
    externalRoot,
    manifestPath: join(externalRoot, "pages-artifact.json"),
  };
}

function outputCollector() {
  const writes = [];
  return {
    output: { write: (value) => writes.push(value) },
    writes,
  };
}

function spawnHarness(
  projectRoot,
  calls,
  { deployment = true, onDeploy = () => undefined } = {},
) {
  return (executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    assert.equal(options.shell, false);
    if (executable === "git") {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") {
        return { status: 0, stdout: `${projectRoot}\n`, stderr: "" };
      }
      if (command === "rev-parse --verify HEAD^{commit}") {
        return { status: 0, stdout: `${SOURCE_COMMIT}\n`, stderr: "" };
      }
      if (command === "status --porcelain=v1 --untracked-files=all") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    }
    if (args.includes("whoami")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          accounts: [{ id: targetsFixture().cloudflareAccountId }],
        }),
        stderr: "",
      };
    }
    if (args.includes("auth") && args.includes("token")) {
      return {
        status: 0,
        stdout: JSON.stringify({ type: "oauth", token: "x".repeat(40) }),
        stderr: "",
      };
    }
    if (!deployment && args.includes("pages") && args.includes("deploy")) {
      return { status: 1, stdout: "", stderr: "" };
    }
    if (args.includes("pages") && args.includes("deploy")) onDeploy(options, args);
    return { status: 0, stdout: "", stderr: "" };
  };
}

function stubArtifactOperations(manifest, calls) {
  return {
    assertExternalPath: async (options) => {
      calls.push({ operation: "assertExternalPath", options });
      return resolve(options.manifestPath);
    },
    createManifest: async (options) => {
      calls.push({ operation: "createManifest", options });
      return manifest;
    },
    readManifest: async (path) => {
      calls.push({ operation: "readManifest", path });
      return manifest;
    },
    verifyManifest: async (_manifest, options) => {
      calls.push({ operation: "verifyManifest", options });
      return manifest;
    },
    verifyArtifactDirectory: async (_manifest, options) => {
      calls.push({ operation: "verifyArtifactDirectory", options });
      return manifest;
    },
    createSnapshot: async (_manifest, options) => {
      const path = join(options.externalRoot, ".torudake-pages-stage-test");
      calls.push({ operation: "createSnapshot", options, path });
      return path;
    },
    createExternalTempDirectory: async (options) => {
      const path = join(options.externalRoot, `${options.prefix}test`);
      calls.push({ operation: "createExternalTempDirectory", options, path });
      return path;
    },
    removeExternalTempDirectory: async (path, options) => {
      calls.push({ operation: "removeExternalTempDirectory", path, options });
    },
    assertWranglerCwd: async (path) => {
      calls.push({ operation: "assertWranglerCwd", path });
    },
    writeManifest: async (path) => {
      calls.push({ operation: "writeManifest", path });
      return path;
    },
    writeDeploymentRecord: async (path, record, context) => {
      calls.push({ operation: "writeDeploymentRecord", path, record, context });
      validatePagesDeploymentRecord(record, {
        deployment: context.deployment,
        manifest: context.manifest,
        targets: context.targets,
        releaseMode: context.releaseMode,
        probe: context.probe,
        analyticsEngine: context.analyticsEngine,
      });
      return path;
    },
  };
}

function jsonResponse(value, { noStore = false, status = 200 } = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      ...(noStore ? { "cache-control": "private, no-store" } : {}),
    },
  });
}

function paginatedInventoryBehavior(deployments, transform) {
  const urls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    urls.push(url);
    assert.equal(url.searchParams.get("env"), "production");
    assert.equal(url.searchParams.get("per_page"), "25");
    const page = Number(url.searchParams.get("page"));
    const result = deployments.slice((page - 1) * 25, page * 25);
    const payload = {
      success: true,
      result,
      result_info: {
        page,
        per_page: 25,
        count: result.length,
        total_count: deployments.length,
        total_pages: Math.ceil(deployments.length / 25),
      },
    };
    transform?.(payload, { page, url });
    return jsonResponse(payload);
  };
  return { fetchImpl, urls };
}

function analyticsEngineTablesFixture(
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

function healthFixture() {
  return {
    status: "ready",
    requestId: "release-health-0001",
    timestamp: NOW,
  };
}

function methodsFixture(mode) {
  const disabled = mode === "disabled";
  return {
    authenticated: false,
    recentlyAuthenticated: false,
    accountMethods: {
      passkey: false,
      line: false,
      google: false,
      email: false,
    },
    passkey: false,
    line: !disabled,
    google: false,
    email: false,
    authenticationFlags: {
      OIDC_AUTH_ENABLED: !disabled,
      LINE_LOGIN_ENABLED: !disabled,
      GOOGLE_OIDC_ENABLED: false,
      EMAIL_AUTH_ENABLED: false,
      PASSKEY_AUTH_ENABLED: false,
    },
  };
}

function pagesApiBehavior({
  manifest,
  releaseMode = "production",
  foreignDeployment = false,
  failNewProbe = false,
  failPreviousProbe = false,
  failAnalytics = false,
  failRollback = false,
  flipCanonicalBeforeDeploy = false,
  legacyPreviousMethods = false,
  legacyPreviousSourceMismatch = false,
  newMethodsWithoutFlags = false,
  multiPageInventory = false,
  existingInventorySize,
} = {}) {
  const newDeployment = deploymentFixture(manifest);
  const oldDeployment = {
    ...deploymentFixture(manifest),
    id: OLD_DEPLOYMENT_ID,
    url: "https://f8bee356.torudake-reel.pages.dev/",
    created_on: LEGACY_CREATED_ON,
    deployment_trigger: {
      metadata: {
        branch: "main",
        commit_hash: legacyPreviousSourceMismatch
          ? "c".repeat(40)
          : LEGACY_SOURCE_COMMIT,
        commit_message: LEGACY_COMMIT_MESSAGE,
        commit_dirty: false,
      },
    },
  };
  const foreign = {
    ...deploymentFixture(manifest),
    id: FOREIGN_DEPLOYMENT_ID,
    url: "https://33333333.torudake-reel.pages.dev/",
  };
  const alternate = {
    ...oldDeployment,
    id: ALTERNATE_DEPLOYMENT_ID,
    url: "https://44444444.torudake-reel.pages.dev/",
  };
  const historicalCount =
    existingInventorySize === undefined
      ? multiPageInventory
        ? 23
        : 0
      : existingInventorySize - 1;
  assert.ok(Number.isSafeInteger(historicalCount) && historicalCount >= 0);
  const historical = Array.from({ length: historicalCount }, (_, index) =>
    historicalDeploymentFixture(manifest, index + 1),
  );
  const state = {
    deployed: false,
    foreignDeployment,
    rolledBack: false,
    rollbackCalls: 0,
    projectReads: 0,
    fetchCalls: [],
  };
  const oldMode = "normal";
  const newMode =
    releaseMode === "disabled_rollback_provisioning" ? "disabled" : "normal";
  const fetchImpl = async (input, options) => {
    const url = new URL(String(input));
    state.fetchCalls.push({ url: url.href, options });
    if (url.pathname.endsWith("/analytics_engine/sql")) {
      assert.equal(options.method, "POST");
      assert.equal(options.body, "SHOW TABLES FORMAT JSON");
      assert.equal(options.headers["Content-Type"], "text/plain; charset=utf-8");
      return jsonResponse(
        analyticsEngineTablesFixture(
          failAnalytics ? [] : ["torudake_line_auth_events"],
        ),
      );
    }
    if (url.hostname.endsWith(".torudake-reel.pages.dev")) {
      const isNew = url.hostname.startsWith("11111111.");
      const mode = isNew ? newMode : oldMode;
      if (url.pathname === "/api/health") {
        const health = healthFixture();
        if ((!isNew && failPreviousProbe) || (isNew && failNewProbe)) {
          health.status = "not_ready";
        }
        return jsonResponse(health, { noStore: true });
      }
      if (url.pathname === "/api/account/auth/methods") {
        const methods = methodsFixture(mode);
        if (
          (!isNew && legacyPreviousMethods) ||
          (isNew && newMethodsWithoutFlags)
        ) {
          delete methods.authenticationFlags;
        }
        return jsonResponse(methods, { noStore: true });
      }
      assert.fail(`unexpected deployment probe ${url.href}`);
    }
    if (url.pathname.endsWith("/rollback")) {
      state.rollbackCalls += 1;
      if (failRollback) return jsonResponse({ success: false }, { status: 500 });
      state.rolledBack = true;
      return jsonResponse({ success: true, result: oldDeployment });
    }
    if (/\/deployments\/[0-9a-f-]+$/i.test(url.pathname)) {
      const id = url.pathname.split("/").at(-1).toLowerCase();
      const deployment =
        id === DEPLOYMENT_ID
          ? newDeployment
          : id === OLD_DEPLOYMENT_ID
            ? oldDeployment
            : id === FOREIGN_DEPLOYMENT_ID
              ? foreign
              : null;
      return jsonResponse({ success: Boolean(deployment), result: deployment });
    }
    if (url.pathname.endsWith("/deployments")) {
      assert.equal(url.searchParams.get("env"), "production");
      assert.equal(url.searchParams.get("per_page"), "25");
      const result = state.deployed
        ? [
            newDeployment,
            oldDeployment,
            ...historical,
            ...(flipCanonicalBeforeDeploy ? [alternate] : []),
            ...(state.foreignDeployment ? [foreign] : []),
          ]
        : [
            oldDeployment,
            ...historical,
            ...(flipCanonicalBeforeDeploy ? [alternate] : []),
          ];
      const page = Number(url.searchParams.get("page"));
      assert.ok(Number.isSafeInteger(page) && page >= 1);
      const pageResult = result.slice((page - 1) * 25, page * 25);
      const totalPages = Math.ceil(result.length / 25);
      return jsonResponse({
        success: true,
        result: pageResult,
        result_info: {
          page,
          per_page: 25,
          count: pageResult.length,
          total_count: result.length,
          total_pages: totalPages,
        },
      });
    }
    if (url.pathname.endsWith("/pages/projects/torudake-reel")) {
      state.projectReads += 1;
      const effectiveCanonicalId = state.rolledBack
        ? OLD_DEPLOYMENT_ID
        : state.deployed
          ? state.foreignDeployment
            ? FOREIGN_DEPLOYMENT_ID
            : DEPLOYMENT_ID
          : flipCanonicalBeforeDeploy && state.projectReads > 1
            ? ALTERNATE_DEPLOYMENT_ID
            : OLD_DEPLOYMENT_ID;
      return jsonResponse({
        success: true,
        result: {
          name: "torudake-reel",
          production_branch: "main",
          canonical_deployment: { id: effectiveCanonicalId },
        },
      });
    }
    assert.fail(`unexpected fetch ${url.href}`);
  };
  return { state, fetchImpl, newDeployment, oldDeployment };
}

test("deployment inventory uses per_page=25 and reads a complete 25+1 result", async () => {
  const manifest = manifestFixture();
  const expected = Array.from({ length: 26 }, (_, index) =>
    historicalDeploymentFixture(manifest, index + 1),
  );
  const behavior = paginatedInventoryBehavior(expected);
  const actual = await listAllProductionDeployments({
    fetchImpl: behavior.fetchImpl,
    token: "test-token",
    targets: targetsFixture(),
  });
  assert.deepEqual(
    actual.map((deployment) => deployment.id),
    expected.map((deployment) => deployment.id),
  );
  assert.deepEqual(
    behavior.urls.map((url) => url.searchParams.get("page")),
    ["1", "2"],
  );
  assert.ok(
    behavior.urls.every(
      (url) =>
        url.searchParams.get("env") === "production" &&
        url.searchParams.get("per_page") === "25",
    ),
  );
});

test("deployment inventory fails closed on malformed or inconsistent pagination", async (t) => {
  const manifest = manifestFixture();
  const deployments = Array.from({ length: 26 }, (_, index) =>
    historicalDeploymentFixture(manifest, index + 1),
  );
  const cases = [
    ["missing result_info field", (payload) => delete payload.result_info.count],
    ["extra result_info field", (payload) => (payload.result_info.extra = 1)],
    ["wrong response page", (payload) => (payload.result_info.page += 1)],
    ["wrong per_page", (payload) => (payload.result_info.per_page = 26)],
    ["noninteger count", (payload) => (payload.result_info.count = 24.5)],
    ["negative total_count", (payload) => (payload.result_info.total_count = -1)],
    ["non-derived total_pages", (payload) => (payload.result_info.total_pages = 1)],
    [
      "more than 50 pages",
      (payload) => {
        payload.result_info.total_count = 1251;
        payload.result_info.total_pages = 51;
      },
    ],
    [
      "short non-final page",
      (payload, { page }) => {
        if (page !== 1) return;
        payload.result.pop();
        payload.result_info.count = payload.result.length;
      },
    ],
    [
      "changed totals",
      (payload, { page }) => {
        if (page !== 2) return;
        payload.result_info.total_count = 27;
      },
    ],
    [
      "wrong final-page count",
      (payload, { page }) => {
        if (page !== 2) return;
        payload.result = [];
        payload.result_info.count = 0;
      },
    ],
    [
      "duplicate ID across pages",
      (payload, { page }) => {
        if (page !== 2) return;
        payload.result[0] = { ...payload.result[0], id: deployments[0].id };
      },
      /duplicate IDs/,
    ],
  ];
  for (const [name, transform, errorPattern = /pagination|page length/] of cases) {
    await t.test(name, async () => {
      const behavior = paginatedInventoryBehavior(deployments, transform);
      await assert.rejects(
        listAllProductionDeployments({
          fetchImpl: behavior.fetchImpl,
          token: "test-token",
          targets: targetsFixture(),
        }),
        errorPattern,
      );
    });
  }
});

test("release CLI arguments are strict and mutations require mode-specific confirmation", () => {
  assert.equal(
    parsePagesReleaseArguments([
      "--",
      "--prepare",
      "--manifest",
      "D:\\release\\artifact.json",
      "--external-root",
      "D:\\release",
    ]).mode,
    "prepare",
  );
  assert.deepEqual(
    parsePagesReleaseArguments([
      "--prepare",
      "--manifest",
      "D:\\release\\artifact.json",
      "--external-root",
      "D:\\release",
    ]).mode,
    "prepare",
  );
  assert.equal(
    parsePagesReleaseArguments([
      "--deploy",
      "--manifest",
      "D:\\release\\artifact.json",
      "--execute",
      "--confirm",
      DEPLOY_CONFIRMATION,
    ]).execute,
    true,
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--prepare",
        "--deploy",
        "--manifest",
        "D:\\release\\artifact.json",
      ]),
    /exactly one/,
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--prepare",
        "--manifest",
        "D:\\release\\artifact.json",
      ]),
    /external-root/,
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--deploy",
        "--manifest",
        "D:\\release\\artifact.json",
        "--execute",
        "--confirm",
        "yes",
      ]),
    new RegExp(DEPLOY_CONFIRMATION),
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--prepare",
        "--manifest",
        "D:\\release\\artifact.json",
        "--external-root",
        "D:\\release",
        "--unknown",
      ]),
    /Unsupported/,
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--",
        "--",
        "--prepare",
        "--manifest",
        "D:\\release\\artifact.json",
        "--external-root",
        "D:\\release",
      ]),
    /separator/,
  );
  assert.throws(
    () =>
      parsePagesReleaseArguments([
        "--deploy",
        "--manifest",
        "relative-artifact.json",
      ]),
    /must be absolute/,
  );
});

test("build and deploy command vectors are fixed, shell-free Node invocations", () => {
  const root = resolve("D:\\reviewed-project");
  const buildCommands = pagesBuildCommands(root);
  assert.equal(buildCommands.length, 3);
  assert.ok(buildCommands.every((command) => command.executable === process.execPath));
  assert.deepEqual(
    buildCommands.map((command) => command.args.at(-1)),
    ["build", resolve(root, "scripts", "prepare-cloudflare-pages.mjs"), resolve(root, "cloudflare-pages.vite.config.mjs")],
  );

  const manifest = manifestFixture();
  const deploy = pagesDeployArguments({
    projectRoot: root,
    targets: targetsFixture(),
    manifest,
    artifactDirectory: resolve("D:\\release\\snapshot"),
  });
  assert.deepEqual(deploy.slice(1, 4), [
    "pages",
    "deploy",
    resolve("D:\\release\\snapshot"),
  ]);
  assert.ok(deploy.includes("--commit-dirty=false"));
  assert.ok(deploy.includes("--experimental-provision=false"));
  assert.ok(deploy.includes("--experimental-auto-create=false"));
  assert.equal(deploy.filter((value) => value === "--no-bundle").length, 1);
  assert.equal(deploy.includes("--skip-caching"), false);
  assert.equal(deploy[deploy.indexOf("--project-name") + 1], "torudake-reel");
  assert.equal(deploy[deploy.indexOf("--branch") + 1], "main");
  assert.equal(deploy[deploy.indexOf("--commit-hash") + 1], SOURCE_COMMIT);
  assert.equal(
    deploy[deploy.indexOf("--commit-message") + 1],
    manifest.deploymentMessage,
  );
});

test("isolated Wrangler cwd rejects configs in every ancestor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "torudake-wrangler-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const isolated = join(root, "release", "isolated");
  await mkdir(isolated, { recursive: true });
  await assertWranglerCwdHasNoConfig(isolated);

  const ancestorConfig = join(root, "release", "wrangler.jsonc");
  await writeFile(ancestorConfig, "{}\n");
  await assert.rejects(
    assertWranglerCwdHasNoConfig(isolated),
    /ancestor contains a Wrangler config/,
  );
  await rm(ancestorConfig);

  const redirectedConfig = join(root, ".wrangler", "deploy", "config.json");
  await mkdir(join(root, ".wrangler", "deploy"), { recursive: true });
  await writeFile(redirectedConfig, "{}\n");
  await assert.rejects(
    assertWranglerCwdHasNoConfig(isolated),
    /ancestor contains a Wrangler config/,
  );
});

test("live deployment validation binds commit, message, branch, status, and bindings", () => {
  const manifest = manifestFixture();
  const targets = targetsFixture();
  const deployment = deploymentFixture(manifest);
  assert.deepEqual(
    validateLivePagesDeployment(deployment, {
      targets,
      manifest,
      expectedDeploymentId: DEPLOYMENT_ID,
    }),
    [],
  );

  const dirty = structuredClone(deployment);
  dirty.deployment_trigger.metadata.commit_dirty = true;
  assert.match(
    validateLivePagesDeployment(dirty, { targets, manifest }).join(" "),
    /does not bind/,
  );
  const forgedMessage = structuredClone(deployment);
  forgedMessage.deployment_trigger.metadata.commit_message = "forged";
  assert.match(
    validateLivePagesDeployment(forgedMessage, { targets, manifest }).join(" "),
    /does not bind/,
  );
  const missingTelemetry = structuredClone(deployment);
  delete missingTelemetry.analytics_engine_datasets.AUTH_OBSERVABILITY;
  assert.match(
    validateLivePagesDeployment(missingTelemetry, { targets, manifest }).join(" "),
    /Analytics Engine/,
  );
  const missingSkipState = structuredClone(deployment);
  delete missingSkipState.is_skipped;
  assert.match(
    validateLivePagesDeployment(missingSkipState, { targets, manifest }).join(" "),
    /not successfully deployed/,
  );
  const nonCanonicalTime = structuredClone(deployment);
  nonCanonicalTime.created_on = "2026-08-18T09:00:00Z";
  assert.match(
    validatePreviousPagesDeployment(nonCanonicalTime, {
      targets,
      expectedDeploymentId: DEPLOYMENT_ID,
    }).join(" "),
    /creation time/,
  );
  const cloudflareMicrosecondTime = structuredClone(deployment);
  cloudflareMicrosecondTime.created_on = "2026-08-18T08:51:43.113033Z";
  assert.deepEqual(
    validatePreviousPagesDeployment(cloudflareMicrosecondTime, {
      targets,
      expectedDeploymentId: DEPLOYMENT_ID,
    }),
    [],
  );
  for (const createdOn of [
    "2026-08-18T08:51:43.1130331234Z",
    "2026-08-18T08:51:43.113033+00:00",
    "2026-02-30T08:51:43.113033Z",
    "2026-08-18T08:51:43.113033Z trailing",
  ]) {
    const invalidTimestamp = structuredClone(deployment);
    invalidTimestamp.created_on = createdOn;
    assert.match(
      validatePreviousPagesDeployment(invalidTimestamp, {
        targets,
        expectedDeploymentId: DEPLOYMENT_ID,
      }).join(" "),
      /creation time/,
    );
  }
  assert.deepEqual(
    validatePreviousPagesDeployment(deployment, {
      targets,
      expectedDeploymentId: DEPLOYMENT_ID,
      expectedManifest: manifest,
    }),
    [],
  );

  const legacyPrevious = structuredClone(deployment);
  legacyPrevious.deployment_trigger.metadata.commit_message = "legacy production release";
  assert.deepEqual(
    validatePreviousPagesDeployment(legacyPrevious, {
      targets,
      expectedDeploymentId: DEPLOYMENT_ID,
    }),
    [],
  );
  assert.match(
    validatePreviousPagesDeployment(legacyPrevious, {
      targets,
      expectedDeploymentId: DEPLOYMENT_ID,
      expectedManifest: manifest,
    }).join(" "),
    /reviewed rollback artifact/,
  );
});

test("mode probes require exact methods, raw flags, health, and Analytics Engine dataset", () => {
  const targets = targetsFixture();
  assert.deepEqual(
    validateDeploymentProbePayloads(
      healthFixture(),
      methodsFixture("normal"),
      { targets, mode: "normal", checkedAt: new Date(NOW) },
    ),
    [],
  );
  const legacyMethods = methodsFixture("normal");
  delete legacyMethods.authenticationFlags;
  assert.match(
    validateDeploymentProbePayloads(healthFixture(), legacyMethods, {
      targets,
      mode: "normal",
      checkedAt: new Date(NOW),
    }).join(" "),
    /raw flags/,
  );
  assert.deepEqual(
    validateDeploymentProbePayloads(healthFixture(), legacyMethods, {
      targets,
      mode: "normal",
      checkedAt: new Date(NOW),
      allowLegacyMethodsWithoutAuthenticationFlags: true,
    }),
    [],
  );
  for (const mutate of [
    (methods) => {
      methods.unexpected = true;
    },
    (methods) => {
      methods.line = false;
    },
    (methods) => {
      methods.authenticated = true;
    },
    (methods) => {
      methods.accountMethods.line = true;
    },
  ]) {
    const invalidLegacyMethods = structuredClone(legacyMethods);
    mutate(invalidLegacyMethods);
    assert.match(
      validateDeploymentProbePayloads(healthFixture(), invalidLegacyMethods, {
        targets,
        mode: "normal",
        checkedAt: new Date(NOW),
        allowLegacyMethodsWithoutAuthenticationFlags: true,
      }).join(" "),
      /raw flags/,
    );
  }
  assert.match(
    validateDeploymentProbePayloads(healthFixture(), legacyMethods, {
      targets,
      mode: "disabled",
      checkedAt: new Date(NOW),
      allowLegacyMethodsWithoutAuthenticationFlags: true,
    }).join(" "),
    /raw flags/,
  );
  assert.deepEqual(
    validateDeploymentProbePayloads(
      healthFixture(),
      methodsFixture("disabled"),
      { targets, mode: "disabled", checkedAt: new Date(NOW) },
    ),
    [],
  );
  const enabledDisabledLine = methodsFixture("disabled");
  enabledDisabledLine.authenticationFlags.LINE_LOGIN_ENABLED = true;
  assert.match(
    validateDeploymentProbePayloads(healthFixture(), enabledDisabledLine, {
      targets,
      mode: "disabled",
      checkedAt: new Date(NOW),
    }).join(" "),
    /raw flags/,
  );
  const extra = { ...methodsFixture("normal"), unexpected: true };
  assert.match(
    validateDeploymentProbePayloads(healthFixture(), extra, {
      targets,
      mode: "normal",
      checkedAt: new Date(NOW),
    }).join(" "),
    /raw flags/,
  );
  assert.equal(
    validateAnalyticsEngineTables(
      analyticsEngineTablesFixture(),
      "torudake_line_auth_events",
    ),
    true,
  );
  assert.equal(
    validateAnalyticsEngineTables(
      analyticsEngineTablesFixture([
        "torudake_line_auth_events",
        "another_dataset",
      ]),
      "torudake_line_auth_events",
    ),
    true,
  );
  assert.throws(
    () =>
      validateAnalyticsEngineTables(
        analyticsEngineTablesFixture(["different"]),
        "torudake_line_auth_events",
      ),
    /not uniquely queryable/,
  );
  assert.throws(
    () =>
      validateAnalyticsEngineTables(
        analyticsEngineTablesFixture([
          "torudake_line_auth_events",
          "torudake_line_auth_events",
        ]),
        "torudake_line_auth_events",
      ),
    /not uniquely queryable/,
  );
  assert.throws(
    () => {
      const payload = analyticsEngineTablesFixture();
      payload.data.push(null);
      payload.rows += 1;
      return validateAnalyticsEngineTables(payload, "torudake_line_auth_events");
    },
    /malformed/,
  );
  assert.throws(
    () => {
      const payload = analyticsEngineTablesFixture();
      payload.data = [{ name: "torudake_line_auth_events" }];
      return validateAnalyticsEngineTables(payload, "torudake_line_auth_events");
    },
    /malformed/,
  );
  assert.throws(
    () => {
      const payload = analyticsEngineTablesFixture();
      payload.data[0].unexpected = true;
      return validateAnalyticsEngineTables(payload, "torudake_line_auth_events");
    },
    /malformed/,
  );
  for (const mutate of [
    (payload) => {
      payload.meta[0].name = "name";
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
    const payload = analyticsEngineTablesFixture();
    mutate(payload);
    assert.throws(
      () =>
        validateAnalyticsEngineTables(payload, "torudake_line_auth_events"),
      /malformed/,
    );
  }
  for (const payload of [
    { data: [{ dataset: "torudake_line_auth_events" }] },
    { ...analyticsEngineTablesFixture(), rows: 1.5 },
    { ...analyticsEngineTablesFixture(), rows: -1 },
    {
      ...analyticsEngineTablesFixture(),
      rows_before_limit_at_least: 1.5,
    },
  ]) {
    assert.throws(
      () =>
        validateAnalyticsEngineTables(payload, "torudake_line_auth_events"),
      /malformed/,
    );
  }
  assert.equal(
    validateAnalyticsEngineTables(
      analyticsEngineTablesFixture(["torudake_line_auth_events"], {
        rowsBeforeLimit: undefined,
      }),
      "torudake_line_auth_events",
    ),
    true,
  );
});

test("legacy previous-production adoption is pinned to one immutable deployment", () => {
  const targets = targetsFixture();
  const legacy = deploymentFixture();
  legacy.id = OLD_DEPLOYMENT_ID;
  legacy.created_on = LEGACY_CREATED_ON;
  legacy.deployment_trigger.metadata.commit_hash = LEGACY_SOURCE_COMMIT;
  legacy.deployment_trigger.metadata.commit_message = LEGACY_COMMIT_MESSAGE;
  assert.equal(
    isPinnedLegacyPreviousProduction(legacy, {
      targets,
      releaseMode: "disabled_rollback_provisioning",
    }),
    true,
  );
  assert.equal(
    isPinnedLegacyPreviousProduction(legacy, {
      targets,
      releaseMode: "production",
    }),
    true,
  );
  assert.equal(
    isPinnedLegacyPreviousProduction(
      { ...legacy, id: FOREIGN_DEPLOYMENT_ID },
      { targets, releaseMode: "production" },
    ),
    false,
  );
  const wrongMessage = structuredClone(legacy);
  wrongMessage.deployment_trigger.metadata.commit_message = "different";
  assert.equal(
    isPinnedLegacyPreviousProduction(wrongMessage, {
      targets,
      releaseMode: "production",
    }),
    false,
  );
  assert.equal(
    isPinnedLegacyPreviousProduction(
      { ...legacy, created_on: "2026-08-18T08:51:43.113034Z" },
      { targets, releaseMode: "production" },
    ),
    false,
  );
  assert.equal(
    isPinnedLegacyPreviousProduction(legacy, {
      targets,
      releaseMode: "preview",
    }),
    false,
  );
});

test("prepare dry-run is non-mutating and execute runs the fixed build before manifest write", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const drySpawns = [];
  const dryOperations = [];
  const dryOutput = outputCollector();
  const dryResult = await runPagesReleaseCommand({
    argv: [
      "--prepare",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, drySpawns),
    artifactOperations: stubArtifactOperations(manifest, dryOperations),
    output: dryOutput.output,
  });
  assert.equal(dryResult.mutationPerformed, false);
  assert.ok(drySpawns.every((call) => call.executable === "git"));
  assert.equal(
    dryOperations.some((call) => call.operation === "writeManifest"),
    false,
  );

  const executeSpawns = [];
  const executeOperations = [];
  const executed = await runPagesReleaseCommand({
    argv: [
      "--prepare",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
      "--execute",
      "--confirm",
      PREPARE_CONFIRMATION,
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, executeSpawns),
    artifactOperations: stubArtifactOperations(manifest, executeOperations),
    output: outputCollector().output,
    now: () => new Date(NOW),
  });
  assert.equal(executed.artifactSha256, manifest.aggregateSha256);
  const nonGit = executeSpawns.filter((call) => call.executable !== "git");
  assert.equal(nonGit.length, 3);
  assert.ok(nonGit.every((call) => call.options.shell === false));
  assert.deepEqual(
    executeOperations
      .filter((call) => ["createManifest", "writeManifest"].includes(call.operation))
      .map((call) => call.operation),
    ["createManifest", "writeManifest"],
  );
});

test("deploy dry-run verifies and preflights but never deploys or writes a record", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const spawns = [];
  const operations = [];
  const result = await runPagesReleaseCommand({
    argv: [
      "--deploy",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
      "--provision-disabled-rollback",
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, spawns, {
      deployment: false,
    }),
    artifactOperations: stubArtifactOperations(manifest, operations),
    output: outputCollector().output,
  });
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.releaseMode, "disabled_rollback_provisioning");
  const preflight = spawns.find((call) =>
    call.args.some((arg) => arg.endsWith("release-preflight.mjs")),
  );
  assert.ok(preflight);
  assert.deepEqual(preflight.args.slice(-3), [
    "--provision-disabled-rollback",
    "--confirm",
    "provision-disabled-line-rollback",
  ]);
  assert.equal(
    spawns.some((call) => call.args.includes("pages") && call.args.includes("deploy")),
    false,
  );
  assert.equal(
    operations.some((call) => call.operation === "writeDeploymentRecord"),
    false,
  );
});

test("normal deploy uses isolated cwd and snapshot, probes, AE, and exact record", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest, legacyPreviousMethods: true });
  const spawns = [];
  const operations = [];
  const result = await runPagesReleaseCommand({
    argv: [
      "--deploy",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
      "--execute",
      "--confirm",
      DEPLOY_CONFIRMATION,
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, spawns, {
      onDeploy: () => {
        behavior.state.deployed = true;
      },
    }),
    fetchImpl: behavior.fetchImpl,
    sleep: async () => assert.fail("successful deployment should not poll"),
    artifactOperations: stubArtifactOperations(manifest, operations),
    output: outputCollector().output,
    now: () => new Date(NOW),
  });
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.equal(result.restoredDeploymentId, null);
  assert.equal(behavior.state.rollbackCalls, 0);

  const wranglerCwd = join(
    fixture.externalRoot,
    ".torudake-pages-wrangler-test",
  );
  const directWrangler = spawns.filter(
    (call) =>
      call.args.includes("whoami") ||
      call.args.includes("auth") ||
      (call.args.includes("pages") && call.args.includes("deploy")),
  );
  assert.equal(directWrangler.length, 3);
  assert.ok(directWrangler.every((call) => call.options.cwd === wranglerCwd));
  const deploy = directWrangler.find((call) => call.args.includes("pages"));
  assert.equal(
    deploy.args[deploy.args.indexOf("deploy") + 1],
    join(fixture.externalRoot, ".torudake-pages-stage-test"),
  );
  assert.equal(deploy.args.includes(resolve(fixture.projectRoot, ".wrangler")), false);

  const operationNames = operations.map((operation) => operation.operation);
  assert.ok(operationNames.indexOf("createSnapshot") < operationNames.indexOf("verifyArtifactDirectory"));
  assert.ok(operationNames.includes("removeExternalTempDirectory"));
  const record = operations.find(
    (operation) => operation.operation === "writeDeploymentRecord",
  );
  assert.equal(record.record.recordType, "torudake-pages-deployment");
  assert.equal(record.record.artifactSha256, manifest.aggregateSha256);
  assert.equal(record.record.commitDirty, false);
  assert.ok(
    behavior.state.fetchCalls.some(
      (call) =>
        call.url.endsWith("/analytics_engine/sql") &&
        call.options.headers.Authorization === `Bearer ${"x".repeat(40)}`,
    ),
  );
  const probes = behavior.state.fetchCalls.filter((call) =>
    call.url.includes(".pages.dev/api/"),
  );
  assert.ok(probes.length >= 4);
  assert.ok(probes.every((call) => !call.options.headers.Authorization));
});

test("disabled rollback provisioning records rollback schema then restores prior normal", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    releaseMode: "disabled_rollback_provisioning",
    legacyPreviousMethods: true,
  });
  const spawns = [];
  const operations = [];
  const result = await runPagesReleaseCommand({
    argv: [
      "--deploy",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
      "--provision-disabled-rollback",
      "--execute",
      "--confirm",
      DEPLOY_CONFIRMATION,
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, spawns, {
      onDeploy: () => {
        behavior.state.deployed = true;
      },
    }),
    fetchImpl: behavior.fetchImpl,
    sleep: async () => assert.fail("successful deployment should not poll"),
    artifactOperations: stubArtifactOperations(manifest, operations),
    output: outputCollector().output,
    now: () => new Date(NOW),
  });
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.equal(result.restoredDeploymentId, OLD_DEPLOYMENT_ID);
  assert.equal(behavior.state.rollbackCalls, 1);
  assert.equal(behavior.state.rolledBack, true);
  const record = operations.find(
    (operation) => operation.operation === "writeDeploymentRecord",
  ).record;
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.disabledDeploymentId, DEPLOYMENT_ID);
  assert.deepEqual(record.authenticationMethods, {
    passkey: false,
    line: false,
    google: false,
    email: false,
  });
  assert.deepEqual(record.authenticationFlags, {
    OIDC_AUTH_ENABLED: "false",
    LINE_LOGIN_ENABLED: "false",
    GOOGLE_OIDC_ENABLED: "false",
    EMAIL_AUTH_ENABLED: "false",
    PASSKEY_AUTH_ENABLED: "false",
  });
  assert.equal(record.artifact.aggregateSha256, manifest.aggregateSha256);
  assert.equal(record.verification.authObservabilityDatasetQueryable, true);
  assert.equal(record.verification.healthCheckedAt, NOW);
  assert.equal(record.verification.methodsCheckedAt, NOW);
  assert.equal(record.verification.analyticsEngineCheckedAt, NOW);
  assert.equal(record.verification.verifiedAt, NOW);
});

test("1250 existing deployments exhaust safe release capacity before upload", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest, existingInventorySize: 1250 });
  const spawns = [];
  const operations = [];
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, spawns, {
        onDeploy: () => {
          behavior.state.deployed = true;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, operations),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /no capacity for a safely verified release/,
  );
  assert.equal(behavior.state.deployed, false);
  assert.equal(behavior.state.rollbackCalls, 0);
  assert.equal(
    spawns.some(
      (call) => call.args.includes("pages") && call.args.includes("deploy"),
    ),
    false,
  );
  assert.equal(
    operations.some((operation) => operation.operation === "writeDeploymentRecord"),
    false,
  );
  const listUrls = behavior.state.fetchCalls
    .map((call) => new URL(call.url))
    .filter((url) => url.pathname.endsWith("/deployments"));
  assert.equal(listUrls.length, 50);
  assert.equal(listUrls.at(-1).searchParams.get("page"), "50");
  assert.ok(listUrls.every((url) => url.searchParams.get("per_page") === "25"));
});

test("1249 existing deployments leave room to verify and roll back one candidate", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    releaseMode: "disabled_rollback_provisioning",
    legacyPreviousMethods: true,
    existingInventorySize: 1249,
  });
  const operations = [];
  const result = await runPagesReleaseCommand({
    argv: [
      "--deploy",
      "--manifest",
      fixture.manifestPath,
      "--external-root",
      fixture.externalRoot,
      "--provision-disabled-rollback",
      "--execute",
      "--confirm",
      DEPLOY_CONFIRMATION,
    ],
    projectRoot: fixture.projectRoot,
    spawnCommand: spawnHarness(fixture.projectRoot, [], {
      onDeploy: () => {
        behavior.state.deployed = true;
      },
    }),
    fetchImpl: behavior.fetchImpl,
    sleep: async () => assert.fail("successful deployment should not poll"),
    artifactOperations: stubArtifactOperations(manifest, operations),
    output: outputCollector().output,
    now: () => new Date(NOW),
  });
  assert.equal(result.deploymentId, DEPLOYMENT_ID);
  assert.equal(result.restoredDeploymentId, OLD_DEPLOYMENT_ID);
  assert.equal(behavior.state.rollbackCalls, 1);
  assert.equal(behavior.state.rolledBack, true);
  assert.ok(
    operations.some((operation) => operation.operation === "writeDeploymentRecord"),
  );
  const listUrls = behavior.state.fetchCalls
    .map((call) => new URL(call.url))
    .filter((url) => url.pathname.endsWith("/deployments"));
  assert.ok(listUrls.some((url) => url.searchParams.get("page") === "50"));
  assert.ok(listUrls.every((url) => url.searchParams.get("per_page") === "25"));
});

test("an unpinned legacy methods payload is rejected before Pages upload", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    legacyPreviousMethods: true,
    legacyPreviousSourceMismatch: true,
  });
  const spawns = [];
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, spawns),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /raw flags/,
  );
  assert.equal(
    spawns.some(
      (call) => call.args.includes("pages") && call.args.includes("deploy"),
    ),
    false,
  );
  assert.equal(behavior.state.rollbackCalls, 0);
});

test("a new candidate without raw authentication flags is rolled back", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    legacyPreviousMethods: true,
    newMethodsWithoutFlags: true,
  });
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          behavior.state.deployed = true;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /raw flags/,
  );
  assert.equal(behavior.state.rollbackCalls, 1);
  assert.equal(behavior.state.rolledBack, true);
});

test("full paginated inventory detects foreign concurrency without rollback mutation", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    foreignDeployment: true,
    multiPageInventory: true,
  });
  const operations = [];
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          behavior.state.deployed = true;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      sleep: async () => assert.fail("concurrency failure should not poll"),
      artifactOperations: stubArtifactOperations(manifest, operations),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /foreign concurrent.*rollback.*refused/is,
  );
  assert.equal(behavior.state.rollbackCalls, 0);
  assert.equal(behavior.state.rolledBack, false);
  const listUrls = behavior.state.fetchCalls
    .map((call) => new URL(call.url))
    .filter((url) => url.pathname.endsWith("/deployments"));
  assert.ok(listUrls.length >= 4);
  assert.deepEqual(
    new Set(listUrls.map((url) => url.searchParams.get("page"))),
    new Set(["1", "2"]),
  );
  assert.ok(
    listUrls.every(
      (url) =>
        url.searchParams.get("env") === "production" &&
        url.searchParams.get("per_page") === "25",
    ),
  );
  assert.equal(
    operations.some((operation) => operation.operation === "writeDeploymentRecord"),
    false,
  );
});

test("foreign deployment appearing during record creation blocks rollback mutation", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest });
  const operations = [];
  const artifactOperations = stubArtifactOperations(manifest, operations);
  const writeRecord = artifactOperations.writeDeploymentRecord;
  artifactOperations.writeDeploymentRecord = async (...args) => {
    const result = await writeRecord(...args);
    behavior.state.foreignDeployment = true;
    return result;
  };
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          behavior.state.deployed = true;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations,
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /Production changed before the release record.*rollback.*refused/is,
  );
  assert.equal(behavior.state.rollbackCalls, 0);
  assert.ok(
    operations.some((operation) => operation.operation === "writeDeploymentRecord"),
  );
});

test("transient cleanup failure is retried before rollback", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest });
  const operations = [];
  const artifactOperations = stubArtifactOperations(manifest, operations);
  let snapshotCleanupAttempts = 0;
  artifactOperations.removeExternalTempDirectory = async (path, options) => {
    operations.push({ operation: "removeExternalTempDirectory", path, options });
    if (path.includes(".torudake-pages-stage-")) {
      snapshotCleanupAttempts += 1;
      if (snapshotCleanupAttempts === 1) {
        throw new Error("transient snapshot cleanup failure");
      }
    }
  };
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          behavior.state.deployed = true;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations,
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /previous production was restored.*cleanup failed/i,
  );
  assert.equal(snapshotCleanupAttempts, 2);
  assert.equal(behavior.state.rollbackCalls, 1);
});

test("post-deploy probe or AE failure rolls back; rollback failure reports both", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const probeFailure = pagesApiBehavior({ manifest, failNewProbe: true });
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          probeFailure.state.deployed = true;
        },
      }),
      fetchImpl: probeFailure.fetchImpl,
      sleep: async () => undefined,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /previous production was restored/i,
  );
  assert.equal(probeFailure.state.rollbackCalls, 1);

  const rollbackFailure = pagesApiBehavior({
    manifest,
    failAnalytics: true,
    failRollback: true,
  });
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--deployment-record",
        join(fixture.externalRoot, "second-record.json"),
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          rollbackFailure.state.deployed = true;
        },
      }),
      fetchImpl: rollbackFailure.fetchImpl,
      sleep: async () => undefined,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /Analytics Engine.*Automatic rollback also failed/i,
  );
  assert.equal(rollbackFailure.state.rollbackCalls, 1);
});

test("failed deploy with previous canonical already active performs no rollback POST", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest });
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        deployment: false,
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /previous production was restored.*Pages deployment failed/i,
  );
  assert.equal(behavior.state.rollbackCalls, 0);
  assert.equal(behavior.state.rolledBack, false);
});

test("pre-deploy canonical probe failure performs neither deploy nor rollback", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({ manifest, failPreviousProbe: true });
  let deployCalls = 0;
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          deployCalls += 1;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /health payload/i,
  );
  assert.equal(deployCalls, 0);
  assert.equal(behavior.state.rollbackCalls, 0);
});

test("pre-upload canonical change is rejected without deploy or rollback", async (t) => {
  const fixture = await createProject(t);
  const manifest = manifestFixture();
  const behavior = pagesApiBehavior({
    manifest,
    flipCanonicalBeforeDeploy: true,
  });
  let deployCalls = 0;
  await assert.rejects(
    runPagesReleaseCommand({
      argv: [
        "--deploy",
        "--manifest",
        fixture.manifestPath,
        "--external-root",
        fixture.externalRoot,
        "--execute",
        "--confirm",
        DEPLOY_CONFIRMATION,
      ],
      projectRoot: fixture.projectRoot,
      spawnCommand: spawnHarness(fixture.projectRoot, [], {
        onDeploy: () => {
          deployCalls += 1;
        },
      }),
      fetchImpl: behavior.fetchImpl,
      artifactOperations: stubArtifactOperations(manifest, []),
      output: outputCollector().output,
      now: () => new Date(NOW),
    }),
    /changed immediately before upload/,
  );
  assert.equal(deployCalls, 0);
  assert.equal(behavior.state.rollbackCalls, 0);
});
