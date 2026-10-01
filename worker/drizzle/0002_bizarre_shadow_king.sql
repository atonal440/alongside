CREATE TABLE `entity_versions` (
	`entity` text NOT NULL,
	`entity_key` text NOT NULL,
	`revision` integer NOT NULL,
	`deleted_at` text,
	PRIMARY KEY(`entity`, `entity_key`),
	CONSTRAINT "entity_versions_entity" CHECK("entity_versions"."entity" IN ('task','project','link','duty')),
	CONSTRAINT "entity_versions_revision" CHECK(typeof("entity_versions"."revision") = 'integer' AND "entity_versions"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `workspace_versions` (
	`id` integer PRIMARY KEY NOT NULL,
	`structural_revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "workspace_versions_singleton" CHECK("workspace_versions"."id" = 1),
	CONSTRAINT "workspace_versions_revision" CHECK(typeof("workspace_versions"."structural_revision") = 'integer' AND "workspace_versions"."structural_revision" BETWEEN 0 AND 9007199254740991)
);
