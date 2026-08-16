ALTER TABLE `agent_revisions` ADD `capabilities_json` text NOT NULL DEFAULT '{"dynamicCreation":false,"developmentShell":false,"fullFileAccess":false}';
