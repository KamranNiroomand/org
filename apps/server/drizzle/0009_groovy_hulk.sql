CREATE TABLE `radar_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`trading_day` text NOT NULL,
	`universe_scored` integer DEFAULT 0 NOT NULL,
	`shortlisted` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `radar_scores` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`trading_day` text NOT NULL,
	`symbol` text NOT NULL,
	`rank` integer NOT NULL,
	`score` real NOT NULL,
	`momentum_z` real,
	`trend_pct` real,
	`new_high` integer DEFAULT false NOT NULL,
	`volume_ratio` real,
	`volume_z` real,
	`sentiment_z` real,
	`sentiment_doc_count` integer DEFAULT 0 NOT NULL,
	`inputs_used` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `radar_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `radar_scores_day_symbol_uq` ON `radar_scores` (`trading_day`,`symbol`);--> statement-breakpoint
CREATE INDEX `radar_scores_day_rank_idx` ON `radar_scores` (`trading_day`,`rank`);