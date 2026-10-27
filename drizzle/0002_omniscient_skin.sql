CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`category` text NOT NULL,
	`place` text NOT NULL,
	`occurred` integer NOT NULL,
	`description` text NOT NULL,
	`vehicle` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created` integer NOT NULL,
	`reviewed` integer,
	`reviewer` text,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_incidents_status_created` ON `incidents` (`status`,`created`);