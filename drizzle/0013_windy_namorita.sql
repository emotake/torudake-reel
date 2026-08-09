CREATE TABLE `metered_ai_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`action_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`observed_milliseconds` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`succeeded_at` integer,
	`failed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `metered_ai_actions_reservation_action_unique` ON `metered_ai_actions` (`reservation_id`,`action_id`);--> statement-breakpoint
CREATE INDEX `metered_ai_actions_reservation_status_idx` ON `metered_ai_actions` (`reservation_id`,`status`);--> statement-breakpoint
CREATE INDEX `metered_ai_actions_expires_at_idx` ON `metered_ai_actions` (`expires_at`);