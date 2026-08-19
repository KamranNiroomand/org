CREATE TABLE `doc_mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_id` text NOT NULL,
	`underlying` text NOT NULL,
	`sentiment` text,
	`sentiment_reasoning` text,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_mentions_doc_underlying_uq` ON `doc_mentions` (`document_id`,`underlying`);--> statement-breakpoint
CREATE INDEX `doc_mentions_underlying_idx` ON `doc_mentions` (`underlying`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`published_at` text NOT NULL,
	`ingested_at` text NOT NULL,
	`title` text NOT NULL,
	`summary` text,
	`url` text NOT NULL,
	`doc_type` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_source_uq` ON `documents` (`source`,`source_id`);--> statement-breakpoint
CREATE INDEX `documents_published_idx` ON `documents` (`published_at`);