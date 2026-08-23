CREATE TABLE `paper_exit_revisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`revised_at` text NOT NULL,
	`old_target_exit_price_e4` integer,
	`new_target_exit_price_e4` integer,
	`old_target_exit_date` text,
	`new_target_exit_date` text,
	`reason` text NOT NULL,
	`triggered_by` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `paper_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `paper_exit_revisions_order_idx` ON `paper_exit_revisions` (`order_id`);--> statement-breakpoint
ALTER TABLE `paper_orders` ADD `target_exit_price_e4` integer;--> statement-breakpoint
ALTER TABLE `paper_orders` ADD `stop_loss_price_e4` integer;--> statement-breakpoint
ALTER TABLE `paper_orders` ADD `target_exit_date` text;--> statement-breakpoint
ALTER TABLE `paper_orders` ADD `entry_ev` real;--> statement-breakpoint
ALTER TABLE `paper_orders` ADD `exit_updated_at` text;