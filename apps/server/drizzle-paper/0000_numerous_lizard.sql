CREATE TABLE `paper_equity` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`cash_e4` integer NOT NULL,
	`open_positions_value_e4` integer NOT NULL,
	`total_equity_e4` integer NOT NULL,
	`realized_pl_to_date_e4` integer NOT NULL,
	`day_return_pct` real,
	`cumulative_return_pct` real NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_equity_day_uq` ON `paper_equity` (`day`);--> statement-breakpoint
CREATE TABLE `paper_marks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`as_of` text NOT NULL,
	`trading_day` text NOT NULL,
	`mark_price_e4` integer NOT NULL,
	`basis` text NOT NULL,
	`unrealized_pl_e4` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `paper_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_marks_order_day_uq` ON `paper_marks` (`order_id`,`trading_day`);--> statement-breakpoint
CREATE INDEX `paper_marks_day_idx` ON `paper_marks` (`trading_day`);--> statement-breakpoint
CREATE TABLE `paper_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`occ_symbol` text NOT NULL,
	`side` text DEFAULT 'long' NOT NULL,
	`quantity` integer NOT NULL,
	`entry_price_e4` integer NOT NULL,
	`entry_basis` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`exit_price_e4` integer,
	`exit_basis` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`notes` text,
	`opened_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE INDEX `paper_orders_status_idx` ON `paper_orders` (`status`);--> statement-breakpoint
CREATE INDEX `paper_orders_occ_idx` ON `paper_orders` (`occ_symbol`);