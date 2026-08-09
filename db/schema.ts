import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    enum: ["auto", "soft", "refined", "bold", "pop"],
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
    status: text("status").notNull(),
    currentPeriodStart: integer("current_period_start").notNull(),
    currentPeriodEnd: integer("current_period_end").notNull(),
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
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("trial_sessions_expires_at_idx").on(table.expiresAt)],
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
