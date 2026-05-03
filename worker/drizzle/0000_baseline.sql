CREATE TABLE `action_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tool_name` text NOT NULL,
	`task_id` text,
	`title` text NOT NULL,
	`detail` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`kickoff_note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_links` (
	`from_task_id` text NOT NULL,
	`to_task_id` text NOT NULL,
	`link_type` text NOT NULL,
	PRIMARY KEY(`from_task_id`, `to_task_id`, `link_type`),
	FOREIGN KEY (`from_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_date` text,
	`recurrence` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`defer_until` text,
	`defer_kind` text DEFAULT 'none' NOT NULL,
	`task_type` text DEFAULT 'action' NOT NULL,
	`project_id` text,
	`kickoff_note` text,
	`session_log` text,
	`focused_until` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
