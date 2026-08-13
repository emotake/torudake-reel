ALTER TABLE `usage_reservations` ADD `release_requested_at` integer;--> statement-breakpoint
CREATE INDEX `usage_reservations_user_status_expires_idx` ON `usage_reservations` (`user_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `usage_reservations_user_status_bucket_created_idx` ON `usage_reservations` (`user_id`,`status`,`bucket`,`created_at`);--> statement-breakpoint
CREATE INDEX `billing_purchases_user_revoked_idx` ON `billing_purchases` (`user_id`,`revoked_at`);--> statement-breakpoint
CREATE INDEX `billing_subscriptions_user_status_period_idx` ON `billing_subscriptions` (`user_id`,`status`,`current_period_end`,`updated_at`);--> statement-breakpoint
CREATE INDEX `usage_operation_leases_reservation_operation_expires_idx` ON `usage_operation_leases` (`reservation_id`,`operation`,`expires_at`);--> statement-breakpoint
PRAGMA optimize;
