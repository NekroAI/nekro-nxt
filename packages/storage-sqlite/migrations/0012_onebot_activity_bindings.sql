PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_bindings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`trigger_policy` text NOT NULL,
	`processing_feedback` text DEFAULT 'auto' NOT NULL,
	`event_triggers` text DEFAULT '[]' NOT NULL,
	`bound_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "channel_bindings_trigger_policy_ck" CHECK("__new_channel_bindings"."trigger_policy" IN ('always', 'mentioned-or-replied', 'command', 'observe-only')),
	CONSTRAINT "channel_bindings_processing_feedback_ck" CHECK("__new_channel_bindings"."processing_feedback" IN ('auto', 'off'))
);
--> statement-breakpoint
INSERT INTO `__new_channel_bindings`("channel_id", "agent_id", "trigger_policy", "processing_feedback", "event_triggers", "bound_at") SELECT "channel_id", "agent_id", "trigger_policy", 'auto', '[]', "bound_at" FROM `channel_bindings`;--> statement-breakpoint
DROP TABLE `channel_bindings`;--> statement-breakpoint
ALTER TABLE `__new_channel_bindings` RENAME TO `channel_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `channel_bindings_agent_idx` ON `channel_bindings` (`agent_id`,`bound_at`);--> statement-breakpoint
ALTER TABLE `channel_events` ADD `activity_type` text;--> statement-breakpoint
ALTER TABLE `channel_events` ADD `target_platform_message_id` text;--> statement-breakpoint
ALTER TABLE `channel_events` ADD `target_logical_message_id` text;
