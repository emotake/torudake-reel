ALTER TABLE `billing_subscriptions` ADD `plan_key` text DEFAULT 'legacy_1480' NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_subscriptions` ADD `revoked_period_start` integer;