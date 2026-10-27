CREATE TABLE `volunteers` (
	`user_id` text PRIMARY KEY NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created` integer NOT NULL,
	`notified` integer DEFAULT 0 NOT NULL,
	`reviewed` integer,
	`reviewer` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reviewer`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
