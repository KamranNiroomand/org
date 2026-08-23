CREATE TABLE `re_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`model` text NOT NULL,
	`calls_made` integer DEFAULT 0 NOT NULL,
	`web_searches_used` integer DEFAULT 0 NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`property_input` text NOT NULL,
	`computed_financials` text NOT NULL,
	`location_round1` text,
	`location_round2` text,
	`rental_round1` text,
	`rental_round2` text,
	`manager_result` text,
	`balance_placement` text,
	`synthesis_complete` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `re_runs_created_idx` ON `re_runs` (`created_at`);