CREATE TABLE `change_feed` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `command_receipts`(`command_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "feed_entity" CHECK("change_feed"."entity" = 'planning_settings' AND "change_feed"."entity_id" = 'workspace'),
	CONSTRAINT "feed_revision" CHECK(typeof("change_feed"."revision") = 'integer' AND "change_feed"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "feed_operation" CHECK("change_feed"."operation" = 'upsert'),
	CONSTRAINT "feed_payload" CHECK(json_valid("change_feed"."payload_json"))
);
--> statement-breakpoint
CREATE INDEX `change_feed_entity` ON `change_feed` (`entity`,`entity_id`,`seq`);--> statement-breakpoint
CREATE TABLE `command_audit` (
	`command_id` text PRIMARY KEY NOT NULL,
	`actor` text NOT NULL,
	`reason` text,
	`changes_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `command_receipts`(`command_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "command_actor" CHECK("command_audit"."actor" IN ('user','llm','import','system')),
	CONSTRAINT "command_changes" CHECK(json_valid("command_audit"."changes_json"))
);
--> statement-breakpoint
CREATE TABLE `command_receipts` (
	`command_id` text PRIMARY KEY NOT NULL,
	`payload_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "receipt_hash" CHECK(length("command_receipts"."payload_hash") = 64 AND "command_receipts"."payload_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "receipt_result" CHECK(json_valid("command_receipts"."result_json"))
);
--> statement-breakpoint
CREATE TABLE `duties` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`kickoff_note` text,
	`task_type` text DEFAULT 'action' NOT NULL,
	`project_id` text,
	`rrule` text NOT NULL,
	`dtstart` text NOT NULL,
	`timezone` text,
	`status` text DEFAULT 'active' NOT NULL,
	`catch_up` text DEFAULT 'next' NOT NULL,
	`last_spawned_at` text,
	`next_occurrence_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `duties_next_occurrence_at` ON `duties` (`next_occurrence_at`);--> statement-breakpoint
CREATE TABLE `planning_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`timezone` text NOT NULL,
	`buffer_minutes` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "planning_settings_singleton" CHECK("planning_settings"."id" = 1),
	CONSTRAINT "planning_settings_buffer" CHECK(typeof("planning_settings"."buffer_minutes") = 'integer' AND "planning_settings"."buffer_minutes" BETWEEN 0 AND 1440),
	CONSTRAINT "planning_settings_revision" CHECK(typeof("planning_settings"."revision") = 'integer' AND "planning_settings"."revision" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE `planning_working_hours` (
	`settings_id` integer NOT NULL,
	`weekday` integer NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	PRIMARY KEY(`settings_id`, `weekday`, `start_time`),
	FOREIGN KEY (`settings_id`) REFERENCES `planning_settings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "planning_hours_singleton" CHECK("planning_working_hours"."settings_id" = 1),
	CONSTRAINT "planning_hours_weekday" CHECK(typeof("planning_working_hours"."weekday") = 'integer' AND "planning_working_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "planning_hours_start" CHECK("planning_working_hours"."start_time" GLOB '[0-2][0-9]:[0-5][0-9]' AND "planning_working_hours"."start_time" < '24:00'),
	CONSTRAINT "planning_hours_end" CHECK("planning_working_hours"."end_time" GLOB '[0-2][0-9]:[0-5][0-9]' AND "planning_working_hours"."end_time" < '24:00' AND "planning_working_hours"."end_time" > "planning_working_hours"."start_time")
);
--> statement-breakpoint
ALTER TABLE `action_log` ADD `duty_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `due_all_day` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `duty_id` text REFERENCES duties(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `occurrence_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_duty_occurrence` ON `tasks` (`duty_id`,`occurrence_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_due_date` ON `tasks` (`due_date`);--> statement-breakpoint
CREATE INDEX `idx_tasks_project_id` ON `tasks` (`project_id`);