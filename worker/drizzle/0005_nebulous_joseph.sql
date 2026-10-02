CREATE TABLE `sync_aux_versions` (
	`entity` text NOT NULL,
	`entity_key` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`entity`, `entity_key`),
	CONSTRAINT "sync_aux_entity" CHECK("sync_aux_versions"."entity" IN ('preference','planning_settings','action_log','command_audit')),
	CONSTRAINT "sync_aux_revision" CHECK(typeof("sync_aux_versions"."revision") = 'integer' AND "sync_aux_versions"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `sync_feed` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`epoch` integer NOT NULL,
	`entity` text NOT NULL,
	`entity_key` text NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL,
	`row_json` text NOT NULL,
	`deleted_at` text,
	`recorded_at` text NOT NULL,
	CONSTRAINT "sync_feed_seq" CHECK(typeof("sync_feed"."seq") = 'integer' AND "sync_feed"."seq" BETWEEN 1 AND 9007199254740991),
	CONSTRAINT "sync_feed_epoch" CHECK(typeof("sync_feed"."epoch") = 'integer' AND "sync_feed"."epoch" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sync_feed_entity" CHECK("sync_feed"."entity" IN ('task','project','link','duty','preference','planning_settings','action_log','command_audit')),
	CONSTRAINT "sync_feed_revision" CHECK(typeof("sync_feed"."revision") = 'integer' AND "sync_feed"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sync_feed_operation" CHECK("sync_feed"."operation" IN ('upsert','delete')),
	CONSTRAINT "sync_feed_row" CHECK(json_valid("sync_feed"."row_json"))
);
--> statement-breakpoint
CREATE INDEX `sync_feed_entity` ON `sync_feed` (`entity`,`entity_key`,`seq`);--> statement-breakpoint
CREATE TABLE `sync_metadata` (
	`id` integer PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`watermark` integer DEFAULT 0 NOT NULL,
	`retention_floor` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "sync_metadata_singleton" CHECK("sync_metadata"."id" = 1),
	CONSTRAINT "sync_metadata_epoch" CHECK(typeof("sync_metadata"."epoch") = 'integer' AND "sync_metadata"."epoch" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sync_metadata_watermark" CHECK(typeof("sync_metadata"."watermark") = 'integer' AND "sync_metadata"."watermark" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "sync_metadata_floor" CHECK(typeof("sync_metadata"."retention_floor") = 'integer' AND "sync_metadata"."retention_floor" BETWEEN 0 AND "sync_metadata"."watermark")
);
