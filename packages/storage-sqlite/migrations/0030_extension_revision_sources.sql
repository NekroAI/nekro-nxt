CREATE TABLE `extension_revision_sources` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`kind` text NOT NULL,
	`community_url` text NOT NULL,
	`release_id` text NOT NULL,
	`publisher_handle` text NOT NULL,
	`installed_at` integer NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `extension_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `extension_revision_sources_extension_idx` ON `extension_revision_sources` (`extension_id`);