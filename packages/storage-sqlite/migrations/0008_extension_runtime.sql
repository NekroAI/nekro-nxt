CREATE TABLE `agent_activations` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`extension_revision_id` text NOT NULL,
	`config_json` text NOT NULL,
	`state` text NOT NULL,
	`runtime_kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`disabled_at` integer,
	`last_error` text,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extension_revision_id`) REFERENCES `extension_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `draft_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`source_dynamic_package_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`name` text NOT NULL,
	`purpose` text NOT NULL,
	`host_code` text,
	`client_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `extension_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_packages_source_uq` ON `draft_packages` (`draft_id`,`source_dynamic_package_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `draft_packages_sequence_uq` ON `draft_packages` (`draft_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `extension_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`source_dsh_session_id` text NOT NULL,
	`source_dynamic_plugin_id` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_drafts_open_source_uq` ON `extension_drafts` (`agent_id`,`source_dsh_session_id`,`source_dynamic_plugin_id`) WHERE "extension_drafts"."state" = 'open';--> statement-breakpoint
CREATE TABLE `extension_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`content_digest` text NOT NULL,
	`manifest_schema_version` integer NOT NULL,
	`extension_api_version` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_dynamic_package_ref` text,
	`compatible_nekro_nxt_range` text NOT NULL,
	`compatible_dsh_range` text NOT NULL,
	`storage_state` text NOT NULL,
	`last_build_status` text,
	`last_validation_status` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_number_uq` ON `extension_revisions` (`extension_id`,`revision_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_digest_uq` ON `extension_revisions` (`extension_id`,`content_digest`);--> statement-breakpoint
CREATE TABLE `extension_save_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_package_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`staging_relative_path` text NOT NULL,
	`final_relative_path` text NOT NULL,
	`state` text NOT NULL,
	`error_summary` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`draft_package_id`) REFERENCES `draft_packages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `extension_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `local_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`origin` text NOT NULL,
	`created_by_agent_id` text,
	`default_revision_id` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_extensions_slug_unique` ON `local_extensions` (`slug`);