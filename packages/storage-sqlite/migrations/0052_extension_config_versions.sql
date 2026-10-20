CREATE TABLE `extension_config_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`extension_id` text NOT NULL,
	`layer` text NOT NULL,
	`agent_id` text,
	`version` integer NOT NULL,
	`config` text NOT NULL,
	`source` text NOT NULL,
	`actor_agent_id` text,
	`requester_member_id` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "extension_config_versions_layer_ck" CHECK("extension_config_versions"."layer" IN ('host', 'agent')),
	CONSTRAINT "extension_config_versions_agent_ck" CHECK(("extension_config_versions"."layer" = 'host' AND "extension_config_versions"."agent_id" IS NULL) OR ("extension_config_versions"."layer" = 'agent' AND "extension_config_versions"."agent_id" IS NOT NULL)),
	CONSTRAINT "extension_config_versions_source_ck" CHECK("extension_config_versions"."source" IN ('console', 'agent', 'chat-admin', 'revert', 'auto-revert')),
	CONSTRAINT "extension_config_versions_version_ck" CHECK("extension_config_versions"."version" > 0)
);
--> statement-breakpoint
CREATE INDEX `extension_config_versions_owner_idx` ON `extension_config_versions` (`extension_id`,`layer`,`agent_id`,`version`);