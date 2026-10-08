CREATE TABLE `channel_prompt_revisions` (
	`channel_id` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `revision`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_prompt_revisions_updated_by_ck" CHECK("channel_prompt_revisions"."updated_by" IN ('admin', 'agent'))
);
--> statement-breakpoint
CREATE TABLE `channel_prompts` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_prompts_revision_ck" CHECK("channel_prompts"."revision" >= 1),
	CONSTRAINT "channel_prompts_updated_by_ck" CHECK("channel_prompts"."updated_by" IN ('admin', 'agent'))
);
