-- Hand-edited: drizzle's generated SQLite table-recreation copies every
-- column of the NEW table out of the OLD one, including close_e4, which by
-- definition is not there yet. Selecting NULL in its place is the intent —
-- rows captured before this migration genuinely have no recorded close.

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_option_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occ_symbol` text NOT NULL,
	`as_of` text NOT NULL,
	`trading_day` text NOT NULL,
	`bid_e4` integer,
	`ask_e4` integer,
	`last_e4` integer,
	`close_e4` integer,
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
INSERT INTO `__new_option_quotes`("id", "occ_symbol", "as_of", "trading_day", "bid_e4", "ask_e4", "last_e4", "close_e4", "volume", "open_interest", "underlying_e4", "iv_bps", "delta", "gamma", "vega", "theta", "liquid", "gate_reasons") SELECT "id", "occ_symbol", "as_of", "trading_day", "bid_e4", "ask_e4", "last_e4", NULL, "volume", "open_interest", "underlying_e4", "iv_bps", "delta", "gamma", "vega", "theta", "liquid", "gate_reasons" FROM `option_quotes`;--> statement-breakpoint
DROP TABLE `option_quotes`;--> statement-breakpoint
ALTER TABLE `__new_option_quotes` RENAME TO `option_quotes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_contract_asof_uq` ON `option_quotes` (`occ_symbol`,`as_of`);--> statement-breakpoint
CREATE INDEX `quotes_day_idx` ON `option_quotes` (`trading_day`);--> statement-breakpoint
CREATE INDEX `quotes_day_liquid_idx` ON `option_quotes` (`trading_day`,`liquid`);