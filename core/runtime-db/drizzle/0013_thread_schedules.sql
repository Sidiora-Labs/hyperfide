CREATE TABLE `thread_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`kind` text DEFAULT 'cron' NOT NULL,
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
CREATE INDEX `thread_schedules_due_idx` ON `thread_schedules` (`enabled`,`next_fire_at`);--> statement-breakpoint
CREATE INDEX `thread_schedules_project_idx` ON `thread_schedules` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `thread_schedules_thread_name_idx` ON `thread_schedules` (`thread_id`,`name`);--> statement-breakpoint
INSERT INTO `thread_schedules` (
	`id`,
	`project_id`,
	`thread_id`,
	`name`,
	`enabled`,
	`kind`,
	`cron`,
	`timezone`,
	`prompt`,
	`next_fire_at`,
	`last_fired_at`,
	`created_at`,
	`updated_at`
)
SELECT
	-- Legacy manager-thread-nudge ids use mnge_*; preserve the suffix as tsched_*.
	'tsched_' || substr(`id`, instr(`id`, '_') + 1),
	`project_id`,
	`thread_id`,
	`name`,
	`enabled`,
	'cron',
	`cron`,
	`timezone`,
	'Scheduled follow-up: ' || `name` || '. Review the thread context and storage, then continue only if there is useful work to do.',
	`next_fire_at`,
	`last_fired_at`,
	`created_at`,
	`updated_at`
FROM `manager_thread_nudges`;--> statement-breakpoint
DROP TABLE `manager_thread_nudges`;
