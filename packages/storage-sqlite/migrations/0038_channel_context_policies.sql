CREATE TABLE `channel_context_policies` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
