ALTER TABLE `command_executions` ADD `needs_recovery` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `command_executions` SET `needs_recovery` = (`status` IN ('pending', 'running') OR (json_extract(`record`, '$.replyIntentId') IS NULL AND json_extract(`record`, '$.replyError') IS NULL AND COALESCE(json_extract(`record`, '$.replySuppressed'), 0) = 0));--> statement-breakpoint
CREATE INDEX `command_execution_recovery_idx` ON `command_executions` (`needs_recovery`,`id`);
