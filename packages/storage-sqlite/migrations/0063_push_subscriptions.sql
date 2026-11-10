CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_delivered_at` integer
);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_device_idx` ON `push_subscriptions` (`device_id`);