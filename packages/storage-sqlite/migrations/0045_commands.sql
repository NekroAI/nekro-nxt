CREATE TABLE `command_channel_settings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`bare_commands` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `command_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`request_id` text NOT NULL,
	`event_id` text,
	`command_name` text,
	`status` text NOT NULL,
	`needs_recovery` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	`record` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `command_execution_request_uq` ON `command_executions` (`channel_id`,`source`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `command_execution_event_uq` ON `command_executions` (`event_id`);--> statement-breakpoint
CREATE INDEX `command_execution_recovery_idx` ON `command_executions` (`needs_recovery`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `command_execution_channel_idx` ON `command_executions` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `command_grants` (
	`channel_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`platform_user_id` text NOT NULL,
	PRIMARY KEY(`channel_id`, `connection_id`, `platform_user_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `command_policies` (
	`scope` text NOT NULL,
	`command_name` text NOT NULL,
	`policy` text NOT NULL,
	PRIMARY KEY(`scope`, `command_name`)
);
--> statement-breakpoint
CREATE TABLE `command_system` (
	`id` integer PRIMARY KEY NOT NULL,
	`cutoff_event_id` text NOT NULL
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_outbound_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_message_id` text NOT NULL,
	`episode_id` text,
	`agent_revision_id` text,
	`channel_id` text,
	`command_execution_id` text,
	`command_ordinal` integer,
	`source_turn_id` text,
	`parts` text NOT NULL,
	`search_text` text NOT NULL,
	`reply_to` text,
	`client_request_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_revision_id`) REFERENCES `agent_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`command_execution_id`) REFERENCES `command_executions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "outbound_intents_source_ck" CHECK(("__new_outbound_intents"."episode_id" IS NOT NULL AND "__new_outbound_intents"."agent_revision_id" IS NOT NULL AND "__new_outbound_intents"."command_execution_id" IS NULL AND "__new_outbound_intents"."command_ordinal" IS NULL) OR ("__new_outbound_intents"."episode_id" IS NULL AND "__new_outbound_intents"."agent_revision_id" IS NULL AND "__new_outbound_intents"."command_execution_id" IS NOT NULL AND "__new_outbound_intents"."command_ordinal" IS NOT NULL AND "__new_outbound_intents"."channel_id" IS NOT NULL)),
	CONSTRAINT "outbound_intents_state_ck" CHECK("__new_outbound_intents"."state" IN ('planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'))
);
--> statement-breakpoint
INSERT INTO `__new_outbound_intents`("id", "logical_message_id", "episode_id", "agent_revision_id", "channel_id", "command_execution_id", "command_ordinal", "source_turn_id", "parts", "search_text", "reply_to", "client_request_id", "state", "created_at") SELECT "id", "logical_message_id", "episode_id", "agent_revision_id", NULL, NULL, NULL, "source_turn_id", "parts", "search_text", "reply_to", "client_request_id", "state", "created_at" FROM `outbound_intents`;--> statement-breakpoint
DROP TABLE `outbound_intents`;--> statement-breakpoint
ALTER TABLE `__new_outbound_intents` RENAME TO `outbound_intents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_logical_message_id_unique` ON `outbound_intents` (`logical_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_command_uq` ON `outbound_intents` (`command_execution_id`,`command_ordinal`);--> statement-breakpoint
CREATE INDEX `outbound_intents_channel_history_idx` ON `outbound_intents` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_client_request_uq` ON `outbound_intents` (`episode_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `outbound_intents_recovery_idx` ON `outbound_intents` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbound_intents_episode_history_idx` ON `outbound_intents` (`episode_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `channel_bindings` ADD `paused` integer DEFAULT false NOT NULL;
--> statement-breakpoint
INSERT INTO command_system (id, cutoff_event_id) SELECT 1, COALESCE(MAX(id), '') FROM channel_events;
