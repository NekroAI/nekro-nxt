ALTER TABLE `extension_revisions` ADD `payload_digest` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `extension_revisions` SET `payload_digest` = `content_digest`;--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_payload_digest_uq` ON `extension_revisions` (`extension_id`,`payload_digest`);--> statement-breakpoint
ALTER TABLE `local_extensions` ADD `scope` text NOT NULL DEFAULT 'agent';--> statement-breakpoint
UPDATE `local_extensions`
SET `scope` = 'host-adapter'
WHERE EXISTS (
  SELECT 1
  FROM `extension_revisions`
  JOIN `extension_revision_verifications`
    ON `extension_revision_verifications`.`revision_id` = `extension_revisions`.`id`
  WHERE `extension_revisions`.`extension_id` = `local_extensions`.`id`
    AND json_extract(`extension_revision_verifications`.`evidence`, '$.scope') = 'host-adapter'
);
