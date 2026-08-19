ALTER TABLE `documents` ADD `edgar_items` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `event_type` text;--> statement-breakpoint
ALTER TABLE `documents` ADD `event_confidence` text;--> statement-breakpoint
CREATE INDEX `documents_unclassified_idx` ON `documents` (`event_type`);