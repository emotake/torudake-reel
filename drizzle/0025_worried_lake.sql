CREATE TABLE `account_email_challenges` (
	`challenge_hash` text PRIMARY KEY NOT NULL,
	`email_hash` text NOT NULL,
	`normalized_email` text NOT NULL,
	`code_hash` text NOT NULL,
	`intent` text DEFAULT 'login' NOT NULL,
	`initiating_user_id` text,
	`expected_origin` text NOT NULL,
	`return_to` text DEFAULT '/account' NOT NULL,
	`network_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_email_challenges_expires_at_idx` ON `account_email_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `account_email_challenges_email_created_idx` ON `account_email_challenges` (`email_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `account_email_challenges_network_created_idx` ON `account_email_challenges` (`network_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `account_external_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject_hash` text NOT NULL,
	`verified_email` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_external_identities_provider_subject_unique` ON `account_external_identities` (`provider`,`subject_hash`);--> statement-breakpoint
CREATE INDEX `account_external_identities_user_id_idx` ON `account_external_identities` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_external_identities_user_active_idx` ON `account_external_identities` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `account_oauth_challenges` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`nonce` text NOT NULL,
	`pkce_verifier` text,
	`intent` text DEFAULT 'login' NOT NULL,
	`initiating_user_id` text,
	`expected_origin` text NOT NULL,
	`return_to` text DEFAULT '/account' NOT NULL,
	`network_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX `account_oauth_challenges_expires_at_idx` ON `account_oauth_challenges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `account_oauth_challenges_network_created_idx` ON `account_oauth_challenges` (`network_hash`,`created_at`);--> statement-breakpoint
CREATE TABLE `first_free_save_entitlements` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'available' NOT NULL,
	`claim_id` text,
	`reservation_id` text,
	`output_id` text,
	`claim_idempotency_key` text,
	`finalize_idempotency_key` text,
	`reserved_at` integer,
	`lease_expires_at` integer,
	`consumed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `first_free_save_entitlements_claim_id_unique` ON `first_free_save_entitlements` (`claim_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `first_free_save_entitlements_reservation_id_unique` ON `first_free_save_entitlements` (`reservation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `first_free_save_entitlements_output_id_unique` ON `first_free_save_entitlements` (`output_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `first_free_save_entitlements_claim_idempotency_key_unique` ON `first_free_save_entitlements` (`claim_idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `first_free_save_entitlements_finalize_idempotency_key_unique` ON `first_free_save_entitlements` (`finalize_idempotency_key`);--> statement-breakpoint
CREATE INDEX `first_free_save_entitlements_state_lease_idx` ON `first_free_save_entitlements` (`state`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `free_save_subject_aliases` (
	`alias_hash` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `free_save_subject_aliases_subject_id_idx` ON `free_save_subject_aliases` (`subject_id`);--> statement-breakpoint
CREATE INDEX `free_save_subject_aliases_kind_idx` ON `free_save_subject_aliases` (`kind`);--> statement-breakpoint
CREATE TABLE `free_save_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `account_sessions` ADD `auth_method` text DEFAULT 'passkey' NOT NULL;--> statement-breakpoint
ALTER TABLE `account_sessions` ADD `external_identity_id` text;--> statement-breakpoint
CREATE INDEX `account_sessions_external_identity_id_idx` ON `account_sessions` (`external_identity_id`);--> statement-breakpoint
ALTER TABLE `usage_reservations` ADD `creation_type` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `usage_reservations` ADD `save_funding_source` text DEFAULT 'bucket' NOT NULL;--> statement-breakpoint
CREATE INDEX `usage_reservations_save_funding_source_idx` ON `usage_reservations` (`save_funding_source`);