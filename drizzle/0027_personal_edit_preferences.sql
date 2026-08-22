CREATE TABLE IF NOT EXISTS `personal_edit_recipes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`audio_mode` text DEFAULT 'spoken' NOT NULL,
	`target_duration_seconds` integer DEFAULT 60 NOT NULL,
	`editing_pace` text DEFAULT 'balanced' NOT NULL,
	`spoken_captions_enabled` integer DEFAULT false NOT NULL,
	`spoken_cut_mode` text DEFAULT 'auto' NOT NULL,
	`narration_style` text DEFAULT 'calm' NOT NULL,
	`narration_captions_enabled` integer DEFAULT true NOT NULL,
	`narration_auto_cut_enabled` integer DEFAULT false NOT NULL,
	`narration_original_audio_percent` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "personal_edit_recipes_version_check" CHECK("personal_edit_recipes"."version" = 1),
	CONSTRAINT "personal_edit_recipes_duration_check" CHECK("personal_edit_recipes"."target_duration_seconds" in (30, 60, 90)),
	CONSTRAINT "personal_edit_recipes_original_audio_check" CHECK("personal_edit_recipes"."narration_original_audio_percent" between 0 and 20),
	CONSTRAINT "personal_edit_recipes_updated_at_check" CHECK("personal_edit_recipes"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `pronunciation_dictionary_entries` (
	`user_id` text NOT NULL,
	`match_key` text NOT NULL,
	`display_text` text NOT NULL,
	`reading_text` text NOT NULL,
	`position` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `match_key`),
	CONSTRAINT "pronunciation_dictionary_entries_match_key_check" CHECK(length("pronunciation_dictionary_entries"."match_key") between 1 and 50),
	CONSTRAINT "pronunciation_dictionary_entries_display_check" CHECK(length("pronunciation_dictionary_entries"."display_text") between 1 and 50),
	CONSTRAINT "pronunciation_dictionary_entries_reading_check" CHECK(length("pronunciation_dictionary_entries"."reading_text") between 1 and 80),
	CONSTRAINT "pronunciation_dictionary_entries_position_check" CHECK("pronunciation_dictionary_entries"."position" between 0 and 49),
	CONSTRAINT "pronunciation_dictionary_entries_updated_at_check" CHECK("pronunciation_dictionary_entries"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `pronunciation_dictionary_entries_user_position_idx` ON `pronunciation_dictionary_entries` (`user_id`,`position`);
--> statement-breakpoint
PRAGMA optimize;
