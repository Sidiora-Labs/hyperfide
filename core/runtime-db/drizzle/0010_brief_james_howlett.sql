CREATE TABLE `host_daemon_command_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`command_id` text NOT NULL,
	`session_id` text,
	`status` text NOT NULL,
	`delivered_at` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`settled_at` integer,
	FOREIGN KEY (`command_id`) REFERENCES `host_daemon_commands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `host_daemon_sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `host_daemon_command_attempts_command_status_idx` ON `host_daemon_command_attempts` (`command_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `host_daemon_command_attempts_active_command_idx` ON `host_daemon_command_attempts` (`command_id`) WHERE "host_daemon_command_attempts"."status" = 'active';--> statement-breakpoint
CREATE INDEX `host_daemon_command_attempts_active_expiry_idx` ON `host_daemon_command_attempts` (`status`,`lease_expires_at`) WHERE "host_daemon_command_attempts"."status" = 'active';--> statement-breakpoint
CREATE INDEX `host_daemon_command_attempts_session_idx` ON `host_daemon_command_attempts` (`session_id`);--> statement-breakpoint
INSERT INTO `host_daemon_command_attempts` (
	`id`,
	`command_id`,
	`session_id`,
	`status`,
	`delivered_at`,
	`lease_expires_at`,
	`settled_at`
)
SELECT
	'hcat_migrated_' || `id`,
	`id`,
	`session_id`,
	'active',
	COALESCE(`fetched_at`, `created_at`),
	COALESCE(`fetched_at`, `created_at`) + CASE
		WHEN `type` = 'environment.provision' THEN 1200000
		ELSE 60000
	END,
	NULL
FROM `host_daemon_commands`
WHERE `state` = 'fetched';
