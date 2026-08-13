CREATE TABLE `account_deletion_requests` (
	`user_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`requested_at` integer NOT NULL,
	`execute_after` integer NOT NULL,
	`cancelled_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_deletion_status_execute_idx` ON `account_deletion_requests` (`status`,`execute_after`);