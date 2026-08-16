ALTER TABLE `channel_events` ADD `logical_message_id` text;
--> statement-breakpoint
UPDATE `channel_events` SET `logical_message_id` = 'msg_' || `id` WHERE `logical_message_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_events_logical_message_id_unique` ON `channel_events` (`logical_message_id`);
