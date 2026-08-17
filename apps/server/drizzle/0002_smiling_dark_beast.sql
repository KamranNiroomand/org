CREATE UNIQUE INDEX `categories_name_uq` ON `categories` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `rules_pattern_uq` ON `category_rules` (`pattern`);