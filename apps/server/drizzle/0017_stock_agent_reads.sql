CREATE TABLE `stock_agent_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`book` text NOT NULL,
	`symbol` text NOT NULL,
	`verdict` text NOT NULL,
	`probability` real NOT NULL,
	`reasoning` text NOT NULL,
	`falsifier` text NOT NULL,
	`inputs` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_agent_day_book_symbol_uq` ON `stock_agent_reads` (`day`,`book`,`symbol`);
