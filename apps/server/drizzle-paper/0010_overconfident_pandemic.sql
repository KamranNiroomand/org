CREATE TABLE `stock_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`book` text NOT NULL,
	`symbol` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`model_run_id` text,
	`panel_stance` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `stock_decisions_day_idx` ON `stock_decisions` (`day`);--> statement-breakpoint
CREATE INDEX `stock_decisions_symbol_idx` ON `stock_decisions` (`symbol`);--> statement-breakpoint
CREATE INDEX `stock_decisions_reason_idx` ON `stock_decisions` (`day`,`reason`);