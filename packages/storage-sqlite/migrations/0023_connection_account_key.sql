ALTER TABLE `connections` ADD `account_key` text;--> statement-breakpoint
UPDATE `connections`
SET `account_key` = trim(json_extract(`config`, '$.accountId'))
WHERE `adapter_key` = 'wechat-ilink'
  AND json_valid(`config`)
  AND json_type(`config`, '$.accountId') = 'text'
  AND length(trim(json_extract(`config`, '$.accountId'))) > 0;--> statement-breakpoint
UPDATE `connections`
SET `archived_at` = CAST(strftime('%s', 'now') AS integer) * 1000
WHERE `archived_at` IS NULL
  AND `account_key` IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM `connections` AS `older`
    WHERE `older`.`adapter_key` = `connections`.`adapter_key`
      AND `older`.`account_key` = `connections`.`account_key`
      AND `older`.`archived_at` IS NULL
      AND (
        `older`.`created_at` < `connections`.`created_at`
        OR (`older`.`created_at` = `connections`.`created_at` AND `older`.`id` < `connections`.`id`)
      )
  );--> statement-breakpoint
CREATE UNIQUE INDEX `connections_adapter_account_uq` ON `connections` (`adapter_key`,`account_key`) WHERE "connections"."account_key" IS NOT NULL AND "connections"."archived_at" IS NULL;
