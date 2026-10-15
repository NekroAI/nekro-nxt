CREATE TABLE `extension_community_links` (
	`extension_id` text NOT NULL,
	`community_url` text NOT NULL,
	`role` text NOT NULL,
	`dismissed_release_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`extension_id`, `community_url`),
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `extension_data_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`reason` text NOT NULL,
	`label` text NOT NULL,
	`data_version` integer NOT NULL,
	`payload` blob NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_data_snapshots_extension_idx` ON `extension_data_snapshots` (`extension_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `extension_data_states` (
	`extension_id` text PRIMARY KEY NOT NULL,
	`data_version` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `extension_requests` (
	`number` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text,
	`extension_id` text,
	`summary` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`result` text,
	`decided_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_requests_status_idx` ON `extension_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `extension_requests_agent_idx` ON `extension_requests` (`agent_id`,`status`);--> statement-breakpoint
CREATE TABLE `extension_revision_releases` (
	`revision_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`community_url` text NOT NULL,
	`release_id` text NOT NULL,
	`release_number` integer,
	`publisher_handle` text NOT NULL,
	`via` text NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`revision_id`, `community_url`),
	FOREIGN KEY (`revision_id`) REFERENCES `extension_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_revision_releases_extension_idx` ON `extension_revision_releases` (`extension_id`,`community_url`);--> statement-breakpoint
CREATE TABLE `instance_administrators` (
	`connection_id` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`label` text NOT NULL,
	`added_via` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `platform_user_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dynamic_authoring_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`origin_channel_id` text NOT NULL,
	`initiating_event_id` text NOT NULL,
	`kind` text DEFAULT 'create' NOT NULL,
	`target_extension_id` text,
	`base_revision_id` text,
	`reference_revision_id` text,
	`paused_reason` text,
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
	FOREIGN KEY (`initiating_event_id`,`origin_channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dynamic_authoring_tasks_revision_ck" CHECK("__new_dynamic_authoring_tasks"."revision" > 0),
	CONSTRAINT "dynamic_authoring_tasks_created_at_ck" CHECK("__new_dynamic_authoring_tasks"."created_at" >= 0),
	CONSTRAINT "dynamic_authoring_tasks_updated_at_ck" CHECK("__new_dynamic_authoring_tasks"."updated_at" >= "__new_dynamic_authoring_tasks"."created_at")
);
--> statement-breakpoint
INSERT INTO `__new_dynamic_authoring_tasks`("id", "agent_id", "channel_id", "episode_id", "origin_channel_id", "initiating_event_id", "kind", "target_extension_id", "base_revision_id", "reference_revision_id", "paused_reason", "plugin_key", "title", "requirement_summary", "status", "approval_policy", "approved_risk_digest", "revision", "created_at", "updated_at", "completed_at") SELECT "id", "agent_id", "channel_id", "episode_id", "channel_id", "initiating_event_id", 'create', NULL, NULL, NULL, NULL, "plugin_key", "title", "requirement_summary", "status", "approval_policy", "approved_risk_digest", "revision", "created_at", "updated_at", "completed_at" FROM `dynamic_authoring_tasks`;--> statement-breakpoint
DROP TABLE `dynamic_authoring_tasks`;--> statement-breakpoint
ALTER TABLE `__new_dynamic_authoring_tasks` RENAME TO `dynamic_authoring_tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dynamic_authoring_tasks_episode_plugin_uq` ON `dynamic_authoring_tasks` (`episode_id`,`plugin_key`);--> statement-breakpoint
CREATE INDEX `dynamic_authoring_tasks_agent_status_idx` ON `dynamic_authoring_tasks` (`agent_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `dynamic_authoring_tasks_target_idx` ON `dynamic_authoring_tasks` (`target_extension_id`,`status`);--> statement-breakpoint
ALTER TABLE `extension_revisions` ADD `parent_revision_id` text;--> statement-breakpoint
ALTER TABLE `extension_revisions` ADD `ancestry` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `extension_revisions` ADD `origin` text DEFAULT 'file' NOT NULL;--> statement-breakpoint
ALTER TABLE `extension_revisions` ADD `authoring_task_id` text;--> statement-breakpoint
ALTER TABLE `extension_revisions` ADD `data_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `local_extensions` ADD `branch_of_extension_id` text;--> statement-breakpoint
ALTER TABLE `local_extensions` ADD `branch_of_revision_id` text;;--> statement-breakpoint
UPDATE `extension_revisions` SET `ancestry` = COALESCE((
	SELECT json_group_array(`id`) FROM (
		SELECT `earlier`.`id` FROM `extension_revisions` AS `earlier`
		WHERE `earlier`.`extension_id` = `extension_revisions`.`extension_id`
			AND `earlier`.`revision_number` < `extension_revisions`.`revision_number`
		ORDER BY `earlier`.`revision_number` DESC LIMIT 256
	)
), '[]');--> statement-breakpoint
UPDATE `extension_revisions` SET `parent_revision_id` = json_extract(`ancestry`, '$[0]') WHERE json_array_length(`ancestry`) > 0;--> statement-breakpoint
UPDATE `extension_revisions` SET `origin` = 'community' WHERE `id` IN (SELECT `revision_id` FROM `extension_revision_sources`);--> statement-breakpoint
UPDATE `extension_revisions` SET `origin` = 'authored', `authoring_task_id` = (
	SELECT `event`.`task_id` FROM `dynamic_authoring_events` AS `event`
	WHERE `event`.`kind` = 'task-completed' AND json_extract(`event`.`payload`, '$.revisionId') = `extension_revisions`.`id`
	LIMIT 1
) WHERE `origin` = 'file' AND `id` IN (
	SELECT json_extract(`payload`, '$.revisionId') FROM `dynamic_authoring_events` WHERE `kind` = 'task-completed'
);--> statement-breakpoint
INSERT INTO `extension_revision_releases` (`revision_id`, `extension_id`, `community_url`, `release_id`, `release_number`, `publisher_handle`, `via`, `recorded_at`)
	SELECT `revision_id`, `extension_id`, `community_url`, `release_id`, NULL, `publisher_handle`, 'install', `installed_at` FROM `extension_revision_sources`;--> statement-breakpoint
INSERT OR IGNORE INTO `extension_community_links` (`extension_id`, `community_url`, `role`, `dismissed_release_id`, `updated_at`)
	SELECT `extension_id`, `community_url`, 'subscriber', NULL, MAX(`installed_at`) FROM `extension_revision_sources`
	WHERE `extension_id` IN (SELECT `id` FROM `local_extensions`) GROUP BY `extension_id`, `community_url`;--> statement-breakpoint
UPDATE `dynamic_authoring_tasks` SET `status` = 'paused', `paused_reason` = '所在的对话已经结束。'
	WHERE `status` NOT IN ('interrupted', 'stopped', 'completed')
	AND `episode_id` IN (SELECT `id` FROM `episodes` WHERE `status` IN ('closed', 'failed'));
