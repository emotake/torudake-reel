CREATE TABLE `video_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`object_key` text NOT NULL,
	`upload_id` text NOT NULL,
	`status` text DEFAULT 'uploading' NOT NULL,
	`owner_email` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`completed_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_transfers_code_hash_unique` ON `video_transfers` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `video_transfers_expires_at_idx` ON `video_transfers` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `video_transfers_status_idx` ON `video_transfers` (`status`);
