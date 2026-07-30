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

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
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

export const captionProfiles = sqliteTable("caption_profiles", {
  userId: text("user_id").primaryKey(),
  mood: text("mood", {
    enum: ["auto", "soft", "refined", "bold"],
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
      enum: ["free", "subscription", "one_time"],
    }).notNull(),
    status: text("status", {
      enum: ["reserved", "completed", "released"],
    })
      .notNull()
      .default("reserved"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("usage_reservations_idempotency_unique").on(
      table.idempotencyKey,
    ),
    index("usage_reservations_user_id_idx").on(table.userId),
    index("usage_reservations_status_idx").on(table.status),
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
