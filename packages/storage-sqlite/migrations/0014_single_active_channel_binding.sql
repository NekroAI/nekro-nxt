DROP INDEX IF EXISTS `bindings_active_agent_uq`;
--> statement-breakpoint
WITH `ranked` AS (
  SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `channel_id` ORDER BY `created_at` DESC, `id` DESC) AS `position`
  FROM `bindings`
)
UPDATE `bindings`
SET `active` = CASE
  WHEN `id` IN (SELECT `id` FROM `ranked` WHERE `position` = 1) THEN 1
  ELSE 0
END;
--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_active_channel_uq` ON `bindings` (`channel_id`) WHERE `active` = 1;
