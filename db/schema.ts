import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const videoTransfers = sqliteTable(
  "video_transfers",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id").notNull(),
    status: text("status", {
      enum: ["uploading", "complete", "deleted"],
    })
      .notNull()
      .default("uploading"),
    ownerEmail: text("owner_email"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("video_transfers_code_hash_unique").on(table.codeHash),
    index("video_transfers_expires_at_idx").on(table.expiresAt),
    index("video_transfers_status_idx").on(table.status),
  ],
);

export const videoTransferParts = sqliteTable(
  "video_transfer_parts",
  {
    id: text("id").primaryKey(),
    transferId: text("transfer_id").notNull(),
    partNumber: integer("part_number").notNull(),
    size: integer("size").notNull(),
    etag: text("etag"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("video_transfer_parts_transfer_id_idx").on(table.transferId),
  ],
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    billingEmail: text("billing_email"),
    fullName: text("full_name"),
    stripeCustomerId: text("stripe_customer_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_stripe_customer_id_unique").on(table.stripeCustomerId),
  ],
);

export const accountPasskeys = sqliteTable(
  "account_passkeys",
  {
    credentialId: text("credential_id").primaryKey(),
    userId: text("user_id").notNull(),
    publicKey: text("public_key").notNull(),
    counter: integer("counter").notNull().default(0),
    transports: text("transports"),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" })
      .notNull()
      .default(false),
    // Keep migration defaults ASCII-only so D1 tooling cannot corrupt the
    // value when a Windows shell uses a legacy code page. The UI localizes it.
    displayName: text("display_name").notNull().default("Device"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [index("account_passkeys_user_id_idx").on(table.userId)],
);

export const accountAuthChallenges = sqliteTable(
  "account_auth_challenges",
  {
    tokenHash: text("token_hash").primaryKey(),
    challenge: text("challenge").notNull(),
    ceremony: text("ceremony", {
      enum: ["registration", "authentication"],
    }).notNull(),
    userId: text("user_id"),
    expectedOrigin: text("expected_origin").notNull(),
    rpId: text("rp_id").notNull(),
    networkHash: text("network_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    index("account_auth_challenges_expires_at_idx").on(table.expiresAt),
    index("account_auth_challenges_network_created_idx").on(
      table.networkHash,
      table.createdAt,
    ),
  ],
);

export const accountSessions = sqliteTable(
  "account_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("account_sessions_user_id_idx").on(table.userId),
    index("account_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const captionProfiles = sqliteTable("caption_profiles", {
  userId: text("user_id").primaryKey(),
  mood: text("mood", {
    enum: ["auto", "soft", "refined", "bold", "pop", "vlog"],
  })
    .notNull()
    .default("auto"),
  accentColor: text("accent_color").notNull().default("#e45f4d"),
  brandName: text("brand_name").notNull().default(""),
  updatedAt: integer("updated_at").notNull(),
});

export const billingSubscriptions = sqliteTable(
  "billing_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripePriceId: text("stripe_price_id").notNull(),
    planKey: text("plan_key", {
      enum: ["starter", "standard", "legacy_1480"],
    })
      .notNull()
      .default("legacy_1480"),
    status: text("status").notNull(),
    currentPeriodStart: integer("current_period_start").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
    // A refund or dispute revokes only the invoiced billing period. When
    // Stripe advances current_period_start after renewal, access resumes.
    revokedPeriodStart: integer("revoked_period_start"),
    cancelAtPeriodEnd: integer("cancel_at_period_end", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("billing_subscriptions_user_id_idx").on(table.userId),
    index("billing_subscriptions_status_idx").on(table.status),
    index("billing_subscriptions_user_status_period_idx").on(
      table.userId,
      table.status,
      table.currentPeriodEnd,
      table.updatedAt,
    ),
  ],
);

export const accountRecoveryChallenges = sqliteTable(
  "account_recovery_challenges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"),
    contactHash: text("contact_hash").notNull(),
    networkHash: text("network_hash").notNull(),
    challengeHash: text("challenge_hash"),
    status: text("status", {
      enum: [
        "requested",
        "reviewing",
        "approved",
        "consumed",
        "rejected",
        "expired",
      ],
    })
      .notNull()
      .default("requested"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    reviewedAt: integer("reviewed_at"),
    consumedAt: integer("consumed_at"),
  },
  (table) => [
    index("account_recovery_contact_created_idx").on(
      table.contactHash,
      table.createdAt,
    ),
    index("account_recovery_network_created_idx").on(
      table.networkHash,
      table.createdAt,
    ),
    index("account_recovery_status_expires_idx").on(
      table.status,
      table.expiresAt,
    ),
  ],
);

export const accountDeletionRequests = sqliteTable(
  "account_deletion_requests",
  {
    userId: text("user_id").primaryKey(),
    status: text("status", {
      enum: ["scheduled", "cancelled", "completed"],
    })
      .notNull()
      .default("scheduled"),
    requestedAt: integer("requested_at").notNull(),
    executeAfter: integer("execute_after").notNull(),
    cancelledAt: integer("cancelled_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("account_deletion_status_execute_idx").on(
      table.status,
      table.executeAfter,
    ),
  ],
);

export const billingCheckoutLocks = sqliteTable(
  "billing_checkout_locks",
  {
    userId: text("user_id").primaryKey(),
    lockToken: text("lock_token").notNull(),
    requestId: text("request_id").notNull(),
    planKey: text("plan_key", { enum: ["starter", "standard"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("billing_checkout_locks_token_unique").on(table.lockToken),
    index("billing_checkout_locks_expires_at_idx").on(table.expiresAt),
  ],
);

export const billingRateLimits = sqliteTable(
  "billing_rate_limits",
  {
    userId: text("user_id").notNull(),
    action: text("action", {
      enum: ["one_time_checkout", "portal", "billing_documents"],
    }).notNull(),
    windowStartedAt: integer("window_started_at").notNull(),
    attempts: integer("attempts").notNull().default(1),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.action],
      name: "billing_rate_limits_user_action_pk",
    }),
    index("billing_rate_limits_updated_at_idx").on(table.updatedAt),
  ],
);

export const billingSubscriptionSyncLeases = sqliteTable(
  "billing_subscription_sync_leases",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    leaseToken: text("lease_token").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    uniqueIndex("billing_subscription_sync_leases_token_unique").on(
      table.leaseToken,
    ),
    index("billing_subscription_sync_leases_expires_at_idx").on(
      table.expiresAt,
    ),
  ],
);

export const billingPurchases = sqliteTable(
  "billing_purchases",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    stripePriceId: text("stripe_price_id").notNull(),
    credits: integer("credits").notNull().default(1),
    refundBlockingAmount: integer("refund_blocking_amount").notNull().default(0),
    disputeState: text("dispute_state"),
    revokedAt: integer("revoked_at"),
    stripeStateSyncedAt: integer("stripe_state_synced_at"),
    stripeStateSyncStartedAt: integer("stripe_state_sync_started_at"),
    purchasedAt: integer("purchased_at").notNull(),
  },
  (table) => [
    index("billing_purchases_user_id_idx").on(table.userId),
    index("billing_purchases_user_revoked_idx").on(
      table.userId,
      table.revokedAt,
    ),
    uniqueIndex("billing_purchases_payment_intent_unique").on(
      table.stripePaymentIntentId,
    ),
  ],
);

export const usageReservations = sqliteTable(
  "usage_reservations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    sourceDurationSeconds: integer("source_duration_seconds").notNull(),
    bucket: text("bucket", {
      enum: ["free", "subscription", "one_time", "operator"],
    }).notNull(),
    status: text("status", {
      enum: ["reserved", "completed", "released"],
    })
      .notNull()
      .default("reserved"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
    releaseRequestedAt: integer("release_requested_at"),
    billingPurchaseId: text("billing_purchase_id"),
  },
  (table) => [
    uniqueIndex("usage_reservations_idempotency_unique").on(
      table.idempotencyKey,
    ),
    index("usage_reservations_user_id_idx").on(table.userId),
    index("usage_reservations_status_idx").on(table.status),
    index("usage_reservations_billing_purchase_id_idx").on(
      table.billingPurchaseId,
    ),
    index("usage_reservations_user_status_expires_idx").on(
      table.userId,
      table.status,
      table.expiresAt,
    ),
    index("usage_reservations_user_status_bucket_created_idx").on(
      table.userId,
      table.status,
      table.bucket,
      table.createdAt,
    ),
  ],
);

export const usageReleaseIntents = sqliteTable(
  "usage_release_intents",
  {
    userId: text("user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestedAt: integer("requested_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.idempotencyKey],
      name: "usage_release_intents_user_key_pk",
    }),
    index("usage_release_intents_expires_at_idx").on(table.expiresAt),
  ],
);

export const operatorDevices = sqliteTable(
  "operator_devices",
  {
    slot: text("slot").primaryKey(),
    sessionHash: text("session_hash").notNull(),
    label: text("label").notNull(),
    activatedAt: integer("activated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("operator_devices_session_hash_unique").on(table.sessionHash),
    index("operator_devices_expires_at_idx").on(table.expiresAt),
    index("operator_devices_revoked_at_idx").on(table.revokedAt),
  ],
);

export const operatorUsageOperations = sqliteTable(
  "operator_usage_operations",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    operation: text("operation", {
      enum: [
        "transfer_upload",
        "transcribe",
        "narration_initial",
        "narration_script",
        "narration_speech",
        "narration_disclosure",
      ],
    }).notNull(),
    count: integer("count").notNull().default(1),
    successfulCount: integer("successful_count").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("operator_usage_operations_reservation_id_idx").on(
      table.reservationId,
    ),
    index("operator_usage_operations_updated_at_idx").on(table.updatedAt),
  ],
);

export const usageObservedDurations = sqliteTable(
  "usage_observed_durations",
  {
    reservationId: text("reservation_id").primaryKey(),
    observedMilliseconds: integer("observed_milliseconds")
      .notNull()
      .default(0),
    blockedAt: integer("blocked_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("usage_observed_durations_blocked_at_idx").on(table.blockedAt),
  ],
);

export const usageOperationLeases = sqliteTable(
  "usage_operation_leases",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    operation: text("operation", {
      enum: [
        "metered_ai",
        "transfer_upload",
        "transcribe",
        "narration_script",
        "narration_speech",
        "narration_disclosure",
      ],
    }).notNull(),
    leaseToken: text("lease_token").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("usage_operation_leases_expires_at_idx").on(table.expiresAt),
    index("usage_operation_leases_reservation_operation_expires_idx").on(
      table.reservationId,
      table.operation,
      table.expiresAt,
    ),
  ],
);

export const meteredAiActions = sqliteTable(
  "metered_ai_actions",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id").notNull(),
    actionId: text("action_id").notNull(),
    operation: text("operation", {
      enum: [
        "transcribe",
        "narration_initial",
        "narration_script",
        "narration_speech",
      ],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "succeeded", "failed"],
    })
      .notNull()
      .default("pending"),
    attemptCount: integer("attempt_count").notNull().default(1),
    observedMilliseconds: integer("observed_milliseconds")
      .notNull()
      .default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    succeededAt: integer("succeeded_at"),
    failedAt: integer("failed_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("metered_ai_actions_reservation_action_unique").on(
      table.reservationId,
      table.actionId,
    ),
    index("metered_ai_actions_reservation_status_idx").on(
      table.reservationId,
      table.status,
    ),
    index("metered_ai_actions_expires_at_idx").on(table.expiresAt),
  ],
);

export const operatorEnrollmentAttempts = sqliteTable(
  "operator_enrollment_attempts",
  {
    fingerprint: text("fingerprint").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    attempts: integer("attempts").notNull().default(1),
    blockedUntil: integer("blocked_until").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("operator_enrollment_attempts_updated_at_idx").on(
      table.updatedAt,
    ),
  ],
);

export const trialSessions = sqliteTable(
  "trial_sessions",
  {
    sessionHash: text("session_hash").primaryKey(),
    accountUserId: text("account_user_id"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("trial_sessions_expires_at_idx").on(table.expiresAt),
    index("trial_sessions_account_user_id_idx").on(table.accountUserId),
  ],
);

export const trialIssuanceFingerprints = sqliteTable(
  "trial_issuance_fingerprints",
  {
    fingerprintHash: text("fingerprint_hash").primaryKey(),
    networkHash: text("network_hash").notNull(),
    sessionHash: text("session_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (table) => [
    uniqueIndex("trial_issuance_session_hash_unique").on(table.sessionHash),
    index("trial_issuance_network_created_idx").on(
      table.networkHash,
      table.createdAt,
    ),
    index("trial_issuance_created_at_idx").on(table.createdAt),
  ],
);

export const stripeEvents = sqliteTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    createdAt: integer("created_at").notNull(),
    processedAt: integer("processed_at"),
  },
  (table) => [index("stripe_events_processed_at_idx").on(table.processedAt)],
);

export const aiDisclosureConfirmations = sqliteTable(
  "ai_disclosure_confirmations",
  {
    id: text("id").primaryKey(),
    confirmationId: text("confirmation_id").notNull(),
    userId: text("user_id"),
    sessionHash: text("session_hash").notNull(),
    action: text("action", { enum: ["export"] }).notNull(),
    disclosureMethod: text("disclosure_method", {
      enum: ["post_caption"],
    }).notNull(),
    termsVersion: text("terms_version").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("ai_disclosure_confirmation_id_unique").on(
      table.confirmationId,
    ),
    index("ai_disclosure_user_id_idx").on(table.userId),
    index("ai_disclosure_created_at_idx").on(table.createdAt),
  ],
);

/**
 * Privacy-safe product telemetry. `actor_hash` is an application-scoped hash
 * used only for abuse prevention and aggregate funnels; raw IP addresses,
 * email addresses, filenames, transcripts and scripts are never stored here.
 */
export const productEvents = sqliteTable(
  "product_events",
  {
    id: text("id").primaryKey(),
    eventName: text("event_name").notNull(),
    actorHash: text("actor_hash"),
    source: text("source", { enum: ["browser", "server"] }).notNull(),
    properties: text("properties").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("product_events_name_created_idx").on(
      table.eventName,
      table.createdAt,
    ),
    index("product_events_actor_created_idx").on(
      table.actorHash,
      table.createdAt,
    ),
    index("product_events_created_at_idx").on(table.createdAt),
  ],
);

export const productFeedback = sqliteTable(
  "product_feedback",
  {
    id: text("id").primaryKey(),
    actorHash: text("actor_hash").notNull(),
    rating: text("rating", { enum: ["helpful", "needs_work"] }).notNull(),
    context: text("context", {
      enum: ["preview", "export", "checkout", "general"],
    })
      .notNull()
      .default("general"),
    tags: text("tags").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("product_feedback_created_at_idx").on(table.createdAt),
    index("product_feedback_actor_created_idx").on(
      table.actorHash,
      table.createdAt,
    ),
  ],
);

/**
 * Privacy-minimal provider cost telemetry. Rows are aggregate-only: no user,
 * actor, request, media, script, transcript, or filename identifier is stored.
 */
export const providerUsageDaily = sqliteTable(
  "provider_usage_daily",
  {
    day: text("day").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    inputAudioTokens: integer("input_audio_tokens").notNull().default(0),
    outputAudioTokens: integer("output_audio_tokens").notNull().default(0),
    audioSeconds: real("audio_seconds").notNull().default(0),
    inputCharacters: integer("input_characters").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.day, table.provider, table.model, table.operation],
      name: "provider_usage_daily_dimension_pk",
    }),
    index("provider_usage_daily_updated_at_idx").on(table.updatedAt),
  ],
);
