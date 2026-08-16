CREATE TABLE `episode_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`from_episode_id` text NOT NULL,
	`to_episode_id` text NOT NULL,
	`source_event_ids_json` text NOT NULL,
	`summary` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `episodes` ADD `closed_at_event_id` text REFERENCES channel_events(id);--> statement-breakpoint
ALTER TABLE `episodes` ADD `closed_at` integer;--> statement-breakpoint
ALTER TABLE `episodes` ADD `close_reason` text;
