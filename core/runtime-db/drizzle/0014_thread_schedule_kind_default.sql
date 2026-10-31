PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_thread_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`kind` text NOT NULL,
	`cron` text NOT NULL,
	`timezone` text NOT NULL,
	`prompt` text NOT NULL,
	`next_fire_at` integer NOT NULL,
	`last_fired_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_thread_schedules`("id", "project_id", "thread_id", "name", "enabled", "kind", "cron", "timezone", "prompt", "next_fire_at", "last_fired_at", "created_at", "updated_at") SELECT "id", "project_id", "thread_id", "name", "enabled", "kind", "cron", "timezone", "prompt", "next_fire_at", "last_fired_at", "created_at", "updated_at" FROM `thread_schedules`;--> statement-breakpoint
DROP TABLE `thread_schedules`;--> statement-breakpoint
ALTER TABLE `__new_thread_schedules` RENAME TO `thread_schedules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `thread_schedules_due_idx` ON `thread_schedules` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `thread_schedules_project_idx` ON `thread_schedules` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_schedules_thread_name_idx` ON `thread_schedules` (`thread_id`,`name`);