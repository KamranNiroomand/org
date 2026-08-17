CREATE TABLE `calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url_enc` text NOT NULL,
	`color` text DEFAULT 'blue' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`last_sync_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `events` ADD `feed_id` text REFERENCES calendar_feeds(id);--> statement-breakpoint
ALTER TABLE `events` ADD `external_uid` text;--> statement-breakpoint
CREATE INDEX `events_feed_idx` ON `events` (`feed_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `events_feed_uid_uq` ON `events` (`feed_id`,`external_uid`);