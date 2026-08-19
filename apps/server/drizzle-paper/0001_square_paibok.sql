CREATE TABLE `paper_position_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`day` text NOT NULL,
	`current_ev` real,
	`current_ev_per_risk` real,
	`current_prob_profit` real,
	`current_forecast_vol` real,
	`current_forecast_drift` real,
	`new_documents_count` integer DEFAULT 0 NOT NULL,
	`latest_document_title` text,
	`latest_document_event_type` text,
	`latest_document_published_at` text,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `paper_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paper_position_health_order_day_uq` ON `paper_position_health` (`order_id`,`day`);--> statement-breakpoint
CREATE INDEX `paper_position_health_day_idx` ON `paper_position_health` (`day`);