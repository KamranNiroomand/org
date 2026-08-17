PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`color` text DEFAULT 'blue' NOT NULL,
	`feed_id` text,
	`external_uid` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`feed_id`) REFERENCES `calendar_feeds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "title", "notes", "starts_at", "ends_at", "all_day", "location", "color", "feed_id", "external_uid", "created_at", "updated_at") SELECT "id", "title", "notes", "starts_at", "ends_at", "all_day", "location", "color", "feed_id", "external_uid", "created_at", "updated_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`starts_at`);--> statement-breakpoint
CREATE INDEX `events_feed_idx` ON `events` (`feed_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_feed_uid_uq` ON `events` (`feed_id`,`external_uid`);