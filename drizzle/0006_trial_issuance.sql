CREATE TABLE IF NOT EXISTS `trial_issuance_fingerprints` (
	`fingerprint_hash` text PRIMARY KEY NOT NULL,
	`network_hash` text NOT NULL,
	`session_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `trial_issuance_session_hash_unique` ON `trial_issuance_fingerprints` (`session_hash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trial_issuance_network_created_idx` ON `trial_issuance_fingerprints` (`network_hash`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trial_issuance_created_at_idx` ON `trial_issuance_fingerprints` (`created_at`);
