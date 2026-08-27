CREATE TABLE `stock_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`as_of` text NOT NULL,
	`trading_day` text NOT NULL,
	`mark_price_e4` integer NOT NULL,
	`basis` text NOT NULL,
	`unrealized_pl_e4` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_marks_order_day_uq` ON `stock_marks` (`order_id`,`trading_day`);--> statement-breakpoint
CREATE TABLE `stock_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`book` text NOT NULL,
	`quantity` real NOT NULL,
	`initial_quantity` real,
	`entry_price_e4` integer NOT NULL,
	`entry_basis` text NOT NULL,
	`entry_day` text NOT NULL,
	`entry_forecast_return` real,
	`model_run_id` text,
	`thesis_ref` integer,
	`sector` text,
	`stop_price_e4` integer,
	`target_price_e4` integer,
	`target_exit_date` text,
	`status` text DEFAULT 'open' NOT NULL,
	`exit_price_e4` integer,
	`exit_basis` text,
	`exit_day` text,
	`exit_reason` text,
	`split_from` text,
	`notes` text,
	`opened_at` text NOT NULL,
	`closed_at` text,
	`exit_updated_at` text
);
--> statement-breakpoint
CREATE INDEX `stock_orders_status_idx` ON `stock_orders` (`status`);--> statement-breakpoint
CREATE INDEX `stock_orders_book_idx` ON `stock_orders` (`book`);