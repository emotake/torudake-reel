CREATE TABLE IF NOT EXISTS `usage_observed_durations` (
	`reservation_id` text PRIMARY KEY NOT NULL,
	`observed_milliseconds` integer DEFAULT 0 NOT NULL,
	`blocked_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `usage_observed_durations_blocked_at_idx` ON `usage_observed_durations` (`blocked_at`);
