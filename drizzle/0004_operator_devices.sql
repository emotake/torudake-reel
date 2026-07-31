CREATE TABLE IF NOT EXISTS `operator_devices` (
	`slot` text PRIMARY KEY NOT NULL,
	`session_hash` text NOT NULL,
	`label` text NOT NULL,
	`activated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `operator_devices_session_hash_unique` ON `operator_devices` (`session_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_devices_expires_at_idx` ON `operator_devices` (`expires_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_devices_revoked_at_idx` ON `operator_devices` (`revoked_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `operator_usage_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`operation` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_usage_operations_reservation_id_idx` ON `operator_usage_operations` (`reservation_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_usage_operations_updated_at_idx` ON `operator_usage_operations` (`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `operator_enrollment_attempts` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`window_started_at` integer NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`blocked_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `operator_enrollment_attempts_updated_at_idx` ON `operator_enrollment_attempts` (`updated_at`);
