CREATE TABLE `admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`channel_event_ids_json` text NOT NULL,
	`reason` text NOT NULL,
	`state` text NOT NULL,
	`dsh_message_id` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`logged_at` integer,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `delivery_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`physical_delivery_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`receipt_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`physical_delivery_id`) REFERENCES `physical_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_receipts_delivery_attempt_uq` ON `delivery_receipts` (`physical_delivery_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`binding_id` text NOT NULL,
	`binding_revision` integer NOT NULL,
	`dsh_session_id` text,
	`status` text NOT NULL,
	`opened_at_event_id` text NOT NULL,
	`last_admitted_event_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_revision_id`) REFERENCES `agent_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`binding_id`) REFERENCES `bindings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_at_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_admitted_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_live_lane_uq` ON `episodes` (`channel_id`,`agent_id`) WHERE "episodes"."status" IN ('opening', 'active', 'rolling-over');--> statement-breakpoint
CREATE TABLE `outbound_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`source_turn_id` text,
	`channel_id` text NOT NULL,
	`parts_json` text NOT NULL,
	`reply_to` text,
	`client_request_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_revision_id`) REFERENCES `agent_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_logical_message_id_unique` ON `outbound_intents` (`logical_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_client_request_uq` ON `outbound_intents` (`agent_id`,`channel_id`,`client_request_id`);--> statement-breakpoint
CREATE TABLE `physical_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`parts_json` text NOT NULL,
	`state` text NOT NULL,
	`attempt_count` integer NOT NULL,
	FOREIGN KEY (`intent_id`) REFERENCES `outbound_intents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `physical_deliveries_intent_sequence_uq` ON `physical_deliveries` (`intent_id`,`sequence`);