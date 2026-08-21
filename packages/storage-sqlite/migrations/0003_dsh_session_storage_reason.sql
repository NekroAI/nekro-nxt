PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`dsh_session_id` text,
	`status` text NOT NULL,
	`opened_at_event_id` text NOT NULL,
	`last_admitted_event_id` text,
	`closed_at_event_id` text,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_revision_id`,`agent_id`) REFERENCES `agent_revisions`(`id`,`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`opened_at_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`last_admitted_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`closed_at_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "episodes_status_ck" CHECK("__new_episodes"."status" IN ('opening', 'active', 'closed', 'failed')),
	CONSTRAINT "episodes_close_reason_ck" CHECK("__new_episodes"."close_reason" IS NULL OR "__new_episodes"."close_reason" IN ('manual', 'idle-timeout', 'incompatible-revision', 'incompatible-activation', 'incompatible-session-storage', 'unrecoverable-session', 'permission-revoked', 'binding-replaced', 'stopped'))
);
--> statement-breakpoint
INSERT INTO `__new_episodes`("id", "channel_id", "agent_id", "agent_revision_id", "dsh_session_id", "status", "opened_at_event_id", "last_admitted_event_id", "closed_at_event_id", "closed_at", "close_reason", "created_at") SELECT "id", "channel_id", "agent_id", "agent_revision_id", "dsh_session_id", "status", "opened_at_event_id", "last_admitted_event_id", "closed_at_event_id", "closed_at", "close_reason", "created_at" FROM `episodes`;--> statement-breakpoint
DROP TABLE `episodes`;--> statement-breakpoint
ALTER TABLE `__new_episodes` RENAME TO `episodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_dsh_session_id_unique` ON `episodes` (`dsh_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_id_channel_agent_uq` ON `episodes` (`id`,`channel_id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_live_lane_uq` ON `episodes` (`channel_id`,`agent_id`) WHERE "episodes"."status" IN ('opening', 'active');--> statement-breakpoint
CREATE INDEX `episodes_agent_history_idx` ON `episodes` (`agent_id`,`created_at`);