CREATE TABLE `message_parts` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`idx` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text,
	`tool_call_id` text,
	`tool_name` text,
	`payload` text,
	`is_error` integer,
	CONSTRAINT `message_parts_pk` PRIMARY KEY(`session_id`, `seq`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`role` text NOT NULL,
	`model_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT `messages_pk` PRIMARY KEY(`session_id`, `seq`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`model_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
