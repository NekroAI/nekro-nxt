CREATE TABLE `binding_admission_cutoffs` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`bound_at` integer NOT NULL,
	`event_id` text NOT NULL,
	`migration_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channel_bindings`(`channel_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`migration_id`) REFERENCES `dsh_session_resets`(`migration_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `dsh_session_resets` (
	`migration_id` text PRIMARY KEY NOT NULL,
	`closed_at` integer NOT NULL,
	`episodes_closed` integer NOT NULL,
	`admissions_cancelled` integer NOT NULL,
	`bindings_cut_off` integer NOT NULL,
	`authoring_tasks_interrupted` integer NOT NULL,
	CONSTRAINT "dsh_session_resets_time_ck" CHECK("dsh_session_resets"."closed_at" >= 0)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`dsh_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "admissions_mode_ck" CHECK("__new_admissions"."mode" IN ('followup', 'inject')),
	CONSTRAINT "admissions_state_ck" CHECK("__new_admissions"."state" IN ('pending', 'claimed', 'logged-to-session', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_admissions`("id", "episode_id", "mode", "state", "dsh_message_id", "created_at") SELECT "id", "episode_id", "mode", "state", "dsh_message_id", "created_at" FROM `admissions`;--> statement-breakpoint
DROP TABLE `admissions`;--> statement-breakpoint
ALTER TABLE `__new_admissions` RENAME TO `admissions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `admissions_recovery_idx` ON `admissions` (`episode_id`,`state`,`created_at`);