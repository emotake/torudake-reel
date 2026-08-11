CREATE TABLE `billing_checkout_locks` (
	`user_id` text PRIMARY KEY NOT NULL,
	`lock_token` text NOT NULL,
	`request_id` text NOT NULL,
	`plan_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_checkout_locks_token_unique` ON `billing_checkout_locks` (`lock_token`);--> statement-breakpoint
CREATE INDEX `billing_checkout_locks_expires_at_idx` ON `billing_checkout_locks` (`expires_at`);--> statement-breakpoint
ALTER TABLE `trial_sessions` ADD `account_user_id` text;--> statement-breakpoint
UPDATE `trial_sessions`
SET `account_user_id` = (
	SELECT `users`.`id`
	FROM `users`
	WHERE `users`.`email` =
		'trial-' || substr(`trial_sessions`.`session_hash`, 1, 48) || '@anonymous.torudake.invalid'
		AND EXISTS (
			SELECT 1
			FROM `account_passkeys`
			WHERE `account_passkeys`.`user_id` = `users`.`id`
		)
	LIMIT 1
)
WHERE `account_user_id` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `users`
		WHERE `users`.`email` =
			'trial-' || substr(`trial_sessions`.`session_hash`, 1, 48) || '@anonymous.torudake.invalid'
			AND EXISTS (
				SELECT 1
				FROM `account_passkeys`
				WHERE `account_passkeys`.`user_id` = `users`.`id`
			)
	);--> statement-breakpoint
CREATE INDEX `trial_sessions_account_user_id_idx` ON `trial_sessions` (`account_user_id`);
--> statement-breakpoint
PRAGMA optimize;
