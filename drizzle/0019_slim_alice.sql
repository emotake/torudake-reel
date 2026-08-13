CREATE TABLE IF NOT EXISTS `usage_release_intents` (
	`user_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`requested_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `idempotency_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `usage_release_intents_expires_at_idx` ON `usage_release_intents` (`expires_at`);
--> statement-breakpoint
PRAGMA optimize;
