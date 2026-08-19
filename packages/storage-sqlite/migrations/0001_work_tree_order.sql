CREATE TABLE `work_tree_order` (
	`id` integer PRIMARY KEY NOT NULL,
	`agent_ids` text NOT NULL,
	`channel_ids_by_agent` text NOT NULL,
	`unbound_channel_ids` text NOT NULL,
	CONSTRAINT "work_tree_order_singleton_ck" CHECK("work_tree_order"."id" = 1)
);
