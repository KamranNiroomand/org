CREATE TABLE `capture_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`cursor` text,
	`symbols_done` integer DEFAULT 0 NOT NULL,
	`contracts_seen` integer DEFAULT 0 NOT NULL,
	`quotes_written` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `capture_kind_started_idx` ON `capture_runs` (`kind`,`started_at`);--> statement-breakpoint
CREATE TABLE `corp_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`value` real,
	`timing` text DEFAULT 'unknown' NOT NULL,
	`known_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_symbol_day_kind_uq` ON `corp_events` (`symbol`,`day`,`kind`);--> statement-breakpoint
CREATE INDEX `events_symbol_idx` ON `corp_events` (`symbol`,`day`);--> statement-breakpoint
CREATE TABLE `equity_bars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`day` text NOT NULL,
	`open_e4` integer NOT NULL,
	`high_e4` integer NOT NULL,
	`low_e4` integer NOT NULL,
	`close_e4` integer NOT NULL,
	`adj_close_e4` integer,
	`volume` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bars_symbol_day_uq` ON `equity_bars` (`symbol`,`day`);--> statement-breakpoint
CREATE TABLE `option_contracts` (
	`occ_symbol` text PRIMARY KEY NOT NULL,
	`underlying` text NOT NULL,
	`expiry` text NOT NULL,
	`type` text NOT NULL,
	`strike_e4` integer NOT NULL,
	`multiplier` integer DEFAULT 100 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `contracts_underlying_idx` ON `option_contracts` (`underlying`,`expiry`);--> statement-breakpoint
CREATE INDEX `contracts_expiry_idx` ON `option_contracts` (`expiry`);--> statement-breakpoint
CREATE TABLE `option_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occ_symbol` text NOT NULL,
	`as_of` text NOT NULL,
	`trading_day` text NOT NULL,
	`bid_e4` integer NOT NULL,
	`ask_e4` integer NOT NULL,
	`last_e4` integer,
	`volume` integer DEFAULT 0 NOT NULL,
	`open_interest` integer DEFAULT 0 NOT NULL,
	`underlying_e4` integer NOT NULL,
	`iv_bps` integer,
	`delta` real,
	`gamma` real,
	`vega` real,
	`theta` real,
	`liquid` integer DEFAULT false NOT NULL,
	`gate_reasons` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`occ_symbol`) REFERENCES `option_contracts`(`occ_symbol`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_contract_asof_uq` ON `option_quotes` (`occ_symbol`,`as_of`);--> statement-breakpoint
CREATE INDEX `quotes_day_idx` ON `option_quotes` (`trading_day`);--> statement-breakpoint
CREATE INDEX `quotes_day_liquid_idx` ON `option_quotes` (`trading_day`,`liquid`);--> statement-breakpoint
CREATE TABLE `risk_free_rates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`tenor_days` integer NOT NULL,
	`rate_bps` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rates_day_tenor_uq` ON `risk_free_rates` (`day`,`tenor_days`);--> statement-breakpoint
CREATE TABLE `tracked_underlyings` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sector` text,
	`tier` text DEFAULT 'research' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tracked_tier_idx` ON `tracked_underlyings` (`tier`,`active`);