CREATE TABLE `sticky_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`color` text DEFAULT 'yellow' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `estimate_minutes` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `tracked_seconds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `timer_started_at` text;