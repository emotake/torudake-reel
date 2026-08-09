ALTER TABLE `billing_purchases` ADD `refund_blocking_amount` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `billing_purchases` ADD `dispute_state` text;
--> statement-breakpoint
ALTER TABLE `billing_purchases` ADD `revoked_at` integer;
--> statement-breakpoint
ALTER TABLE `billing_purchases` ADD `stripe_state_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `billing_purchases` ADD `stripe_state_sync_started_at` integer;
