CREATE TABLE `model_runs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`target` text NOT NULL,
	`horizon` integer NOT NULL,
	`git_sha` text,
	`train_days_first` text NOT NULL,
	`train_days_last` text NOT NULL,
	`train_days_count` integer NOT NULL,
	`n_splits` integer NOT NULL,
	`embargo` integer NOT NULL,
	`metrics` text NOT NULL,
	`artifact_dir` text NOT NULL,
	`registered_at` text NOT NULL,
	`status` text DEFAULT 'challenger' NOT NULL,
	`promoted_at` text
);
--> statement-breakpoint
CREATE INDEX `model_runs_target_idx` ON `model_runs` (`target`);--> statement-breakpoint
CREATE INDEX `model_runs_status_idx` ON `model_runs` (`status`);