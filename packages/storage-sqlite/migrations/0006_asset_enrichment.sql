CREATE TABLE `asset_enrichments` (
	`id` text PRIMARY KEY NOT NULL,
	`asset_id` text NOT NULL,
	`enhancer_id` text NOT NULL,
	`provider` text NOT NULL,
	`model_id` text NOT NULL,
	`prompt_version` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`state` text NOT NULL,
	`summary` text,
	`ocr_text` text,
	`tags_json` text,
	`input_digest` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`failure_kind` text,
	`error_summary` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `asset_enrichments_key_uq` ON `asset_enrichments` (`asset_id`,`enhancer_id`,`model_id`,`prompt_version`,`schema_version`);