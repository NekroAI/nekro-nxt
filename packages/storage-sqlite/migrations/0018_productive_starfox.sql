CREATE TABLE `dynamic_authoring_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`snapshot_digest` text NOT NULL,
	`risk_digest` text NOT NULL,
	`source_path` text NOT NULL,
	`state` text NOT NULL,
	`host` text NOT NULL,
	`client` text NOT NULL,
	`error` text,
	`verification` text,
	`runner_plugin_id` text,
	`runner_package_id` text,
	`runner_run_id` text,
	`created_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `dynamic_authoring_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dynamic_authoring_attempts_ordinal_ck" CHECK("dynamic_authoring_attempts"."ordinal" > 0),
	CONSTRAINT "dynamic_authoring_attempts_created_at_ck" CHECK("dynamic_authoring_attempts"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dynamic_authoring_attempts_id_task_uq` ON `dynamic_authoring_attempts` (`id`,`task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `dynamic_authoring_attempts_task_ordinal_uq` ON `dynamic_authoring_attempts` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `dynamic_authoring_attempts_task_package_uq` ON `dynamic_authoring_attempts` (`task_id`,`runner_package_id`);--> statement-breakpoint
CREATE INDEX `dynamic_authoring_attempts_task_state_idx` ON `dynamic_authoring_attempts` (`task_id`,`state`,`ordinal`);--> statement-breakpoint
CREATE TABLE `dynamic_authoring_events` (
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text NOT NULL,
	`attempt_id` text,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `sequence`),
	FOREIGN KEY (`task_id`) REFERENCES `dynamic_authoring_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`attempt_id`,`task_id`) REFERENCES `dynamic_authoring_attempts`(`id`,`task_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dynamic_authoring_events_sequence_ck" CHECK("dynamic_authoring_events"."sequence" > 0),
	CONSTRAINT "dynamic_authoring_events_created_at_ck" CHECK("dynamic_authoring_events"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `dynamic_authoring_events_attempt_idx` ON `dynamic_authoring_events` (`attempt_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `dynamic_authoring_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`initiating_event_id` text NOT NULL,
	`plugin_key` text NOT NULL,
	`title` text NOT NULL,
	`requirement_summary` text NOT NULL,
	`status` text NOT NULL,
	`approval_policy` text NOT NULL,
	`approved_risk_digest` text,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`episode_id`,`channel_id`,`agent_id`) REFERENCES `episodes`(`id`,`channel_id`,`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`initiating_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dynamic_authoring_tasks_revision_ck" CHECK("dynamic_authoring_tasks"."revision" > 0),
	CONSTRAINT "dynamic_authoring_tasks_created_at_ck" CHECK("dynamic_authoring_tasks"."created_at" >= 0),
	CONSTRAINT "dynamic_authoring_tasks_updated_at_ck" CHECK("dynamic_authoring_tasks"."updated_at" >= "dynamic_authoring_tasks"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dynamic_authoring_tasks_episode_plugin_uq` ON `dynamic_authoring_tasks` (`episode_id`,`plugin_key`);--> statement-breakpoint
CREATE INDEX `dynamic_authoring_tasks_agent_status_idx` ON `dynamic_authoring_tasks` (`agent_id`,`status`,`updated_at`);