DROP INDEX `re_runs_created_idx`;--> statement-breakpoint
CREATE INDEX `re_runs_started_idx` ON `re_runs` (`started_at`);--> statement-breakpoint
ALTER TABLE `re_runs` DROP COLUMN `created_at`;