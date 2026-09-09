CREATE TABLE `insider_trades` (
	`accession` text NOT NULL,
	`symbol` text NOT NULL,
	`filed_date` text NOT NULL,
	`trans_date` text,
	`insider_name` text NOT NULL,
	`is_officer` integer DEFAULT 0 NOT NULL,
	`is_director` integer DEFAULT 0 NOT NULL,
	`code` text NOT NULL,
	`shares` real,
	`price` real,
	`value_usd` real,
	PRIMARY KEY(`accession`, `insider_name`, `code`, `trans_date`)
);
--> statement-breakpoint
CREATE INDEX `insider_symbol_filed_idx` ON `insider_trades` (`symbol`,`filed_date`);
