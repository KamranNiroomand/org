CREATE TABLE `panel_agent_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`analysis_id` text NOT NULL,
	`round` integer NOT NULL,
	`agent` text NOT NULL,
	`stance` text NOT NULL,
	`confidence` text NOT NULL,
	`reasoning` text NOT NULL,
	`cited_inputs` text DEFAULT '[]' NOT NULL,
	`responding_to` text,
	`revised_position` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `panel_symbol_analyses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `panel_turns_analysis_round_idx` ON `panel_agent_turns` (`analysis_id`,`round`);--> statement-breakpoint
CREATE TABLE `panel_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger` text NOT NULL,
	`query` text,
	`resolution_method` text NOT NULL,
	`symbols` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`model` text NOT NULL,
	`calls_made` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `panel_runs_started_idx` ON `panel_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `panel_symbol_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`symbol` text NOT NULL,
	`stance` text NOT NULL,
	`summary` text NOT NULL,
	`agreements` text DEFAULT '[]' NOT NULL,
	`disagreements` text DEFAULT '[]' NOT NULL,
	`open_questions` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `panel_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `panel_symbol_run_uq` ON `panel_symbol_analyses` (`run_id`,`symbol`);