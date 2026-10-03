CREATE TABLE `agent_appearances` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`hue` integer,
	`avatar_asset_id` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`avatar_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "agent_appearances_hue_ck" CHECK("agent_appearances"."hue" IS NULL OR ("agent_appearances"."hue" >= 0 AND "agent_appearances"."hue" <= 359))
);
--> statement-breakpoint
CREATE TABLE `attention_dismissals` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`dismissed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attention_dismissals_time_idx` ON `attention_dismissals` (`dismissed_at`);--> statement-breakpoint
CREATE TABLE `channel_read_cursors` (
	`viewer_key` text NOT NULL,
	`channel_id` text NOT NULL,
	`read_at` integer NOT NULL,
	`read_source_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`viewer_key`, `channel_id`),
	FOREIGN KEY (`viewer_key`) REFERENCES `read_viewers`(`viewer_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outbound_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`action` text NOT NULL,
	`previous_state` text NOT NULL,
	`previous_deliveries` text NOT NULL,
	`viewer_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `outbound_intents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outbound_resolutions_action_ck" CHECK("outbound_resolutions"."action" IN ('retry', 'confirm-delivered')),
	CONSTRAINT "outbound_resolutions_previous_state_ck" CHECK("outbound_resolutions"."previous_state" IN ('partially-sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE INDEX `outbound_resolutions_intent_idx` ON `outbound_resolutions` (`intent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `read_viewers` (
	`viewer_key` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
