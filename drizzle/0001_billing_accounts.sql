CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`full_name` text,
	`stripe_customer_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_customer_id_unique` ON `users` (`stripe_customer_id`);
--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_price_id` text NOT NULL,
	`status` text NOT NULL,
	`current_period_start` integer NOT NULL,
	`current_period_end` integer NOT NULL,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_subscriptions_user_id_idx` ON `billing_subscriptions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `billing_subscriptions_status_idx` ON `billing_subscriptions` (`status`);
--> statement-breakpoint
CREATE TABLE `billing_purchases` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`stripe_payment_intent_id` text,
	`stripe_price_id` text NOT NULL,
	`credits` integer DEFAULT 1 NOT NULL,
	`purchased_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `billing_purchases_user_id_idx` ON `billing_purchases` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_purchases_payment_intent_unique` ON `billing_purchases` (`stripe_payment_intent_id`);
--> statement-breakpoint
CREATE TABLE `usage_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`source_duration_seconds` integer NOT NULL,
	`bucket` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_reservations_idempotency_unique` ON `usage_reservations` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `usage_reservations_user_id_idx` ON `usage_reservations` (`user_id`);
--> statement-breakpoint
CREATE INDEX `usage_reservations_status_idx` ON `usage_reservations` (`status`);
--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`created_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `stripe_events_processed_at_idx` ON `stripe_events` (`processed_at`);
