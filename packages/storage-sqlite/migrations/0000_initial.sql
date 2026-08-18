CREATE TABLE `admission_events` (
	`admission_id` text NOT NULL,
	`event_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`admission_id`, `position`),
	FOREIGN KEY (`admission_id`) REFERENCES `admissions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "admission_events_position_ck" CHECK("admission_events"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `admission_events_event_uq` ON `admission_events` (`admission_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `admission_events_event_idx` ON `admission_events` (`event_id`);--> statement-breakpoint
CREATE TABLE `admissions` (
	`id` text PRIMARY KEY NOT NULL,
	`episode_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`dsh_message_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "admissions_mode_ck" CHECK("admissions"."mode" IN ('followup', 'inject')),
	CONSTRAINT "admissions_state_ck" CHECK("admissions"."state" IN ('pending', 'claimed', 'logged-to-session'))
);
--> statement-breakpoint
CREATE INDEX `admissions_recovery_idx` ON `admissions` (`episode_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `agent_activations` (
	`agent_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`extension_revision_id` text NOT NULL,
	`config` text NOT NULL,
	`activated_at` integer NOT NULL,
	PRIMARY KEY(`agent_id`, `extension_id`),
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`extension_revision_id`,`extension_id`) REFERENCES `extension_revisions`(`id`,`extension_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `agent_activations_extension_idx` ON `agent_activations` (`extension_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `agent_current_revisions` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`revision_id` text NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`revision_id`,`agent_id`) REFERENCES `agent_revisions`(`id`,`agent_id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `agent_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`display_name` text NOT NULL,
	`persona` text NOT NULL,
	`model_provider` text NOT NULL,
	`model_id` text NOT NULL,
	`reasoning_effort` text,
	`capabilities` text NOT NULL,
	`content_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "agent_revisions_revision_ck" CHECK("agent_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_revisions_id_agent_uq` ON `agent_revisions` (`id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_revisions_agent_revision_uq` ON `agent_revisions` (`agent_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_revisions_agent_digest_uq` ON `agent_revisions` (`agent_id`,`content_digest`);--> statement-breakpoint
CREATE TABLE `asset_occurrences` (
	`channel_event_id` text NOT NULL,
	`part_index` integer NOT NULL,
	`asset_id` text NOT NULL,
	PRIMARY KEY(`channel_event_id`, `part_index`),
	FOREIGN KEY (`channel_event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "asset_occurrences_part_index_ck" CHECK("asset_occurrences"."part_index" >= 0)
);
--> statement-breakpoint
CREATE INDEX `asset_occurrences_asset_idx` ON `asset_occurrences` (`asset_id`,`channel_event_id`);--> statement-breakpoint
CREATE TABLE `assets` (
	`id` text PRIMARY KEY NOT NULL,
	`content_digest` text NOT NULL,
	`byte_size` integer NOT NULL,
	`media_type` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "assets_byte_size_ck" CHECK("assets"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_content_digest_unique` ON `assets` (`content_digest`);--> statement-breakpoint
CREATE TABLE `channel_bindings` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`trigger_policy` text NOT NULL,
	`bound_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "channel_bindings_trigger_policy_ck" CHECK("channel_bindings"."trigger_policy" IN ('always', 'mentioned-or-replied', 'command', 'observe-only'))
);
--> statement-breakpoint
CREATE INDEX `channel_bindings_agent_idx` ON `channel_bindings` (`agent_id`,`bound_at`);--> statement-breakpoint
CREATE TABLE `channel_events` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_message_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`platform_message_id` text,
	`kind` text NOT NULL,
	`sender_member_id` text,
	`parts` text NOT NULL,
	`source_timestamp` integer NOT NULL,
	`received_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`facts` text,
	`search_text` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sender_member_id`) REFERENCES `channel_members`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "channel_events_kind_ck" CHECK("channel_events"."kind" IN ('message-created', 'message-edited', 'message-deleted', 'member-updated', 'reaction', 'control'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_events_id_channel_uq` ON `channel_events` (`id`,`channel_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_events_logical_message_uq` ON `channel_events` (`logical_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channel_events_channel_dedupe_uq` ON `channel_events` (`channel_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `channel_events_history_idx` ON `channel_events` (`channel_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `channel_events_platform_message_idx` ON `channel_events` (`channel_id`,`platform_message_id`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`platform_identity_id` text NOT NULL,
	`display_name` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`platform_identity_id`) REFERENCES `platform_identities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_members_channel_identity_uq` ON `channel_members` (`channel_id`,`platform_identity_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`platform_channel_id` text NOT NULL,
	`kind` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "channels_kind_ck" CHECK("channels"."kind" IN ('web', 'direct', 'group'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_connection_platform_uq` ON `channels` (`connection_id`,`platform_channel_id`);--> statement-breakpoint
CREATE TABLE `connection_state` (
	`connection_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`adapter_key` text NOT NULL,
	`config` text NOT NULL,
	`credential_refs` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connections_adapter_idx` ON `connections` (`adapter_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `episode_handoff_events` (
	`handoff_id` text NOT NULL,
	`event_id` text NOT NULL,
	`role` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`handoff_id`, `role`, `position`),
	FOREIGN KEY (`handoff_id`) REFERENCES `episode_handoffs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `channel_events`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "episode_handoff_events_role_ck" CHECK("episode_handoff_events"."role" IN ('source', 'recent')),
	CONSTRAINT "episode_handoff_events_position_ck" CHECK("episode_handoff_events"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_handoff_events_event_uq` ON `episode_handoff_events` (`handoff_id`,`role`,`event_id`);--> statement-breakpoint
CREATE TABLE `episode_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`from_episode_id` text NOT NULL,
	`to_episode_id` text NOT NULL,
	`summary` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`to_episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episode_handoffs_from_uq` ON `episode_handoffs` (`from_episode_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episode_handoffs_to_uq` ON `episode_handoffs` (`to_episode_id`);--> statement-breakpoint
CREATE TABLE `episodes` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`dsh_session_id` text,
	`status` text NOT NULL,
	`opened_at_event_id` text NOT NULL,
	`last_admitted_event_id` text,
	`closed_at_event_id` text,
	`closed_at` integer,
	`close_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_revision_id`,`agent_id`) REFERENCES `agent_revisions`(`id`,`agent_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`opened_at_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`last_admitted_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`closed_at_event_id`,`channel_id`) REFERENCES `channel_events`(`id`,`channel_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "episodes_status_ck" CHECK("episodes"."status" IN ('opening', 'active', 'closed', 'failed')),
	CONSTRAINT "episodes_close_reason_ck" CHECK("episodes"."close_reason" IS NULL OR "episodes"."close_reason" IN ('manual', 'idle-timeout', 'incompatible-revision', 'incompatible-activation', 'unrecoverable-session', 'permission-revoked', 'binding-replaced', 'stopped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_dsh_session_id_unique` ON `episodes` (`dsh_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_id_channel_agent_uq` ON `episodes` (`id`,`channel_id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `episodes_live_lane_uq` ON `episodes` (`channel_id`,`agent_id`) WHERE "episodes"."status" IN ('opening', 'active');--> statement-breakpoint
CREATE INDEX `episodes_agent_history_idx` ON `episodes` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `extension_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`extension_id` text NOT NULL,
	`revision_number` integer NOT NULL,
	`content_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`extension_id`) REFERENCES `local_extensions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_id_extension_uq` ON `extension_revisions` (`id`,`extension_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_number_uq` ON `extension_revisions` (`extension_id`,`revision_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `extension_revisions_digest_uq` ON `extension_revisions` (`extension_id`,`content_digest`);--> statement-breakpoint
CREATE TABLE `local_extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`created_by_agent_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agent_definitions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_extensions_slug_unique` ON `local_extensions` (`slug`);--> statement-breakpoint
CREATE TABLE `outbound_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`logical_message_id` text NOT NULL,
	`episode_id` text NOT NULL,
	`agent_revision_id` text NOT NULL,
	`source_turn_id` text,
	`parts` text NOT NULL,
	`search_text` text NOT NULL,
	`reply_to` text,
	`client_request_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`episode_id`) REFERENCES `episodes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`agent_revision_id`) REFERENCES `agent_revisions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "outbound_intents_state_ck" CHECK("outbound_intents"."state" IN ('planned', 'sending', 'sent', 'partially-sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_logical_message_id_unique` ON `outbound_intents` (`logical_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbound_intents_client_request_uq` ON `outbound_intents` (`episode_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `outbound_intents_recovery_idx` ON `outbound_intents` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbound_intents_episode_history_idx` ON `outbound_intents` (`episode_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `physical_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`intent_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`parts` text NOT NULL,
	`adapter_context` text,
	`state` text NOT NULL,
	`platform_message_id` text,
	`capability_outcomes` text,
	`failure_kind` text,
	`result_message` text,
	`retry_after_ms` integer,
	`completed_at` integer,
	FOREIGN KEY (`intent_id`) REFERENCES `outbound_intents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "physical_deliveries_sequence_ck" CHECK("physical_deliveries"."sequence" >= 0),
	CONSTRAINT "physical_deliveries_state_ck" CHECK("physical_deliveries"."state" IN ('planned', 'sending', 'sent', 'failed', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `physical_deliveries_intent_sequence_uq` ON `physical_deliveries` (`intent_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `platform_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`display_name` text,
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_identities_connection_user_uq` ON `platform_identities` (`connection_id`,`platform_user_id`);