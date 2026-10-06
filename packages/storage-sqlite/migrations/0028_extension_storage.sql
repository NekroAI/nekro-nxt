CREATE TABLE `extension_storage_entries` (
	`extension_id` text NOT NULL,
	`owner` text NOT NULL,
	`agent_id` text,
	`partition` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`byte_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`extension_id`, `owner`, `partition`, `key`),
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "extension_storage_entries_owner_agent_ck" CHECK(("extension_storage_entries"."owner" = 'shared' AND "extension_storage_entries"."agent_id" IS NULL) OR ("extension_storage_entries"."owner" != 'shared' AND "extension_storage_entries"."agent_id" = "extension_storage_entries"."owner")),
	CONSTRAINT "extension_storage_entries_byte_size_ck" CHECK("extension_storage_entries"."byte_size" >= 0),
	CONSTRAINT "extension_storage_entries_updated_at_ck" CHECK("extension_storage_entries"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `extension_storage_entries_extension_idx` ON `extension_storage_entries` (`extension_id`);