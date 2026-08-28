CREATE TABLE `dsh_plugin_activations` (
	`entry_id` text NOT NULL,
	`target_key` text NOT NULL,
	`target` text NOT NULL,
	`agent_id` text,
	`activated_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `target_key`),
	FOREIGN KEY (`entry_id`) REFERENCES `dsh_plugin_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "dsh_plugin_activations_target_ck" CHECK(("dsh_plugin_activations"."target" = 'host' AND "dsh_plugin_activations"."target_key" = 'host' AND "dsh_plugin_activations"."agent_id" IS NULL) OR ("dsh_plugin_activations"."target" = 'agent' AND "dsh_plugin_activations"."agent_id" IS NOT NULL AND "dsh_plugin_activations"."target_key" = "dsh_plugin_activations"."agent_id")),
	CONSTRAINT "dsh_plugin_activations_activated_at_ck" CHECK("dsh_plugin_activations"."activated_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `dsh_plugin_activations_agent_idx` ON `dsh_plugin_activations` (`agent_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `dsh_plugin_diagnostics` (
	`entry_id` text NOT NULL,
	`target_key` text NOT NULL,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`message` text,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `target_key`),
	FOREIGN KEY (`entry_id`) REFERENCES `dsh_plugin_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dsh_plugin_diagnostics_observed_at_ck" CHECK("dsh_plugin_diagnostics"."observed_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `dsh_plugin_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text NOT NULL,
	`entry_key` text NOT NULL,
	`module_name` text NOT NULL,
	`suggested_scope` text NOT NULL,
	`selected_scope` text,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`package_id`) REFERENCES `dsh_plugin_packages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "dsh_plugin_entries_created_at_ck" CHECK("dsh_plugin_entries"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dsh_plugin_entries_package_key_uq` ON `dsh_plugin_entries` (`package_id`,`entry_key`);--> statement-breakpoint
CREATE TABLE `dsh_plugin_packages` (
	`id` text PRIMARY KEY NOT NULL,
	`package_name` text NOT NULL,
	`package_version` text NOT NULL,
	`source` text NOT NULL,
	`package_digest` text NOT NULL,
	`integrity` text,
	`lockfile_digest` text NOT NULL,
	`manifest` text NOT NULL,
	`approved_builds` text NOT NULL,
	`installed_at` integer NOT NULL,
	CONSTRAINT "dsh_plugin_packages_installed_at_ck" CHECK("dsh_plugin_packages"."installed_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dsh_plugin_packages_identity_uq` ON `dsh_plugin_packages` (`package_name`,`package_version`,`package_digest`);