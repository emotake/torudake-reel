ALTER TABLE `account_auth_challenges` ADD `requires_reauthentication` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `account_sessions` ADD `reauthenticated_at` integer;