ALTER TABLE `agent_revisions` ADD `aliases` text;--> statement-breakpoint
ALTER TABLE `channel_bindings` ADD `response_timing` text DEFAULT '{}' NOT NULL;