CREATE TABLE `community_feedback_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`community_url` text NOT NULL,
	`community_user_id` text,
	`agent_id` text,
	`channel_id` text,
	`kind` text NOT NULL,
	`target` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`excerpt` text,
	`excerpt_shared_with_author` integer DEFAULT false NOT NULL,
	`diagnostics` text NOT NULL,
	`state` text NOT NULL,
	`requested_by` text NOT NULL,
	`auto` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "community_feedback_drafts_state_ck" CHECK("community_feedback_drafts"."state" IN ('awaiting', 'sending', 'sent', 'failed', 'discarded'))
);
--> statement-breakpoint
CREATE INDEX `community_feedback_drafts_identity_idx` ON `community_feedback_drafts` (`community_url`,`community_user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `community_feedback_items` (
	`ref` text NOT NULL,
	`community_url` text NOT NULL,
	`community_user_id` text NOT NULL,
	`channel_id` text,
	`draft_id` text,
	`title` text NOT NULL,
	`kind` text,
	`target` text,
	`status` text NOT NULL,
	`fixed_in` text,
	`unread` integer DEFAULT false NOT NULL,
	`last_event_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`community_url`, `community_user_id`, `ref`)
);
--> statement-breakpoint
CREATE INDEX `community_feedback_items_channel_idx` ON `community_feedback_items` (`community_url`,`community_user_id`,`channel_id`);