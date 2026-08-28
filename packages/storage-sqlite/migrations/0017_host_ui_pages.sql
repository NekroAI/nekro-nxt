CREATE TABLE `host_ui_diagnostics` (
	`page_instance_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`observed_at` integer NOT NULL,
	FOREIGN KEY (`page_instance_id`) REFERENCES `host_ui_page_entries`(`page_instance_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "host_ui_diagnostics_observed_at_ck" CHECK("host_ui_diagnostics"."observed_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `host_ui_page_entries` (
	`page_instance_id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`icon` text NOT NULL,
	`object_pane` text NOT NULL,
	`start_path` text NOT NULL,
	`visible` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`client_build_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "host_ui_page_entries_sort_order_ck" CHECK("host_ui_page_entries"."sort_order" >= 0),
	CONSTRAINT "host_ui_page_entries_created_at_ck" CHECK("host_ui_page_entries"."created_at" >= 0),
	CONSTRAINT "host_ui_page_entries_updated_at_ck" CHECK("host_ui_page_entries"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_ui_page_entries_owner_entry_uq` ON `host_ui_page_entries` (`owner_kind`,`owner_id`,`entry_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_ui_page_entries_sort_order_uq` ON `host_ui_page_entries` (`sort_order`);--> statement-breakpoint
CREATE INDEX `host_ui_page_entries_owner_idx` ON `host_ui_page_entries` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE TABLE `host_ui_page_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "host_ui_page_preferences_singleton_ck" CHECK("host_ui_page_preferences"."id" = 1),
	CONSTRAINT "host_ui_page_preferences_revision_ck" CHECK("host_ui_page_preferences"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `host_ui_permission_grants` (
	`owner_key` text PRIMARY KEY NOT NULL,
	`artifact_digest` text NOT NULL,
	`permission_digest` text NOT NULL,
	`declaration` text NOT NULL,
	`approved_at` integer NOT NULL
);
