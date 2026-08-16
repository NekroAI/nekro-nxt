CREATE TABLE `adapter_runtime_states` (
	`connection_id` text NOT NULL,
	`state_key` text NOT NULL,
	`state_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `adapter_runtime_states_connection_key_uq` ON `adapter_runtime_states` (`connection_id`,`state_key`);
