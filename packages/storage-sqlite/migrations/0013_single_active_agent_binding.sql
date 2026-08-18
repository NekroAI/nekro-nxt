ALTER TABLE `bindings` ADD `active` integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
WITH `ranked` AS (
  SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `agent_id` ORDER BY `created_at` DESC, `id` DESC) AS `position`
  FROM `bindings`
  WHERE `active` = 1
)
UPDATE `bindings` SET `active` = 0 WHERE `id` IN (SELECT `id` FROM `ranked` WHERE `position` > 1);
--> statement-breakpoint
CREATE UNIQUE INDEX `bindings_active_agent_uq` ON `bindings` (`agent_id`) WHERE `active` = 1;
