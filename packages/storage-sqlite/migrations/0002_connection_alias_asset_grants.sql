CREATE TABLE `asset_channel_grants` (
	`asset_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`source` text NOT NULL,
	`granted_at` integer NOT NULL,
	PRIMARY KEY(`asset_id`, `channel_id`),
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "asset_channel_grants_source_ck" CHECK("asset_channel_grants"."source" = 'agent-tool'),
	CONSTRAINT "asset_channel_grants_granted_at_ck" CHECK("asset_channel_grants"."granted_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `asset_channel_grants_channel_idx` ON `asset_channel_grants` (`channel_id`,`granted_at`);--> statement-breakpoint
ALTER TABLE `connections` ADD `alias` text;
