CREATE TABLE `incident_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`details` text DEFAULT '' NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_flags_incident_user` ON `incident_flags` (`incident_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_flags_status_incident` ON `incident_flags` (`status`,`incident_id`);--> statement-breakpoint
ALTER TABLE `incidents` ADD `updated` integer;