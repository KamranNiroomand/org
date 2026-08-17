CREATE TABLE `instruments` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`exchange` text NOT NULL,
	`country` text NOT NULL,
	`sector` text,
	`market_cap` real,
	`price` real,
	`currency` text,
	`day_change_percent` real,
	`trailing_pe` real,
	`forward_pe` real,
	`price_to_book` real,
	`dividend_yield` real,
	`first_trade_ms` integer,
	`quoted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `instruments_cap_idx` ON `instruments` (`market_cap`);--> statement-breakpoint
CREATE INDEX `instruments_country_idx` ON `instruments` (`country`);--> statement-breakpoint
CREATE INDEX `instruments_exchange_idx` ON `instruments` (`exchange`);