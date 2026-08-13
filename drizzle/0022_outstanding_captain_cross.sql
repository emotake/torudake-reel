CREATE TABLE `provider_usage_daily` (
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`operation` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`input_audio_tokens` integer DEFAULT 0 NOT NULL,
	`output_audio_tokens` integer DEFAULT 0 NOT NULL,
	`audio_seconds` real DEFAULT 0 NOT NULL,
	`input_characters` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `provider`, `model`, `operation`)
);
--> statement-breakpoint
CREATE INDEX `provider_usage_daily_updated_at_idx` ON `provider_usage_daily` (`updated_at`);