CREATE TABLE `ai_disclosure_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`confirmation_id` text NOT NULL,
	`user_id` text,
	`session_hash` text NOT NULL,
	`action` text NOT NULL,
	`disclosure_method` text NOT NULL,
	`terms_version` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_disclosure_confirmation_id_unique` ON `ai_disclosure_confirmations` (`confirmation_id`);
--> statement-breakpoint
CREATE INDEX `ai_disclosure_user_id_idx` ON `ai_disclosure_confirmations` (`user_id`);
--> statement-breakpoint
CREATE INDEX `ai_disclosure_created_at_idx` ON `ai_disclosure_confirmations` (`created_at`);
