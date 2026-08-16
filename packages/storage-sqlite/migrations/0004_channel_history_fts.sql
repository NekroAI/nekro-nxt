CREATE VIRTUAL TABLE `channel_history_fts` USING fts5(
	`source_id` UNINDEXED,
	`source_kind` UNINDEXED,
	`channel_id` UNINDEXED,
	`content`,
	tokenize = 'trigram'
);
--> statement-breakpoint
INSERT INTO `channel_history_fts` (`source_id`, `source_kind`, `channel_id`, `content`)
SELECT e.`id`, 'channel-event', e.`channel_id`,
	group_concat(
		CASE json_extract(part.value, '$.type')
			WHEN 'text' THEN json_extract(part.value, '$.text')
			WHEN 'mention' THEN json_extract(part.value, '$.memberId')
			WHEN 'image' THEN coalesce(json_extract(part.value, '$.alt'), '') || ' ' || json_extract(part.value, '$.assetId')
			WHEN 'file' THEN coalesce(json_extract(part.value, '$.name'), '') || ' ' || json_extract(part.value, '$.assetId')
			WHEN 'audio' THEN json_extract(part.value, '$.assetId')
			WHEN 'quote' THEN json_extract(part.value, '$.messageId')
			ELSE ''
		END,
		' '
	)
FROM `channel_events` e, json_each(e.`parts_json`) part
GROUP BY e.`id`;
--> statement-breakpoint
INSERT INTO `channel_history_fts` (`source_id`, `source_kind`, `channel_id`, `content`)
SELECT o.`id`, 'outbound-intent', o.`channel_id`,
	group_concat(
		CASE json_extract(part.value, '$.type')
			WHEN 'text' THEN json_extract(part.value, '$.text')
			WHEN 'mention' THEN json_extract(part.value, '$.memberId')
			WHEN 'image' THEN coalesce(json_extract(part.value, '$.alt'), '') || ' ' || json_extract(part.value, '$.assetId')
			WHEN 'file' THEN coalesce(json_extract(part.value, '$.name'), '') || ' ' || json_extract(part.value, '$.assetId')
			WHEN 'audio' THEN json_extract(part.value, '$.assetId')
			WHEN 'quote' THEN json_extract(part.value, '$.messageId')
			ELSE ''
		END,
		' '
	)
FROM `outbound_intents` o, json_each(o.`parts_json`) part
GROUP BY o.`id`;
