CREATE TABLE `models` (
	`provider_id` text NOT NULL,
	`id` text NOT NULL,
	`display_name` text NOT NULL,
	`sdk` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `models_pk` PRIMARY KEY(`id`, `provider_id`)
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
