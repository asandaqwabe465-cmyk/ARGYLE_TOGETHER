CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`lat` real,
	`lng` real,
	`accuracy` real,
	`location_at` integer,
	`email_sent` integer DEFAULT 0 NOT NULL,
	`email_total` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_status_created` ON `alerts` (`status`,`created`);--> statement-breakpoint
CREATE INDEX `idx_alerts_user` ON `alerts` (`user_id`);--> statement-breakpoint
CREATE TABLE `challenges` (
	`email` text PRIMARY KEY NOT NULL,
	`digest` text NOT NULL,
	`salt` text NOT NULL,
	`expires` integer NOT NULL,
	`sent` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `escorts` (
	`trip_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`escort_id` text,
	`created` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`escort_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_limits_expires` ON `limits` (`expires`);--> statement-breakpoint
CREATE TABLE `locations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`accuracy` real NOT NULL,
	`updated` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_locations_trip_updated` ON `locations` (`trip_id`,`updated`);--> statement-breakpoint
CREATE TABLE `replies` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`user_id` text NOT NULL,
	`meeting` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_replies_trip_user` ON `replies` (`trip_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`digest` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_expires` ON `sessions` (`expires`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`destination` text NOT NULL,
	`origin` text NOT NULL,
	`departure` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_trips_status_departure` ON `trips` (`status`,`departure`);--> statement-breakpoint
CREATE INDEX `idx_trips_owner` ON `trips` (`owner_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`photo` text DEFAULT '' NOT NULL,
	`complete` integer DEFAULT 0 NOT NULL,
	`created` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);