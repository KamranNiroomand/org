CREATE TABLE `alert_events` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`rule_key` text NOT NULL,
	`trading_day` text NOT NULL,
	`context` text NOT NULL,
	`direction` text NOT NULL,
	`headline` text NOT NULL,
	`detail` text DEFAULT '{}' NOT NULL,
	`acknowledged` integer DEFAULT false NOT NULL,
	`triggered_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_events_dedup_uq` ON `alert_events` (`symbol`,`rule_key`,`trading_day`);--> statement-breakpoint
CREATE INDEX `alert_events_day_idx` ON `alert_events` (`trading_day`);--> statement-breakpoint
CREATE INDEX `alert_events_context_idx` ON `alert_events` (`context`,`acknowledged`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`symbol` text PRIMARY KEY NOT NULL,
	`name` text,
	`note` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `instruments` ADD `fifty_two_week_high` real;--> statement-breakpoint
ALTER TABLE `instruments` ADD `fifty_two_week_low` real;--> statement-breakpoint
ALTER TABLE `instruments` ADD `volume` integer;--> statement-breakpoint
ALTER TABLE `instruments` ADD `avg_volume_10_day` integer;