CREATE TABLE `stock_forecasts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`day` text NOT NULL,
	`target` text NOT NULL,
	`symbol` text NOT NULL,
	`model_run_id` text NOT NULL,
	`rank` integer NOT NULL,
	`forecast_sigmas` real,
	`horizon_return` real,
	`forecast_vol` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_forecasts_day_target_symbol_uq` ON `stock_forecasts` (`day`,`target`,`symbol`);