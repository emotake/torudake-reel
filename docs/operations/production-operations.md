# Production operations

This document is the operational source of truth for the paid service. It does
not authorize a deployment, a D1 mutation, or a real payment.

## Health and correlation

- `GET /api/health` is the public, dependency-minimal readiness probe. It
  exposes only `ready`/`not_ready`, timestamp, and a request ID.
- `GET /api/internal/health` checks D1, OpenAI configuration and Stripe account
  and catalog readiness. Send `Authorization: Bearer $OPS_HEALTH_SECRET`.
- `POST /api/internal/account-deletions` is the secret-gated, bounded executor
  for deletion requests whose 30-day grace period has ended. It defaults to a
  dry run and requires its dedicated `ACCOUNT_DELETION_OPERATIONS_SECRET`;
  the routine `OPS_HEALTH_SECRET` must not authorize it. See
  `account-recovery.md` before enabling execution.
  Configure the secret with `wrangler pages secret put`; never commit it.
  Each confirmed non-dry-run also deletes strictly expired rows from
  `account_auth_challenges`, `account_email_challenges`,
  `account_oauth_challenges`, and `account_recovery_challenges`. A row whose
  `expires_at` equals the current second is retained. Each table is deleted in
  batches of 100 for at most four rounds per run; each round groups the four
  bounded deletes in one D1 batch. The response and scheduler log contain
  counts only—never a state hash, nonce, PKCE verifier, email, contact hash, or
  user ID. The
  `batches` and `hasMore` fields make a remaining backlog explicit without
  exposing row data. The scheduler reports a non-successful invocation when
  `hasMore=true`, so the next invocation drains another bounded window.
  Retention and account deletion are independent: either operation is still
  attempted when the other fails. A retention failure is returned as
  `challengeRetention.status = failed`; the scheduler treats it as a failed
  run and retries on the next invocation.
- Every Pages response carries `X-Request-Id` and `X-Correlation-Id`. Only
  bounded safe identifiers are accepted from clients; otherwise the entry point
  creates a UUID. Use that same ID to search structured error logs.
- Deployment-tail and Functions metrics remain available, but Pages tail logs
  are transient. LINE authentication therefore writes its privacy-safe
  lifecycle events to the three-month
  `torudake_line_auth_events` Analytics Engine dataset. See
  `line-auth-observability.md`. `config/observability.json` is the reviewable
  sampling and alert contract. Production Pages bindings remain managed in the
  dashboard; a partial root `wrangler.jsonc` would replace that configuration
  and must not be deployed. `wrangler.d1.jsonc` is D1-maintenance-only and must
  never deploy Pages.

Run a non-mutating probe:

```powershell
pnpm ops:health
$env:OPS_HEALTH_SECRET = "<secret from the password manager>"
pnpm ops:health:detailed
```

## Alerts to configure

Alert destinations and the `AUTH_OBSERVABILITY` Analytics Engine binding
require reviewed Cloudflare dashboard changes; source control does not make
those external changes. Add the binding to the production Pages environment,
then redeploy the reviewed artifact. Deployment tails complement, but do not
replace, the durable LINE authentication dataset.

Print the no-mutation plan with `pnpm ops:cloudflare-alerts`. With a
read-only/Notifications token in the process environment, inspect eligible
alert types and existing policies with `pnpm ops:cloudflare-alerts --
--inspect`. The tool uses Cloudflare's documented `available_alerts` and
`policies` endpoints and never prints the token.

To create a deployment-failure policy, copy
`config/cloudflare-alert-policy.example.json` to an explicit private path on D,
replace the destination, and compare its filters with the `--inspect` output.
Only after review, run:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "<32-character account id>"
$env:CLOUDFLARE_API_TOKEN = "<Notifications Write token from secret store>"
pnpm ops:cloudflare-alerts -- --apply `
  --policy-file "D:\private\torudake-pages-policy.json" `
  --confirm-account $env:CLOUDFLARE_ACCOUNT_ID
```

The command refuses implicit updates and duplicate names. It configures a Pages
event policy only; it does not claim to detect application HTTP 5xx. As of the
reviewed Pages documentation, Functions metrics show invocation errors but
Pages log streams are not persisted. Keep the independent readiness monitor as
the primary low-traffic 5xx/readiness alarm.

1. Cloudflare Workers & Pages > `torudake-reel` > Functions metrics: alert or
   notify on three 5xx responses in five minutes. At low traffic, use the
   synthetic check below rather than a percentage-only alert.
2. Run `ops:health` every five minutes from an independent monitor; alert after
   two consecutive failures and include the returned request ID.
3. Stripe Workbench > Webhooks: enable failed-delivery notifications for the
   production endpoint. Any failed `invoice.paid`, `checkout.session.completed`,
   refund, or dispute event is urgent because entitlements depend on delivery.
4. Search Pages logs for `stripe_webhook_processing_failed`,
   `stripe_webhook_claim_failed`, `openai_*_failed`, and `http_server_error`.

Official references reviewed on 2026-08-13:

- https://developers.cloudflare.com/pages/functions/debugging-and-logging/
- https://developers.cloudflare.com/pages/functions/metrics/
- https://developers.cloudflare.com/api/resources/alerting/subresources/available_alerts/methods/list/
- https://developers.cloudflare.com/api/resources/alerting/subresources/policies/methods/create/

During an incident, capture UTC time, endpoint, status and request ID. Never
copy Stripe secrets, webhook bodies, scripts, transcripts or uploaded media
into a ticket or chat.

## Payment smoke check

`pnpm ops:payment-smoke` reads public readiness and the unauthenticated billing
status contract only. The script contains a denylist for Checkout, Portal and
Webhook mutation paths and rejects `--charge`/`--checkout`. It cannot create a
session or charge a card.

Before a production release:

1. Point `TORUDAKE_PAGES_ARTIFACT_MANIFEST` at the external full-tree manifest
   created from the clean reviewed HEAD. Point
   `TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST` at the external
   manifest created by the safe Worker release wrapper, and point
   `TORUDAKE_ROLLBACK_MANIFEST` at the externally verified disabled Pages
   rollback manifest. Run `pnpm release:preflight` from drive D. It must verify
   the live Worker version/ETag/bindings, the live Pages rollback deployment,
   exact D1 migration ledger, `quick_check`, and foreign keys. Provisioning
   modes are documented below; offline mode never authorizes activation.
2. Run tests, lint and TypeScript, then use `pnpm release:pages -- --prepare`
   to build and record every Pages input file. Do not deploy a directory made
   by a different build or commit.
3. Deploy only through `pnpm release:pages -- --deploy`; raw
   `wrangler pages deploy` is not an approved production path.
4. Run `pnpm ops:health:detailed` and `pnpm ops:payment-smoke`.
5. In a browser, confirm plan labels and that Checkout opens. Stop before
   confirming payment. A controlled real transaction requires separate written
   approval and a refund/reconciliation plan.

## GitHub Actions CI/CD

The repository has three intentionally separate pipelines:

1. `.github/workflows/ci.yml` runs the offline release preflight, TypeScript,
   lint, the complete test suite, and the Cloudflare Pages build for pull
   requests and `main`. It receives no Cloudflare, OpenAI, Stripe, LINE, or
   customer-data credentials. The exact Pages directory, including hidden
   files, is retained for seven days as the `cloudflare-pages` Actions artifact.
2. `.github/workflows/preview-deploy.yml` runs only after CI succeeds. It checks
   out deployment tooling from trusted `main`, downloads the reviewed artifact,
   and deploys it to `review-pr-<number>` or `staging-main`. Pull requests from
   forks never receive the preview credential. Preview authentication stays
   disabled and preview Pages has no production D1 binding, so this environment
   is for UI and routing review rather than account, billing, or data tests.
3. `.github/workflows/production-deploy.yml` is manual and protected by the
   GitHub `production` environment. It accepts only the exact lowercase commit
   currently at `origin/main`, repeats all verification, releases the deletion
   scheduler, provisions a disabled rollback deployment, restores the intended
   authentication flags even on failure, runs the online preflight, and deploys
   only through the hardened Pages wrapper. Successful non-secret release
   manifests replace the assets on the `production-state` GitHub release.

Configure these GitHub environments without putting credentials in source:

- Repository variables: `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_PAGES_PROJECT`.
- `preview` environment secret: `CLOUDFLARE_PAGES_API_TOKEN`, restricted to
  Cloudflare Pages Edit for the pinned account. If it is absent, CI still
  succeeds and the preview deployment reports that it was skipped.
- `production` environment secret: `CLOUDFLARE_PRODUCTION_API_TOKEN`. Grant
  only the permissions needed by the checked-in wrappers: Cloudflare Pages
  Edit, Workers Scripts Edit, D1 Read, and Account Analytics Read for the pinned
  account. Also set `OPS_HEALTH_SECRET` to the same detailed-readiness secret
  held by the production Pages environment. Require the repository owner as an
  environment reviewer.

Never use `pull_request_target` to build or execute pull-request code with a
Cloudflare secret. Never place an API token in a workflow variable, release
asset, artifact, command argument, log, or repository file.

## Stripe/webhook incident order

1. Do not replay an event until the D1 ledger health and current event state
   are known. Webhook processing is idempotent, but blind retries can hide a
   broader D1 incident.
2. Find the structured log using request ID, event type and UTC time.
3. Confirm Stripe event delivery state and the local `stripe_events` claim.
4. Run the release preflight read-only D1 checks. Do not edit the migration
   ledger manually; see `2026-08-13-d1-ledger-baseline.md`.
5. Replay only the single failed Stripe event from Stripe Workbench, then verify
   the account entitlement and event completion.
6. For refund or dispute events, verify that unused credit was revoked and used
   credit was not recreated. Escalate any mismatch before another mutation.

## Encrypted D1 backup and monthly restore drill

Cloudflare Time Travel is a short recovery window, not the long-lived offsite
backup. Once per month, from drive D:

1. Install `age` and `rclone`. Keep the age identity and recipient in a password
   manager/offline key store, never in this repository.
2. Set `TORUDAKE_BACKUP_AGE_RECIPIENT` and run:

   ```powershell
   ./scripts/operations/backup-d1.ps1 -OffsiteDestination "remote:torudake-d1"
   ```

3. Confirm both the encrypted `.age` object and manifest are present offsite.
   Plain SQL is deleted in `finally` even when transfer fails.
4. Download a recent encrypted backup to D and run:

   ```powershell
   ./scripts/operations/restore-drill.ps1 `
     -EncryptedBackup "D:\path\backup.sql.age" `
     -AgeIdentity "D:\secure\age-identity.txt"
   ```

5. Retain the generated `restore-drill.json` outside Git. The drill restores to
   local SQLite only; it never writes to production D1.

The production migration ledger is append-only. A restore is not complete
unless `PRAGMA quick_check` is `ok`, foreign-key violations are zero, and the
ledger contains every reviewed migration.

## Pages artifact preparation and verified deploy

`dist/cloudflare-pages` is ignored by Git, so a clean worktree alone does not
prove which bytes will be uploaded. From a clean reviewed HEAD, create one new
external directory and manifest on drive D:

```powershell
$pagesReleaseRoot = 'D:\private\torudake-pages-<commit>'
$pagesArtifactManifest = "$pagesReleaseRoot\pages-artifact.json"
New-Item -ItemType Directory -Force $pagesReleaseRoot | Out-Null
pnpm release:pages -- --prepare `
  --manifest $pagesArtifactManifest `
  --external-root $pagesReleaseRoot `
  --execute --confirm prepare-pages-release
$env:TORUDAKE_PAGES_ARTIFACT_MANIFEST = $pagesArtifactManifest
```

The manifest records the clean source commit, sorted relative paths, size and
SHA-256 of every regular file, total bytes, an aggregate SHA-256, and the exact
deployment message. Links, traversal, case-insensitive collisions, added,
removed, replaced, oversized, or concurrently changed files fail closed.

The same manifest is used for both the disabled rollback snapshot and the
restored Production deployment. Immediately before upload, the wrapper copies
every reviewed file into a new private snapshot outside the repository and
verifies that snapshot against the manifest. Wrangler runs from a separate
empty directory, so Vinext's generated `.wrangler/deploy/config.json` cannot
replace the Dashboard-managed Pages configuration. The wrapper pins
project/branch/commit/message/`commit_dirty=false`, uses `--no-bundle` so the
reviewed `_worker.js` bytes are not transformed again, and does not use
`--skip-caching`.
The exact deployment message is
`torudake-pages-v1 commit=<40-hex-commit> artifactSha256=<64-hex-sha256>`.

After upload, the wrapper rejects any concurrent Production deployment, checks
the Pages project canonical deployment plus list/detail metadata and both
required bindings, probes the deployment-specific health and authentication
method endpoints for the requested mode, and queries Analytics Engine with
`SHOW TABLES FORMAT JSON`. It then writes a new external deployment record
exclusively. Any post-upload failure triggers the Pages rollback API and a full
read-back of the previously verified canonical Production deployment.
The authenticated Cloudflare credential must include `Account Analytics: Read`;
the token value must remain in Wrangler's credential store and must never be
placed in a command argument, manifest, log, or chat.

## Account-deletion Worker release and rollback

Pages and `torudake-reel-account-deletion-scheduler` are one release unit. A
normal online preflight blocks Pages activation unless the active Worker is the
same clean Git commit and exact local Wrangler dry-run bundle. The release
wrapper uploads the fixed private bundle snapshot as a positional entry with
`--no-bundle`, and hashes it immediately before and after upload. The proof does not
trust a deployment message by itself: the release wrapper records the
Cloudflare-generated active deployment ID, version ID, script ETag, and live
bindings in a new external manifest after read-back. It also reads the
Cloudflare Workers Schedules API and requires exactly one Cron,
`15 18 * * *` (UTC; 03:15 JST).

For every normal release, keep the prior manifest as an immutable input and use
a different nonexistent path for the new output:

```powershell
$previousSchedulerManifest = 'D:\private\torudake-account-deletion-worker-<previous-commit>.json'
$newSchedulerManifest = 'D:\private\torudake-account-deletion-worker-<commit>.json'
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $previousSchedulerManifest
pnpm ops:deploy-account-deletion-scheduler -- --execute `
  --confirm deploy-account-deletion-scheduler `
  --manifest $newSchedulerManifest
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $newSchedulerManifest
```

Before upload, the wrapper reads the prior manifest through a bounded,
no-follow, descriptor-stable reader, validates its schema and exact-file
SHA-256, then compares its deployment ID, version ID, ETag, message, tag,
timestamp, runtime, bindings, and Cron with Cloudflare live state. A merely
single 100% active version is not an approved rollback point.

The wrapper then performs a local Wrangler dry-run, uses `wrangler versions upload`
to create an inactive version, and reads it back. Before activation it
runs `wrangler triggers deploy` from the pinned config and requires the
Schedules API to return exactly `15 18 * * *`. It rechecks that the approved
old version is still active, activates the verified new version at 100%, and
rechecks version, ETag, tag, and Cron immediately before and after exclusively
hard-linking the new manifest into its previously absent destination and
verifying its exact bytes. Trigger deployment is intentionally before activation.
Because the old Cron must already be exact before upload, this operation is
idempotent for the approved old version.

After any trigger attempt, recovery first reads the live active version set.
If only the approved previous version is active, the wrapper reapplies and
verifies the pinned Cron. It restores `previousVersionId` to 100% only when the
active set contains no version other than that previous version and the version
uploaded by the current release; it then re-verifies the previous ETag,
provenance, and Cron. A foreign, mixed-unknown, or unreadable active state
prohibits automatic version and Cron mutation so a concurrent release is never
overwritten. An unverified recovery is a critical failure. Cloudflare documents
that global Cron propagation may take up to 15 minutes; `liveVerified` records
the control-plane Schedules API state, not proof that every location has
propagated. No token or secret value is written to the manifest.

The currently deployed legacy Worker predates this manifest chain and has no
message/tag. Exactly once, with no scheduler manifest environment variable set,
use the isolated bootstrap confirmation:

```powershell
$newSchedulerManifest = 'D:\private\torudake-account-deletion-worker-<commit>.json'
Remove-Item Env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST -ErrorAction SilentlyContinue
pnpm ops:deploy-account-deletion-scheduler -- --execute `
  --bootstrap-previous-provenance `
  --confirm bootstrap-account-deletion-scheduler-provenance `
  --manifest $newSchedulerManifest
$env:TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST = $newSchedulerManifest
```

Bootstrap still requires a single 100% active Wrangler version, safe runtime
and bindings, exact live Cron, and null message/tag. It is rejected if an
external manifest is supplied or the active Worker is already annotated, so it
cannot bypass a normal provenance mismatch.

Manifest schema v2 is:

```json
{
  "schemaVersion": 2,
  "workerName": "torudake-reel-account-deletion-scheduler",
  "sourceCommit": "<40-character reviewed commit>",
  "bundleSha256": "<64-character local Wrangler dry-run SHA-256>",
  "deploymentMessage": "torudake-release-v1 commit=<commit> bundleSha256=<sha256>",
  "uploadTag": "torudake-<12 commit>-<12 bundle>-<8 random>",
  "activeDeploymentId": "<Cloudflare deployment UUID>",
  "activeVersionId": "<Cloudflare version UUID>",
  "previousVersionId": "<rollback version UUID>",
  "scriptEtag": "<64-character Cloudflare script ETag>",
  "deployedAt": "<ISO-8601 UTC timestamp>",
  "schedule": {
    "cron": "15 18 * * *",
    "liveVerified": true
  },
  "approvedPrevious": {
    "provenance": "external_manifest",
    "manifestSchemaVersion": 2,
    "manifestSha256": "<SHA-256 of exact prior manifest bytes>",
    "deploymentId": "<prior Cloudflare deployment UUID>",
    "versionId": "<prior Cloudflare version UUID>",
    "scriptEtag": "<prior Cloudflare script ETag>",
    "sourceCommit": "<prior reviewed commit>",
    "bundleSha256": "<prior local dry-run SHA-256>",
    "deploymentMessage": "<prior release annotation>",
    "uploadTag": "<prior upload tag>",
    "deployedAt": "<prior version timestamp>",
    "schedule": {
      "cron": "15 18 * * *",
      "liveVerified": true
    }
  },
  "verification": {
    "wranglerDryRunPassed": true,
    "activeTrafficPercentage": 100,
    "liveVersionReadBack": true
  }
}
```

For the one-time bootstrap manifest, `approvedPrevious.provenance` is
`bootstrap_confirmation`; `manifestSchemaVersion`, `manifestSha256`,
`sourceCommit`, `bundleSha256`, `deploymentMessage`, and `uploadTag` are all
`null`. The live deployment/version/ETag/timestamp/Cron identity remains
recorded.

For an emergency Worker-only rollback, review `previousVersionId`, then run:

```powershell
pnpm exec wrangler versions deploy <previous-version-id>@100% `
  --name torudake-reel-account-deletion-scheduler `
  --config wrangler.account-deletion-scheduler.jsonc --yes `
  --message "approved account-deletion Worker rollback"
pnpm exec wrangler triggers deploy `
  --name torudake-reel-account-deletion-scheduler `
  --config wrangler.account-deletion-scheduler.jsonc
```

Confirm `wrangler deployments status --json` reports only that version at
100%, and read the Workers Schedules API to confirm the only Cron is
`15 18 * * *`. The normal Pages preflight intentionally remains blocked after
an emergency Worker rollback until a new same-commit Worker manifest is
produced.

## Telemetry-preserving rollback target

A normal rollback target must be a successful Production deployment of the
same reviewed artifact with both `DB` and `AUTH_OBSERVABILITY` in its deployment
snapshot and all public authentication methods disabled. Pages deployment
bindings and variables are snapshots: changing a Dashboard variable does not
retroactively change an existing deployment. You must redeploy after disabling
the flags, and redeploy again after restoring the live flags.

The historical deployment
`04519766-9146-440a-9467-57e9ac56e4a5` lacks `AUTH_OBSERVABILITY`. It is
classified as `telemetry_degraded emergency_only` and must not be selected for
a normal rollback. If it is ever used to recover basic availability, record
the durable LINE-authentication telemetry gap as an incident.

The standard disabled deployment ID is stored in the wrapper-generated external
record on drive D rather than committed as a permanently stale live resource
ID. The record is created exclusively after artifact, deployment, mode and
telemetry verification; do not hand-author or edit it. Normal online preflight
reads that exact deployment through the ID-addressed detail API, proves it is a
successful deployment of the pinned Production project/branch, probes the
deployment-specific URL and queries Analytics Engine. This avoids a deployment
history window that could silently exclude an older valid rollback target. First
release the same-commit account-deletion Worker and set
`TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST` as described above, then
provision Pages as follows:

The first hardened release has one narrowly pinned compatibility rule for the
current immutable Production deployment
`f8bee356-6458-4c91-9e29-b3febcd5e4fc` at commit
`35abc4dde3d45a48b2d422da8f37a3b314e036ee`. That deployment predates the
`authenticationFlags` response field. During capture and automatic restoration
only, the wrapper may accept its exact seven-key anonymous LINE-only methods
payload without the five raw flags. The deployment ID, full commit, successful
Production metadata, D1 and Analytics Engine bindings, health response and
LINE-only method values must all match. No other deployment or response shape
uses this compatibility path, and every newly uploaded disabled or normal
deployment still requires all five raw flags.

1. Commit and review the exact release artifact. In the Pages Production
   Dashboard, confirm the `DB` and `AUTH_OBSERVABILITY` bindings, then set
   `OIDC_AUTH_ENABLED`, `LINE_LOGIN_ENABLED`, `GOOGLE_OIDC_ENABLED`,
   `EMAIL_AUTH_ENABLED`, and `PASSKEY_AUTH_ENABLED` to `false`.
2. Use the reviewed Pages artifact manifest and the wrapper's isolated
   rollback-provisioning mode. First run it without `--execute`, then execute
   only after reviewing the dry-run:

   ```powershell
   $disabledPagesDeploymentRecord = "$pagesReleaseRoot\disabled.deployment.json"
   pnpm release:pages -- --deploy `
     --manifest $pagesArtifactManifest `
     --external-root $pagesReleaseRoot `
     --deployment-record $disabledPagesDeploymentRecord `
     --provision-disabled-rollback
   pnpm release:pages -- --deploy `
     --manifest $pagesArtifactManifest `
     --external-root $pagesReleaseRoot `
     --deployment-record $disabledPagesDeploymentRecord `
     --provision-disabled-rollback `
     --execute --confirm deploy-cloudflare-pages
   ```

   This mode can authorize only creation of the disabled snapshot. It cannot
   authorize a normal production activation. It also fails unless the live
   account-deletion Worker matches its external manifest and the current commit.
3. The wrapper itself requires `/api/health` to be `ready`, all four public
   methods and five raw flags to be disabled, both required bindings to match,
   and `torudake_line_auth_events` to appear exactly once in the Analytics
   Engine SQL response. The generated `$disabledPagesDeploymentRecord` is the
   schema-v2 rollback manifest; do not copy it into a hand-authored file.
4. After recording the disabled deployment, the wrapper automatically calls the
   Pages rollback API to restore the previously verified LINE-enabled canonical
   Production deployment. It then rechecks canonical identity, readiness,
   LINE-first methods and raw flags. The one pinned legacy deployment described
   above is rechecked with its exact pre-flag schema instead. A disabled
   deployment must never remain active while the operator performs the remaining
   steps.
5. Restore the intended live Production flags in the Dashboard. Before the
   restoring redeploy, point `TORUDAKE_ROLLBACK_MANIFEST` at the wrapper record
   and keep both `TORUDAKE_PAGES_ARTIFACT_MANIFEST` and
   `TORUDAKE_ACCOUNT_DELETION_SCHEDULER_MANIFEST` pointed at their reviewed
   files. Run the normal online preflight. It blocks activation if either
   manifest refers to another artifact; if the Pages deployment cannot be read
   by its exact ID; if live project/status/branch/full commit, binding,
   readiness or five-flag checks fail; if the active Worker ID/ETag/annotation
   or bindings differ; or if either Cloudflare inspection is unavailable.
6. Redeploy the exact same reviewed artifact through the wrapper so the restored
   live variables become a new deployment snapshot:

   ```powershell
   $productionPagesDeploymentRecord = "$pagesReleaseRoot\production.deployment.json"
   pnpm release:pages -- --deploy `
     --manifest $pagesArtifactManifest `
     --external-root $pagesReleaseRoot `
     --deployment-record $productionPagesDeploymentRecord `
     --execute --confirm deploy-cloudflare-pages
   ```

   Repeat readiness and authentication-method checks. Keep Pages configuration
   Dashboard-authoritative; do not introduce a partial root `wrangler.jsonc`.
