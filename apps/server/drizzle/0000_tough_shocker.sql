CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text,
	`plaid_account_id` text,
	`name` text NOT NULL,
	`official_name` text,
	`mask` text,
	`type` text DEFAULT 'depository' NOT NULL,
	`subtype` text,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`current_balance` integer,
	`available_balance` integer,
	`credit_limit` integer,
	`institution_name` text,
	`is_manual` integer DEFAULT false NOT NULL,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_plaid_uq` ON `accounts` (`plaid_account_id`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text NOT NULL,
	`period` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_cat_period_uq` ON `budgets` (`category_id`,`period`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`kind` text DEFAULT 'expense' NOT NULL,
	`color` text DEFAULT 'slate' NOT NULL,
	`icon` text,
	`is_system` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`match_type` text DEFAULT 'contains' NOT NULL,
	`pattern` text NOT NULL,
	`category_id` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rules_priority_idx` ON `category_rules` (`priority`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`all_day` integer DEFAULT false NOT NULL,
	`location` text,
	`color` text DEFAULT 'blue' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_start_idx` ON `events` (`starts_at`);--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`base` text NOT NULL,
	`quote` text NOT NULL,
	`rate` real NOT NULL,
	`as_of` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fx_pair_date_uq` ON `fx_rates` (`base`,`quote`,`as_of`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`name` text,
	`quantity` real NOT NULL,
	`avg_cost` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`account_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `idea_links` (
	`id` text PRIMARY KEY NOT NULL,
	`idea_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idea_link_uq` ON `idea_links` (`idea_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'seed' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plaid_items` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_id` text,
	`institution_name` text NOT NULL,
	`access_token_enc` text NOT NULL,
	`cursor` text,
	`status` text DEFAULT 'ok' NOT NULL,
	`error` text,
	`last_sync_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `price_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`price` integer NOT NULL,
	`currency` text NOT NULL,
	`day_change_percent` real,
	`as_of` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `prices_symbol_idx` ON `price_snapshots` (`symbol`,`as_of`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`color` text DEFAULT 'violet' NOT NULL,
	`target_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`cadence` text NOT NULL,
	`account_id` text,
	`next_expected_on` text,
	`last_seen_on` text,
	`confidence` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text DEFAULT 'none' NOT NULL,
	`due_on` text,
	`completed_at` text,
	`project_id` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_due_idx` ON `tasks` (`due_on`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`plaid_transaction_id` text,
	`date` text NOT NULL,
	`authorized_date` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`name` text NOT NULL,
	`merchant_name` text,
	`category_id` text,
	`pending` integer DEFAULT false NOT NULL,
	`pending_transaction_id` text,
	`is_transfer` integer DEFAULT false NOT NULL,
	`notes` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`import_hash` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tx_plaid_uq` ON `transactions` (`plaid_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tx_import_hash_uq` ON `transactions` (`import_hash`);--> statement-breakpoint
CREATE INDEX `tx_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `tx_account_idx` ON `transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `tx_category_idx` ON `transactions` (`category_id`);