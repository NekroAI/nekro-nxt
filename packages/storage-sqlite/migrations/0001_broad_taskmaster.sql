CREATE TABLE `adapter_checkpoints` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`checkpoint_json` text NOT NULL,
	`channel_event_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`current_revision_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`display_name` text NOT NULL,
	`persona` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`reasoning_effort` text,
	`settings_json` text,
	`content_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_revisions_agent_revision_uq` ON `agent_revisions` (`agent_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_revisions_agent_digest_uq` ON `agent_revisions` (`agent_id`,`content_digest`);--> statement-breakpoint
CREATE TABLE `bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`trigger_policy` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_channel_agent_uq` ON `bindings` (`channel_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `channel_events` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`adapter_key` text NOT NULL,
	`platform_event_id` text,
	`platform_message_id` text,
	`kind` text NOT NULL,
	`sender_member_id` text,
	`parts_json` text NOT NULL,
	`platform_sequence` integer,
	`platform_timestamp` integer NOT NULL,
	`received_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`facts_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_events_connection_dedupe_uq` ON `channel_events` (`connection_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`platform_channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_connection_platform_uq` ON `channels` (`connection_id`,`platform_channel_id`);--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_key` text NOT NULL,
	`config_json` text NOT NULL,
	`credential_refs_json` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
