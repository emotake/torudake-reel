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

1. Run `pnpm release:preflight` from drive D. It must confirm the exact D1
   migration ledger, `quick_check`, and foreign keys.
2. Run tests, lint, TypeScript and the Cloudflare Pages build.
3. Deploy the reviewed commit only.
4. Run `pnpm ops:health:detailed` and `pnpm ops:payment-smoke`.
5. In a browser, confirm plan labels and that Checkout opens. Stop before
   confirming payment. A controlled real transaction requires separate written
   approval and a refund/reconciliation plan.

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
