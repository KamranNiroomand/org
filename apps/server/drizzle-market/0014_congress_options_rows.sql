-- congress_trades learns to hold options rows. The old PK
-- (doc_id, symbol, code, trans_date) could keep only ONE row when a
-- filer bought shares and calls of the same name on the same day —
-- exactly Pelosi's signature pattern — so asset_type joins the PK and
-- the option's parsed terms ride along. SQLite cannot alter a PK, so
-- the table is rebuilt and the rows carried over as 'ST'.
CREATE TABLE `congress_trades_new` (
	`doc_id` text NOT NULL,
	`member` text NOT NULL,
	`chamber` text DEFAULT 'house' NOT NULL,
	`symbol` text NOT NULL,
	`code` text NOT NULL,
	`asset_type` text DEFAULT 'ST' NOT NULL,
	`trans_date` text,
	`filed_date` text NOT NULL,
	`amount_min` real,
	`amount_max` real,
	`option_type` text,
	`strike` real,
	`option_expiry` text,
	PRIMARY KEY(`doc_id`, `symbol`, `code`, `asset_type`, `trans_date`)
);--> statement-breakpoint
INSERT OR IGNORE INTO `congress_trades_new`
	(`doc_id`, `member`, `chamber`, `symbol`, `code`, `trans_date`, `filed_date`, `amount_min`, `amount_max`)
	SELECT `doc_id`, `member`, `chamber`, `symbol`, `code`, `trans_date`, `filed_date`, `amount_min`, `amount_max`
	FROM `congress_trades`;--> statement-breakpoint
DROP TABLE `congress_trades`;--> statement-breakpoint
ALTER TABLE `congress_trades_new` RENAME TO `congress_trades`;--> statement-breakpoint
CREATE INDEX `congress_symbol_filed_idx` ON `congress_trades` (`symbol`,`filed_date`);
