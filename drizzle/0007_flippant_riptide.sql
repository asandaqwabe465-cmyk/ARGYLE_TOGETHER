CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created` integer NOT NULL,
	`reviewed` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_privacy_user_created` ON `privacy_requests` (`user_id`,`created`);--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_version` text;--> statement-breakpoint
ALTER TABLE `users` ADD `privacy_accepted` integer;