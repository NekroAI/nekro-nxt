CREATE TABLE `sub_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`dsh_session_id` text NOT NULL,
	`parent_dsh_session_id` text NOT NULL,
	`title` text NOT NULL,
	`opened_by` text NOT NULL,
	`driver` text NOT NULL,
	`status` text NOT NULL,
	`close_reason` text,
	`summary` text,
	`authoring_task_id` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sub_conversations_opened_by_ck" CHECK("sub_conversations"."opened_by" IN ('agent', 'host')),
	CONSTRAINT "sub_conversations_driver_ck" CHECK("sub_conversations"."driver" IN ('model', 'script')),
	CONSTRAINT "sub_conversations_status_ck" CHECK(("sub_conversations"."status" = 'open' AND "sub_conversations"."close_reason" IS NULL AND "sub_conversations"."closed_at" IS NULL) OR ("sub_conversations"."status" = 'closed' AND "sub_conversations"."close_reason" IN ('completed', 'closed-by-agent', 'closed-by-admin', 'failed', 'conversation-ended') AND "sub_conversations"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sub_conversations_dsh_session_id_unique` ON `sub_conversations` (`dsh_session_id`);--> statement-breakpoint
CREATE INDEX `sub_conversations_channel_idx` ON `sub_conversations` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sub_conversations_episode_idx` ON `sub_conversations` (`episode_id`,`status`);--> statement-breakpoint
CREATE INDEX `sub_conversations_closed_idx` ON `sub_conversations` (`status`,`closed_at`);