CREATE TABLE `account_recovery_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`contact_hash` text NOT NULL,
	`network_hash` text NOT NULL,
	`challenge_hash` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`reviewed_at` integer,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_recovery_contact_created_idx` ON `account_recovery_challenges` (`contact_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `account_recovery_network_created_idx` ON `account_recovery_challenges` (`network_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `account_recovery_status_expires_idx` ON `account_recovery_challenges` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `billing_rate_limits` (
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`window_started_at` integer NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `action`)
);
--> statement-breakpoint
CREATE INDEX `billing_rate_limits_updated_at_idx` ON `billing_rate_limits` (`updated_at`);--> statement-breakpoint
ALTER TABLE `account_passkeys` ADD `display_name` text DEFAULT 'Device' NOT NULL;
