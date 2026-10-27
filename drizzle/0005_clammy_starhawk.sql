PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_push_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text,
	`trip_id` text,
	`subscription_id` text NOT NULL,
	`created` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt` integer DEFAULT 0 NOT NULL,
	`locked_until` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_push_deliveries`("id", "alert_id", "trip_id", "subscription_id", "created", "status", "attempts", "next_attempt", "locked_until") SELECT "id", "alert_id", NULL, "subscription_id", "created", "status", "attempts", "next_attempt", "locked_until" FROM `push_deliveries`;--> statement-breakpoint
DROP TABLE `push_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_push_deliveries` RENAME TO `push_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_push_pending` ON `push_deliveries` (`status`,`next_attempt`);--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `p256dh` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `auth` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `distress` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `push_subscriptions` ADD `trips` integer DEFAULT 0 NOT NULL;