PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_stock_orders` (
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
	`thesis_ref` text,
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
INSERT INTO `__new_stock_orders`("id", "symbol", "book", "quantity", "initial_quantity", "entry_price_e4", "entry_basis", "entry_day", "entry_forecast_return", "model_run_id", "thesis_ref", "sector", "stop_price_e4", "target_price_e4", "target_exit_date", "status", "exit_price_e4", "exit_basis", "exit_day", "exit_reason", "split_from", "notes", "opened_at", "closed_at", "exit_updated_at") SELECT "id", "symbol", "book", "quantity", "initial_quantity", "entry_price_e4", "entry_basis", "entry_day", "entry_forecast_return", "model_run_id", "thesis_ref", "sector", "stop_price_e4", "target_price_e4", "target_exit_date", "status", "exit_price_e4", "exit_basis", "exit_day", "exit_reason", "split_from", "notes", "opened_at", "closed_at", "exit_updated_at" FROM `stock_orders`;--> statement-breakpoint
DROP TABLE `stock_orders`;--> statement-breakpoint
ALTER TABLE `__new_stock_orders` RENAME TO `stock_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `stock_orders_status_idx` ON `stock_orders` (`status`);--> statement-breakpoint
CREATE INDEX `stock_orders_book_idx` ON `stock_orders` (`book`);