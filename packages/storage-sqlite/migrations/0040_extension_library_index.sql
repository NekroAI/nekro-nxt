CREATE TABLE `extension_index_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`extension_id` text NOT NULL,
	`collection` text NOT NULL,
	`document_id` text NOT NULL,
	`fields` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "extension_index_documents_updated_at_ck" CHECK("extension_index_documents"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_index_documents_key_uq` ON `extension_index_documents` (`extension_id`,`collection`,`document_id`);--> statement-breakpoint
CREATE TABLE `extension_index_filter_values` (
	`document_row_id` integer NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`document_row_id`, `field`, `value`),
	FOREIGN KEY (`document_row_id`) REFERENCES `extension_index_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_index_filter_values_lookup_idx` ON `extension_index_filter_values` (`field`,`value`,`document_row_id`);--> statement-breakpoint
CREATE TABLE `extension_index_vectors` (
	`document_row_id` integer NOT NULL,
	`space` text NOT NULL,
	`vector` blob NOT NULL,
	`scale` real NOT NULL,
	`text_digest` text NOT NULL,
	PRIMARY KEY(`document_row_id`, `space`),
	FOREIGN KEY (`document_row_id`) REFERENCES `extension_index_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_index_vectors_space_idx` ON `extension_index_vectors` (`space`,`document_row_id`);--> statement-breakpoint
CREATE TABLE `extension_library_assets` (
	`extension_id` text NOT NULL,
	`asset_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`extension_id`, `asset_id`),
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "extension_library_assets_added_at_ck" CHECK("extension_library_assets"."added_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `extension_library_assets_added_idx` ON `extension_library_assets` (`extension_id`,`added_at`,`asset_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_asset_channel_grants` (
	`asset_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `channel_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "asset_channel_grants_source_ck" CHECK("__new_asset_channel_grants"."source" IN ('agent-tool', 'extension-library')),
	CONSTRAINT "asset_channel_grants_granted_at_ck" CHECK("__new_asset_channel_grants"."granted_at" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_asset_channel_grants`("asset_id", "channel_id", "source", "granted_at") SELECT "asset_id", "channel_id", "source", "granted_at" FROM `asset_channel_grants`;--> statement-breakpoint
DROP TABLE `asset_channel_grants`;--> statement-breakpoint
ALTER TABLE `__new_asset_channel_grants` RENAME TO `asset_channel_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `asset_channel_grants_channel_idx` ON `asset_channel_grants` (`channel_id`,`granted_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE `extension_index_fts` USING fts5(`f1`, `f2`, `f3`, `f4`, tokenize = 'unicode61');--> statement-breakpoint
CREATE TRIGGER `extension_index_documents_fts_delete` AFTER DELETE ON `extension_index_documents` BEGIN
	DELETE FROM `extension_index_fts` WHERE rowid = old.`id`;
END;
