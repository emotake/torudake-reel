CREATE TABLE `account_deletion_execution_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`account_reference` text NOT NULL,
	`request_id` text NOT NULL,
	`dry_run` integer DEFAULT true NOT NULL,
	`outcome` text NOT NULL,
	`reason_code` text,
	`summary` text DEFAULT '{}' NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_deletion_audit_reference_started_idx` ON `account_deletion_execution_audit` (`account_reference`,`started_at`);--> statement-breakpoint
CREATE INDEX `account_deletion_audit_outcome_started_idx` ON `account_deletion_execution_audit` (`outcome`,`started_at`);--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `execution_token` text;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `execution_started_at` integer;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `last_block_reason` text;--> statement-breakpoint
ALTER TABLE `account_deletion_requests` ADD `last_error_code` text;--> statement-breakpoint
ALTER TABLE `users` ADD `account_deleted_at` integer;
--> statement-breakpoint
CREATE TRIGGER `account_deletion_block_usage_insert`
BEFORE INSERT ON `usage_reservations`
WHEN EXISTS (
	SELECT 1 FROM `account_deletion_requests`
	WHERE `user_id` = NEW.`user_id` AND `status` = 'processing'
)
BEGIN
	SELECT RAISE(ABORT, 'account_deletion_processing');
END;
--> statement-breakpoint
CREATE TRIGGER `account_deletion_block_usage_reactivation`
BEFORE UPDATE OF `status`, `expires_at` ON `usage_reservations`
WHEN NEW.`status` = 'reserved'
	AND (
		OLD.`status` <> 'reserved'
		OR NEW.`expires_at` > OLD.`expires_at`
	)
	AND EXISTS (
		SELECT 1 FROM `account_deletion_requests`
		WHERE `user_id` = NEW.`user_id` AND `status` = 'processing'
	)
BEGIN
	SELECT RAISE(ABORT, 'account_deletion_processing');
END;
