CREATE TABLE `platform_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`display_name` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_identities_connection_user_uq` ON `platform_identities` (`connection_id`,`platform_user_id`);
--> statement-breakpoint
CREATE TABLE `channel_members` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`platform_identity_id` text NOT NULL,
	`display_name` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`seen_count` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`platform_identity_id`) REFERENCES `platform_identities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_members_channel_identity_uq` ON `channel_members` (`channel_id`,`platform_identity_id`);
