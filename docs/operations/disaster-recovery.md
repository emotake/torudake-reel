# Disaster recovery

This public repository is sufficient to rebuild the application code, schema,
tests and Cloudflare Pages artifact. It intentionally does not contain runtime
credentials, account recovery codes, cardholder data, customer media or a D1
data export.

## Recovery sources

| Source | Purpose | May contain plaintext secrets |
|---|---|---|
| `emotake/torudake-reel` | Source, migrations, tests and reviewed configuration contracts | No |
| `emotake/torudake-reel-recovery` (private) | SOPS/age encrypted secret bundle, sanitized provider configuration and backup catalog | No |
| GitHub-external age identity | Decrypt the recovery bundle | Yes; never commit |
| Encrypted OneDrive and offline backup | D1 SQL export | Only after local decryption |
| Provider owner accounts | Reissue OpenAI, Stripe, LINE and Cloudflare credentials | Provider-managed |

GitHub Actions secrets and Cloudflare secrets are runtime/deployment stores,
not the canonical recovery copy. Their values are not copied into logs or this
repository.

## Values that must remain stable

- `OIDC_AUTH_SECRET` and `LINE_LOGIN_CHANNEL_ID` participate in the stored LINE
  identity derivation. When an existing D1 database is restored, do not change
  either value without a reviewed identity migration.
- Stripe Price IDs and the production webhook endpoint must continue to refer
  to the intended live account and catalog.
- D1 database contents are required to restore accounts, entitlements, usage
  reservations and the payment event ledger. Migrations alone do not restore
  those records.

Other API credentials should be reissued with least privilege when compromise
is suspected. Rotate both sides of shared application secrets together.

## Backup safety

`wrangler d1 export` writes customer data. Export only to a private temporary
directory, encrypt it with the recovery age recipient, verify a decrypt round
trip and remove the plaintext. Do not commit SQL, SQLite or compressed database
files, even to the private recovery repository.

The private recovery repository contains the exact restore order and a verifier
that reports missing names without printing secret values. A recovery is not
ready until that verifier passes and at least one encrypted D1 backup has a
verified SHA-256 entry.

## Restore safety

Cloudflare D1 Time Travel and import operations can overwrite production data.
Always restore into an isolated database first, validate the migration ledger,
`PRAGMA quick_check` and foreign keys, then plan the production cutover and
rollback. A recovery check must not create a Stripe Checkout session, charge a
card, replay a webhook or enable authentication automatically.

References:

- https://developers.cloudflare.com/d1/reference/time-travel/
- https://developers.cloudflare.com/d1/best-practices/import-export-data/
- https://developers.cloudflare.com/pages/functions/bindings/#secrets
- https://docs.github.com/en/actions/concepts/security/secrets
- https://docs.stripe.com/keys
- https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety
