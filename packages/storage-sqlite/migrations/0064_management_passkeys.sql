CREATE TABLE `management_passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`rp_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer NOT NULL,
	`transports` text,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `management_passkeys_rp_idx` ON `management_passkeys` (`rp_id`);--> statement-breakpoint
ALTER TABLE `host_security_metadata` ADD `key_sign_in` integer DEFAULT true NOT NULL;