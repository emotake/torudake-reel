ALTER TABLE `users` ADD `billing_email` text;
--> statement-breakpoint
CREATE TABLE `account_passkeys` (
	`credential_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text NOT NULL,
	`backed_up` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_passkeys_user_id_idx` ON `account_passkeys` (`user_id`);
--> statement-breakpoint
CREATE TABLE `account_auth_challenges` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`challenge` text NOT NULL,
	`ceremony` text NOT NULL,
	`user_id` text,
	`expected_origin` text NOT NULL,
	`rp_id` text NOT NULL,
	`network_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_auth_challenges_expires_at_idx` ON `account_auth_challenges` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `account_auth_challenges_network_created_idx` ON `account_auth_challenges` (`network_hash`,`created_at`);
--> statement-breakpoint
CREATE TABLE `account_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_sessions_user_id_idx` ON `account_sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX `account_sessions_expires_at_idx` ON `account_sessions` (`expires_at`);
