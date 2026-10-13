CREATE TABLE `mcps` (
	`id` text PRIMARY KEY,
	`transport` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`command` text,
	`args` text DEFAULT '[]' NOT NULL,
	`env` text,
	`cwd` text,
	`url` text,
	`headers` text,
	`startup_timeout_ms` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mcps_disabled_id_idx` ON `mcps` (`disabled`,`id`);