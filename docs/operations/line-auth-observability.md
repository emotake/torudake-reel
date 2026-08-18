# LINE authentication observability

LINE authentication emits two privacy-safe telemetry copies:

1. Structured `console` events for real-time Pages deployment tails.
2. One data point per lifecycle event in the Workers Analytics Engine dataset
   `torudake_line_auth_events`. This is the durable source of truth for LINE
   authentication history because legacy Pages Functions tail logs are not
   stored. Analytics Engine retains data for three months.

Production Pages settings remain dashboard-managed. Before deploying this
feature, add an Analytics Engine binding named `AUTH_OBSERVABILITY` to the
production environment and select the dataset `torudake_line_auth_events`.
Redeploy after changing the binding. The dataset is created automatically on
the first write after the binding is deployed.

Do not add a partial root `wrangler.jsonc` just for this binding. Cloudflare
treats a deployed Pages Wrangler file as the source of truth, so a partial file
can remove existing variables and bindings. The release preflight intentionally
rejects that configuration until a complete dashboard export has been reviewed.

## Privacy contract

The dataset must never contain an authorization code, access or ID token,
state, nonce, provider subject, subject hash, email address, cookie, IP address,
user agent or Cloudflare Ray ID. Authentication request and correlation IDs are fresh
server-generated UUIDs; public request headers are ignored so an attacker
cannot persist a token-like value. URL queries are discarded; only the route
path is stored. Arbitrary error text is never stored, and error codes must
match `^[a-z][a-z0-9_]{0,63}$`.

`config/observability.json`, the release preflight and automated tests enforce
this contract. Do not append fields to the data point without updating all
three and completing a privacy review.

## Dataset schema version 1

| Column | Meaning |
| --- | --- |
| `index1` | Constant provider key: `line` |
| `blob1` | Schema version (`1`) |
| `blob2` | Lifecycle event |
| `blob3` | Severity (`info`, `warn`, `error`) |
| `blob4` | Operation (`start`, `callback`, `finalize`) |
| `blob5` | Outcome (`succeeded`, `received`, `cancelled`, `rejected`, `failed`) |
| `blob6` | Bounded machine error code or empty string |
| `blob7` | HTTP method |
| `blob8` | Route path without query |
| `blob9` | Request ID |
| `blob10` | Correlation ID |
| `double1` | HTTP status |

Lifecycle events are `line_oidc_start_succeeded`,
`line_oidc_start_rejected`, `line_oidc_callback_received`,
`line_oidc_callback_rejected`, `line_oidc_completion_succeeded`,
`line_oidc_completion_cancelled`, and `line_oidc_completion_failed`.

## Queries

Create a least-privilege token with Account Analytics Read permission and send
the SQL text to the documented Analytics Engine SQL API. Never put that token
in the repository or a command transcript.

Daily completions for the last 30 days:

```sql
SELECT
  toStartOfDay(timestamp) AS day,
  blob5 AS outcome,
  sum(_sample_interval) AS events
FROM torudake_line_auth_events
WHERE timestamp > NOW() - INTERVAL '30' DAY
  AND blob4 = 'finalize'
GROUP BY day, outcome
ORDER BY day ASC, outcome ASC
```

Monthly completion rate:

```sql
SELECT
  toStartOfMonth(timestamp) AS month,
  sumIf(_sample_interval, blob5 = 'succeeded') AS successes,
  sumIf(_sample_interval, blob5 IN ('succeeded', 'cancelled', 'failed')) AS completions,
  successes / completions AS success_rate
FROM torudake_line_auth_events
WHERE blob4 = 'finalize'
GROUP BY month
ORDER BY month ASC
```

Failure codes for the last seven days:

```sql
SELECT
  blob6 AS error_code,
  double1 AS status,
  sum(_sample_interval) AS events
FROM torudake_line_auth_events
WHERE timestamp > NOW() - INTERVAL '7' DAY
  AND blob5 IN ('failed', 'rejected')
GROUP BY error_code, status
ORDER BY events DESC
```

Correlate an incident by its safe request ID:

```sql
SELECT timestamp, blob2 AS event, blob5 AS outcome, blob6 AS error_code,
       double1 AS status
FROM torudake_line_auth_events
WHERE blob9 = 'REPLACE_WITH_REQUEST_ID'
ORDER BY timestamp ASC
LIMIT 50
```

After each production deployment, complete one successful LINE login and one
cancelled login, then confirm both terminal events are queryable. A missing
dataset means that the binding has not been deployed or no lifecycle event has
written yet. A `line_auth_analytics_write_failed` console event means durable
telemetry degraded while the authentication response continued. A
`line_auth_analytics_binding_missing` event means the production binding is
absent; stop the release, add the binding, and redeploy.

Official references:

- https://developers.cloudflare.com/pages/functions/bindings/#analytics-engine
- https://developers.cloudflare.com/analytics/analytics-engine/get-started/
- https://developers.cloudflare.com/analytics/analytics-engine/sql-api/
- https://developers.cloudflare.com/analytics/analytics-engine/limits/
- https://developers.cloudflare.com/pages/functions/debugging-and-logging/
