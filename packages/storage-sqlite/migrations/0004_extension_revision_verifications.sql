CREATE TABLE `extension_revision_verifications` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`verified_at` integer NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`revision_id`) REFERENCES `extension_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
