ALTER TABLE `channels` ADD `platform_display_name` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `preferred_processing_feedback` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
UPDATE `channels` SET `preferred_processing_feedback` = COALESCE((SELECT `processing_feedback` FROM `channel_bindings` WHERE `channel_bindings`.`channel_id` = `channels`.`id`), 'auto');
