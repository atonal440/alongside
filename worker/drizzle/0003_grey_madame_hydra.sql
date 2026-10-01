PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_change_feed` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `command_receipts`(`command_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feed_entity" CHECK(("__new_change_feed"."entity" = 'planning_settings' AND "__new_change_feed"."entity_id" = 'workspace') OR ("__new_change_feed"."entity" = 'task' AND "__new_change_feed"."entity_id" GLOB 't_*') OR ("__new_change_feed"."entity" = 'project' AND "__new_change_feed"."entity_id" GLOB 'p_*')),
	CONSTRAINT "feed_revision" CHECK(typeof("__new_change_feed"."revision") = 'integer' AND "__new_change_feed"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "feed_operation" CHECK("__new_change_feed"."operation" = 'upsert'),
	CONSTRAINT "feed_payload" CHECK(json_valid("__new_change_feed"."payload_json"))
);
--> statement-breakpoint
INSERT INTO `__new_change_feed`("seq", "command_id", "entity", "entity_id", "revision", "operation", "payload_json", "created_at") SELECT "seq", "command_id", "entity", "entity_id", "revision", "operation", "payload_json", "created_at" FROM `change_feed`;--> statement-breakpoint
DROP TABLE `change_feed`;--> statement-breakpoint
ALTER TABLE `__new_change_feed` RENAME TO `change_feed`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `change_feed_entity` ON `change_feed` (`entity`,`entity_id`,`seq`);