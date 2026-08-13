# Paid-service support playbook

## Intake

Ask for only:

- request ID shown in the response/header;
- device and OS/browser version;
- UTC/JST occurrence time;
- the named step: plan selection, Checkout, return from Stripe, preview,
  export, save, passkey sign-in, refund or dispute;
- Stripe receipt/payment ID only when needed, never a card number.

Do **not** ask users to attach their video, audio, subtitle file, narration
script, transcript, passkey data, secret, webhook payload, or full screen that
contains personal data. Redact email addresses and names from support records.

No support SLA has been approved. Do not promise a response or resolution time.
Incident owner, backup owner, communications owner and target times are
`awaiting assignment` until management approves them.

## Duplicate charge

1. Collect request ID, time, plan and Stripe receipt/payment IDs.
2. Check local purchase/subscription state and Stripe independently. Do not
   create another Checkout session.
3. Determine whether there are two captured payments, or one authorization plus
   one capture. Preserve evidence before refunding.
4. Refund only the confirmed duplicate through Stripe. Confirm the legitimate
   entitlement remains active and the refund webhook completed.

## Save failed after an allowance was consumed

1. Collect request ID, device, exact step and time; do not collect the media.
2. Check whether export validation completed and whether the usage reservation
   was completed, released or left pending.
3. If no validated downloadable file was produced, follow the reviewed credit
   restoration procedure. Never edit D1 ad hoc.
4. Record the reason and verify the allowance once. Avoid retries that could
   issue multiple credits.

## All passkeys lost

1. Never bypass passkey authentication or accept emailed identity claims as
   proof by themselves.
2. Use only the reviewed account-recovery workflow and its audit trail.
3. Revoke old sessions/passkeys after recovery, require a new passkey, and have
   the user verify plan/credit state.
4. If the recovery workflow cannot establish ownership, escalate; do not merge
   or transfer billing records manually.

## Refund or dispute

1. Find the Stripe object and webhook delivery using request ID/time where
   available.
2. Verify refund/dispute state, local purchase state and remaining credits.
3. Confirm the webhook revoked only the affected unused allowance. Do not
   restore already-consumed service after a refund.
4. For a dispute, preserve the terms/transaction audit trail without exporting
   user media or transcript content. Route any legal decision to the owner.

## Outage communication

1. Confirm impact using public and detailed health, Functions metrics and
   structured logs.
2. State affected functions, start time, current workaround and next update
   only when known. Do not speculate about data loss or payment state.
3. Disable payment entry points only through the reviewed incident control;
   keep account/status access available when safe.
4. On recovery, verify detailed health, payment smoke, one non-mutating account
   status read and Stripe webhook backlog before posting resolution.

