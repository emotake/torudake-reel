CREATE TABLE IF NOT EXISTS `billing_subscription_sync_leases` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`lease_token` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `billing_subscription_sync_leases_token_unique` ON `billing_subscription_sync_leases` (`lease_token`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `billing_subscription_sync_leases_expires_at_idx` ON `billing_subscription_sync_leases` (`expires_at`);--> statement-breakpoint
PRAGMA optimize;
