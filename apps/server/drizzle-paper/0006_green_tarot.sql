CREATE TABLE `paper_decision_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`source` text DEFAULT 'quant' NOT NULL,
	`occ_symbol` text NOT NULL,
	`underlying` text,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `paper_decision_log_day_idx` ON `paper_decision_log` (`day`);--> statement-breakpoint
CREATE INDEX `paper_decision_log_symbol_idx` ON `paper_decision_log` (`occ_symbol`);--> statement-breakpoint
CREATE INDEX `paper_decision_log_reason_idx` ON `paper_decision_log` (`day`,`reason`);