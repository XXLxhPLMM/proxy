ALTER TABLE `sessions` ADD `status` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `is_active` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_active_updated_at_idx` ON `sessions` (`is_active`,`updated_at`);