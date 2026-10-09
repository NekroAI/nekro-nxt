PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_channel_prompt_revisions` (
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`revision` integer NOT NULL,
	`document` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `kind`, `revision`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_prompt_revisions_updated_by_ck" CHECK("__new_channel_prompt_revisions"."updated_by" IN ('admin', 'agent'))
);
--> statement-breakpoint
INSERT INTO `__new_channel_prompt_revisions`("channel_id", "kind", "revision", "document", "updated_by", "updated_at") SELECT "channel_id", CASE "updated_by" WHEN 'agent' THEN 'notes' ELSE 'instructions' END, "revision", "document", "updated_by", "updated_at" FROM `channel_prompt_revisions`;--> statement-breakpoint
DROP TABLE `channel_prompt_revisions`;--> statement-breakpoint
ALTER TABLE `__new_channel_prompt_revisions` RENAME TO `channel_prompt_revisions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_channel_prompts` (
	`channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`document` text NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`revision` integer NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `kind`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_prompts_kind_ck" CHECK("__new_channel_prompts"."kind" IN ('instructions', 'notes')),
	CONSTRAINT "channel_prompts_revision_ck" CHECK("__new_channel_prompts"."revision" >= 1),
	CONSTRAINT "channel_prompts_updated_by_ck" CHECK("__new_channel_prompts"."updated_by" IN ('admin', 'agent'))
);
--> statement-breakpoint
INSERT INTO `__new_channel_prompts`("channel_id", "kind", "document", "locked", "revision", "updated_by", "updated_at") SELECT "channel_id", CASE "updated_by" WHEN 'agent' THEN 'notes' ELSE 'instructions' END, "document", "locked", "revision", "updated_by", "updated_at" FROM `channel_prompts`;--> statement-breakpoint
DROP TABLE `channel_prompts`;--> statement-breakpoint
ALTER TABLE `__new_channel_prompts` RENAME TO `channel_prompts`;