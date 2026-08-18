PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_paper_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`occ_symbol` text NOT NULL,
	`side` text DEFAULT 'long' NOT NULL,
	`quantity` integer NOT NULL,
	`entry_price_e4` integer NOT NULL,
	`entry_basis` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`exit_price_e4` integer,
	`exit_basis` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`notes` text,
	`opened_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`occ_symbol`) REFERENCES `option_contracts`(`occ_symbol`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_paper_orders`("id", "occ_symbol", "side", "quantity", "entry_price_e4", "entry_basis", "status", "exit_price_e4", "exit_basis", "source", "notes", "opened_at", "closed_at") SELECT "id", "occ_symbol", "side", "quantity", "entry_price_e4", "entry_basis", "status", "exit_price_e4", "exit_basis", "source", "notes", "opened_at", "closed_at" FROM `paper_orders`;--> statement-breakpoint
DROP TABLE `paper_orders`;--> statement-breakpoint
ALTER TABLE `__new_paper_orders` RENAME TO `paper_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `paper_orders_status_idx` ON `paper_orders` (`status`);--> statement-breakpoint
CREATE INDEX `paper_orders_occ_idx` ON `paper_orders` (`occ_symbol`);