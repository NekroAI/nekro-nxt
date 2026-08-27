CREATE TABLE `host_extension_installations` (
	`extension_id` text PRIMARY KEY NOT NULL,
	`extension_revision_id` text NOT NULL,
	`installed_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extension_revision_id`,`extension_id`) REFERENCES `extension_revisions`(`id`,`extension_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "host_extension_installations_installed_at_ck" CHECK("host_extension_installations"."installed_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_extension_installations_revision_uq` ON `host_extension_installations` (`extension_id`,`extension_revision_id`);