PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_asset_occurrences` (
	`channel_event_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`channel_event_id`, `part_index`, `asset_id`),
	FOREIGN KEY (`channel_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "asset_occurrences_part_index_ck" CHECK("__new_asset_occurrences"."part_index" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_asset_occurrences`("channel_event_id", "part_index", "asset_id") SELECT "channel_event_id", "part_index", "asset_id" FROM `asset_occurrences`;--> statement-breakpoint
DROP TABLE `asset_occurrences`;--> statement-breakpoint
ALTER TABLE `__new_asset_occurrences` RENAME TO `asset_occurrences`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `asset_occurrences_asset_idx` ON `asset_occurrences` (`asset_id`,`channel_event_id`);