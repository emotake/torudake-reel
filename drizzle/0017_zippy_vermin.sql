CREATE TABLE IF NOT EXISTS `product_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_name` text NOT NULL,
	`actor_hash` text,
	`source` text NOT NULL,
	`properties` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_events_name_created_idx` ON `product_events` (`event_name`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_events_actor_created_idx` ON `product_events` (`actor_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_events_created_at_idx` ON `product_events` (`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `product_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_hash` text NOT NULL,
	`rating` text NOT NULL,
	`context` text DEFAULT 'general' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_feedback_created_at_idx` ON `product_feedback` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `product_feedback_actor_created_idx` ON `product_feedback` (`actor_hash`,`created_at`);--> statement-breakpoint
PRAGMA optimize;
