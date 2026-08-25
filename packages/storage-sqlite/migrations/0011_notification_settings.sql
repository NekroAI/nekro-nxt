CREATE TABLE `system_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "system_settings_revision_ck" CHECK("system_settings"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE `agent_revisions` ADD `dynamic_client_approval_policy` text DEFAULT 'manual' NOT NULL;