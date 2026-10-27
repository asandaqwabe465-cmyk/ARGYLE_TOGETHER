CREATE TABLE `trip_messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`trip_id` text NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_messages_id_unique` ON `trip_messages` (`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_trip_seq` ON `trip_messages` (`trip_id`,`seq`);