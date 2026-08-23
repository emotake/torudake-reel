import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DISABLED_FLAGS,
  EXPECTED_LIVE_FLAGS,
  assertFlagMap,
  parsePagesAuthFlagArguments,
} from "../scripts/operations/pages-auth-flags.mjs";

const readSource = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("CI verifies pull requests and main before preserving the exact Pages artifact", async () => {
  const workflow = await readSource(".github/workflows/ci.yml");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\s+branches:\s+- main/s);
  assert.match(workflow, /permissions:\s+contents: read/s);
  assert.match(workflow, /persist-credentials: false/);
  for (const command of [
    "pnpm release:preflight:offline",
    "pnpm exec tsc --noEmit --incremental false",
    "pnpm lint",
    "pnpm test",
    "pnpm release:pages -- --prepare",
  ]) {
    assert.ok(workflow.includes(command));
  }
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /include-hidden-files: true/);
});

test("preview CD consumes CI artifacts without exposing credentials to PR code", async () => {
  const workflow = await readSource(".github/workflows/preview-deploy.yml");
  assert.match(workflow, /workflow_run:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /head_repository\.full_name == github\.repository/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /CLOUDFLARE_PAGES_API_TOKEN/);
  assert.match(workflow, /gh run download/);
  assert.match(workflow, /--no-bundle/);
  assert.match(workflow, /review-pr-/);
  assert.match(workflow, /staging-main/);
  assert.match(workflow, /Preview authentication must remain disabled/);
});

test("production CD is manual, approved, and uses only hardened release wrappers", async () => {
  const workflow = await readSource(".github/workflows/production-deploy.yml");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /CLOUDFLARE_PRODUCTION_API_TOKEN/);
  assert.match(workflow, /TEMP: \$\{\{ runner\.temp \}\}/);
  assert.match(workflow, /TMP: \$\{\{ runner\.temp \}\}/);
  assert.doesNotMatch(workflow, /OPS_HEALTH_SECRET/);
  assert.match(workflow, /pnpm release:pages -- --prepare/);
  assert.match(workflow, /--provision-disabled-rollback/);
  assert.match(workflow, /Emergency authentication restoration/);
  assert.match(workflow, /steps\.disable_auth\.outputs\.attempted == 'true'/);
  assert.match(workflow, /steps\.restore_auth\.outputs\.restored != 'true'/);
  assert.match(workflow, /pnpm ops:payment-smoke/);
  assert.doesNotMatch(workflow, /pnpm exec wrangler pages deploy/);
});

test("auth flag helper is fail-closed and keeps snapshots outside the repository", () => {
  const capture = parsePagesAuthFlagArguments([
    "--capture",
    "--output",
    "D:\\ci-state\\flags.json",
  ]);
  assert.equal(capture.mode, "capture");
  assert.throws(
    () =>
      parsePagesAuthFlagArguments([
        "--disable",
        "--snapshot",
        "D:\\ci-state\\flags.json",
        "--execute",
      ]),
    /requires --execute --confirm/,
  );
  assert.doesNotThrow(() =>
    assertFlagMap({ ...DISABLED_FLAGS }, DISABLED_FLAGS, "Disabled"),
  );
  assert.equal(EXPECTED_LIVE_FLAGS.LINE_LOGIN_ENABLED, "true");
  assert.equal(EXPECTED_LIVE_FLAGS.GOOGLE_OIDC_ENABLED, "false");
});
