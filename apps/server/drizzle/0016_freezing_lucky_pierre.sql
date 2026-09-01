CREATE TABLE `skew_agent_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`symbol` text NOT NULL,
	`verdict` text NOT NULL,
	`probability` real NOT NULL,
	`reasoning` text NOT NULL,
	`falsifier` text NOT NULL,
	`inputs` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skew_agent_day_symbol_uq` ON `skew_agent_reads` (`day`,`symbol`);