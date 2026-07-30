CREATE TABLE `caption_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`mood` text DEFAULT 'auto' NOT NULL,
	`accent_color` text DEFAULT '#e45f4d' NOT NULL,
	`brand_name` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
