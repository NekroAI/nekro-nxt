CREATE TABLE `agent_outbound_orders` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`extension_ids` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `outbound_processing` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`outbound_intent_id` text,
	`follow_up_of` text,
	`processed_by` text NOT NULL,
	`rewritten` integer NOT NULL,
	`draft_parts` text NOT NULL,
	`final_parts` text,
	`follow_ups` text NOT NULL,
	`cancelled_by` text,
	`cancel_reason` text,
	`diagnostics` text,
	`created_at` integer NOT NULL,
	`notified_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`outbound_intent_id`) REFERENCES `outbound_intents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outbound_processing_cancel_ck" CHECK(("outbound_processing"."cancelled_by" IS NULL AND "outbound_processing"."final_parts" IS NOT NULL) OR ("outbound_processing"."cancelled_by" IS NOT NULL AND "outbound_processing"."final_parts" IS NULL AND "outbound_processing"."outbound_intent_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_processing_request_uq` ON `outbound_processing` (`episode_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_processing_intent_uq` ON `outbound_processing` (`outbound_intent_id`);--> statement-breakpoint
CREATE INDEX `outbound_processing_channel_idx` ON `outbound_processing` (`channel_id`,`created_at`);