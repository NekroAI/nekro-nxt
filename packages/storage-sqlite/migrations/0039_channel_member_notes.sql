CREATE TABLE `channel_member_notes` (
	`channel_id` text NOT NULL,
	`member_id` text NOT NULL,
	`text` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`channel_id`, `member_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `channel_members`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "channel_member_notes_updated_by_ck" CHECK("channel_member_notes"."updated_by" IN ('admin', 'agent'))
);
