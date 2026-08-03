CREATE TABLE IF NOT EXISTS `usage_operation_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`operation` text NOT NULL,
	`lease_token` text NOT NULL,
	`acquired_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `usage_operation_leases_expires_at_idx` ON `usage_operation_leases` (`expires_at`);
