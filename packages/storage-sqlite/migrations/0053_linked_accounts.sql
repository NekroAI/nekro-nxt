CREATE TABLE `linked_account_uses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` text NOT NULL,
	`at` integer NOT NULL,
	`agent_id` text,
	`channel_id` text,
	`consumer_kind` text NOT NULL,
	`consumer_id` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `linked_accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `linked_account_uses_account_idx` ON `linked_account_uses` (`account_id`,`at`);--> statement-breakpoint
CREATE TABLE `linked_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`login` text NOT NULL,
	`display_name` text,
	`scopes` text,
	`source` text NOT NULL,
	`credential_ref` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `linked_accounts_platform_idx` ON `linked_accounts` (`platform`,`created_at`);