CREATE TABLE `extension_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`extension_id` text,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`declared_key` text,
	`label` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`run_at` integer,
	`cron` text,
	`timezone` text,
	`payload_json` text NOT NULL,
	`next_run_at` integer,
	`last_fired_at` integer,
	`paused` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "extension_jobs_id_ck" CHECK("extension_jobs"."id" LIKE 'job_%'),
	CONSTRAINT "extension_jobs_label_length_ck" CHECK(LENGTH("extension_jobs"."label") BETWEEN 1 AND 200),
	CONSTRAINT "extension_jobs_schedule_kind_ck" CHECK(("extension_jobs"."schedule_kind" = 'once' AND "extension_jobs"."run_at" IS NOT NULL AND "extension_jobs"."cron" IS NULL AND "extension_jobs"."timezone" IS NULL) OR ("extension_jobs"."schedule_kind" = 'cron' AND "extension_jobs"."run_at" IS NULL AND "extension_jobs"."cron" IS NOT NULL AND "extension_jobs"."timezone" IS NOT NULL)),
	CONSTRAINT "extension_jobs_declared_key_ck" CHECK(("extension_jobs"."source" = 'declared' AND "extension_jobs"."declared_key" IS NOT NULL) OR ("extension_jobs"."source" != 'declared' AND "extension_jobs"."declared_key" IS NULL)),
	CONSTRAINT "extension_jobs_extension_id_ck" CHECK(("extension_jobs"."source" = 'declared' OR "extension_jobs"."source" = 'runtime') AND "extension_jobs"."extension_id" IS NOT NULL OR ("extension_jobs"."source" = 'reminder' AND "extension_jobs"."extension_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `extension_jobs_paused_next_run_idx` ON `extension_jobs` (`paused`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `extension_jobs_agent_extension_idx` ON `extension_jobs` (`agent_id`,`extension_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `extension_jobs_declared_unique` ON `extension_jobs` (`agent_id`,`extension_id`,`channel_id`,`declared_key`) WHERE "extension_jobs"."source" = 'declared';--> statement-breakpoint
CREATE TABLE `inbound_hook_decisions` (
	`channel_event_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`trigger` text NOT NULL,
	`hidden` integer NOT NULL,
	`annotation` text,
	`decided_by` text NOT NULL,
	`diagnostics` text,
	`decided_at` integer NOT NULL,
	PRIMARY KEY(`channel_event_id`, `agent_id`),
	FOREIGN KEY (`channel_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "inbound_hook_decisions_annotation_length_ck" CHECK("inbound_hook_decisions"."annotation" IS NULL OR LENGTH("inbound_hook_decisions"."annotation") <= 2000),
	CONSTRAINT "inbound_hook_decisions_decided_at_ck" CHECK("inbound_hook_decisions"."decided_at" > 0)
);
