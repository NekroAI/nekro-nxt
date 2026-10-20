CREATE TABLE `credential_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`credential_id` text NOT NULL,
	`at` integer NOT NULL,
	`agent_id` text,
	`channel_id` text,
	`requester_member_id` text,
	`consumer_kind` text NOT NULL,
	`consumer_id` text NOT NULL,
	`target_host` text,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "credential_uses_consumer_kind_ck" CHECK("credential_uses"."consumer_kind" IN ('extension', 'command', 'mcp', 'model'))
);
--> statement-breakpoint
CREATE INDEX `credential_uses_credential_idx` ON `credential_uses` (`credential_id`,`at`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`usage` text NOT NULL,
	`domains` text NOT NULL,
	`agent_scope` text NOT NULL,
	`auto_use` integer NOT NULL,
	`env_name` text,
	`approved_agent_ids` text NOT NULL,
	`credential_ref` text NOT NULL,
	`metadata` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT "credentials_kind_ck" CHECK("credentials"."kind" IN ('generic', 'github')),
	CONSTRAINT "credentials_usage_ck" CHECK("credentials"."usage" IN ('request', 'program'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_name_unique` ON `credentials` (`name`);