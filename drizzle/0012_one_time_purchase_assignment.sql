ALTER TABLE `usage_reservations` ADD `billing_purchase_id` text;--> statement-breakpoint
CREATE INDEX `usage_reservations_billing_purchase_id_idx` ON `usage_reservations` (`billing_purchase_id`);