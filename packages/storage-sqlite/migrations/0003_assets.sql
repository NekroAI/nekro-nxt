CREATE TABLE `asset_occurrences` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`channel_event_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`platform_message_id` text,
	`received_at` integer NOT NULL,
	`filename` text,
	`declared_media_type` text,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `asset_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`staging_relative_path` text NOT NULL,
	`blob_relative_path` text NOT NULL,
	`candidate_json` text NOT NULL,
	`occurrence_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`error_summary` text
);
--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`content_digest` text NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text NOT NULL,
	`blob_state` text NOT NULL,
	`first_received_at` integer NOT NULL,
	`last_received_at` integer NOT NULL,
	`receive_count` integer NOT NULL,
	`last_accessed_at` integer,
	`storage_format_version` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_content_digest_uq` ON `assets` (`content_digest`);