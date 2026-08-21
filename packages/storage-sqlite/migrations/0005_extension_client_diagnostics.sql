CREATE TABLE `extension_client_diagnostics` (
	`agent_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`observed_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `extension_id`),
	FOREIGN KEY (`agent_id`,`extension_id`) REFERENCES `agent_activations`(`agent_id`,`extension_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`,`extension_id`) REFERENCES `extension_revisions`(`id`,`extension_id`) ON UPDATE no action ON DELETE cascade
);
