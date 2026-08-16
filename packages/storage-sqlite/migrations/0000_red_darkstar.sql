CREATE TABLE `migration_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	`error_summary` text
);
