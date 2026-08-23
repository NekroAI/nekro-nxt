CREATE TABLE `host_security_metadata` (
	`id` integer PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`management_key_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "host_security_metadata_singleton_ck" CHECK("host_security_metadata"."id" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_security_metadata_instance_id_unique` ON `host_security_metadata` (`instance_id`);--> statement-breakpoint
CREATE TABLE `management_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`secret_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE INDEX `management_devices_active_idx` ON `management_devices` (`revoked_at`,`created_at`);