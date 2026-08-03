CREATE TABLE IF NOT EXISTS `trial_sessions` (
	`session_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `trial_sessions_expires_at_idx` ON `trial_sessions` (`expires_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `video_transfer_parts` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`part_number` integer NOT NULL,
	`size` integer NOT NULL,
	`etag` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `video_transfer_parts_transfer_id_idx` ON `video_transfer_parts` (`transfer_id`);
