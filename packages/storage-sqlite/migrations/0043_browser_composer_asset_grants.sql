CREATE TABLE `__new_asset_channel_grants` (
	`asset_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `channel_id`),
	CONSTRAINT `asset_channel_grants_source_ck` CHECK(`__new_asset_channel_grants`.`source` IN ('agent-tool', 'extension-library', 'browser-composer')),
	CONSTRAINT `asset_channel_grants_granted_at_ck` CHECK(`__new_asset_channel_grants`.`granted_at` >= 0),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_asset_channel_grants`(`asset_id`, `channel_id`, `source`, `granted_at`) SELECT `asset_id`, `channel_id`, `source`, `granted_at` FROM `asset_channel_grants`;--> statement-breakpoint
DROP TABLE `asset_channel_grants`;--> statement-breakpoint
ALTER TABLE `__new_asset_channel_grants` RENAME TO `asset_channel_grants`;--> statement-breakpoint
CREATE INDEX `asset_channel_grants_channel_idx` ON `asset_channel_grants` (`channel_id`,`granted_at`);
