CREATE TABLE `fundamentals_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`as_of_day` text NOT NULL,
	`trailing_pe` real,
	`forward_pe` real,
	`price_to_book` real,
	`dividend_yield` real,
	`market_cap` real,
	`avg_volume` real,
	`high_52w` real,
	`low_52w` real,
	`captured_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fundamentals_symbol_day_uq` ON `fundamentals_snapshots` (`symbol`,`as_of_day`);