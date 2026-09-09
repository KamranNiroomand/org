CREATE TABLE `congress_trades` (
	`doc_id` text NOT NULL,
	`member` text NOT NULL,
	`chamber` text DEFAULT 'house' NOT NULL,
	`symbol` text NOT NULL,
	`code` text NOT NULL,
	`trans_date` text,
	`filed_date` text NOT NULL,
	`amount_min` real,
	`amount_max` real,
	PRIMARY KEY(`doc_id`, `symbol`, `code`, `trans_date`)
);
--> statement-breakpoint
CREATE INDEX `congress_symbol_filed_idx` ON `congress_trades` (`symbol`,`filed_date`);
