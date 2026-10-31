ALTER TABLE `projects` ADD `kind` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `projects` (`id`, `kind`, `name`, `sort_key`, `created_at`, `updated_at`)
VALUES (
  'proj_personal',
  'personal',
  'Personal',
  'V',
  CAST(strftime('%s', 'now') AS integer) * 1000,
  CAST(strftime('%s', 'now') AS integer) * 1000
);--> statement-breakpoint
CREATE UNIQUE INDEX `projects_personal_singleton_idx` ON `projects` (`kind`) WHERE "projects"."kind" = 'personal';
