CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "oauth_clients_redirect_uris_json" CHECK(json_valid("oauth_clients"."redirect_uris"))
);
--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`client_id` text NOT NULL,
	`scope` text NOT NULL,
	`family_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	CONSTRAINT "oauth_tokens_kind" CHECK("oauth_tokens"."kind" IN ('access','refresh'))
);
--> statement-breakpoint
CREATE INDEX `oauth_tokens_family` ON `oauth_tokens` (`family_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_expires` ON `oauth_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `oauth_codes` ADD `scope` text DEFAULT 'mcp' NOT NULL;