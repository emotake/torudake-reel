# Provider usage aggregation

`provider_usage_daily` is the privacy-minimal source for provider cost review.
Its grain is exactly UTC day × provider × model × operation. It has no user,
actor, request, email, IP address, filename, media, script or transcript field.

The counters are additive: provider requests, successes, failures, text tokens,
audio tokens, actual/best-effort audio seconds, and input characters for legacy
speech endpoints priced by character. Recording is best effort: a missing D1
binding or write failure logs a privacy-safe warning and never changes the AI
response seen by the user.

`listProviderUsageDaily({ sinceDay, limit })` is the read contract for the
operator metrics API. The UI should label these values as provider-reported or
best-effort operational measurements, not invoices. OpenAI billing remains the
financial source of truth.

Coverage:

- Responses API: provider-reported input/output tokens.
- Realtime narration: `response.done` text/audio token fields and output PCM
  duration when present.
- Transcription: one row increment per actual upstream attempt and the returned
  media duration/segment extent when present.
- Legacy/fallback speech: request result, input characters, and best-effort
  requested/output duration because the Speech REST response has no usage body.

