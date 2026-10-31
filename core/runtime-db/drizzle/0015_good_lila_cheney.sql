ALTER TABLE `projects` ADD `deleted_at` integer;--> statement-breakpoint
ALTER TABLE `hosts` DROP COLUMN `command_cursor`;--> statement-breakpoint
UPDATE `projects`
SET `deleted_at` = (
  SELECT `project_operations`.`requested_at`
  FROM `project_operations`
  WHERE `project_operations`.`project_id` = `projects`.`id`
    AND `project_operations`.`kind` = 'delete'
    AND `project_operations`.`state` IN ('requested', 'queued')
  ORDER BY `project_operations`.`requested_at` ASC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM `project_operations`
  WHERE `project_operations`.`project_id` = `projects`.`id`
    AND `project_operations`.`kind` = 'delete'
    AND `project_operations`.`state` IN ('requested', 'queued')
);--> statement-breakpoint
-- Active legacy provisioning operations represented transient live RPC work. They are
-- not replayed in the hard-cut migration because their payload is transient
-- orchestration state, and terminal rows are intentionally not copied
-- because durable events retain progress/history.
UPDATE `threads`
SET
  `status` = 'error'
WHERE EXISTS (
  SELECT 1
  FROM `thread_operations`
  WHERE `thread_operations`.`thread_id` = `threads`.`id`
    AND `thread_operations`.`kind` = 'provision'
    AND `thread_operations`.`state` IN ('requested', 'queued')
)
  AND `threads`.`status` IN ('created', 'provisioning');--> statement-breakpoint
-- Active legacy environment provision/reprovision rows are also transient live
-- work. Mark still-provisioning environments error instead of replaying a
-- removed command queue.
UPDATE `environments`
SET `status` = 'error'
WHERE `environments`.`status` = 'provisioning'
  AND EXISTS (
    SELECT 1
    FROM `environment_operations`
    WHERE `environment_operations`.`environment_id` = `environments`.`id`
      AND `environment_operations`.`kind` IN ('provision', 'reprovision')
      AND `environment_operations`.`state` IN ('requested', 'queued')
  );--> statement-breakpoint
UPDATE `threads`
SET
  `stop_requested_at` = COALESCE(`stop_requested_at`, (
    SELECT `thread_operations`.`requested_at`
    FROM `thread_operations`
    WHERE `thread_operations`.`thread_id` = `threads`.`id`
      AND `thread_operations`.`kind` = 'stop'
      AND `thread_operations`.`state` IN ('requested', 'queued')
    ORDER BY `thread_operations`.`requested_at` DESC
    LIMIT 1
  ))
WHERE `stop_requested_at` IS NOT NULL
  OR EXISTS (
    SELECT 1
    FROM `thread_operations`
    WHERE `thread_operations`.`thread_id` = `threads`.`id`
      AND `thread_operations`.`kind` = 'stop'
      AND `thread_operations`.`state` IN ('requested', 'queued')
  );--> statement-breakpoint
-- Legacy stop operation reasons move to immutable interrupted events instead
-- of a thread-row payload column. Missing interruptionReason preserves the
-- previous manual-stop fallback.
INSERT INTO `events` (
  `id`,
  `thread_id`,
  `environment_id`,
  `scope_kind`,
  `turn_id`,
  `provider_thread_id`,
  `sequence`,
  `type`,
  `item_id`,
  `item_kind`,
  `producer_event_id`,
  `producer_event_payload_hash`,
  `data`,
  `created_at`
)
SELECT
  'evt_' || `thread_operations`.`id`,
  `thread_operations`.`thread_id`,
  `threads`.`environment_id`,
  'thread',
  NULL,
  NULL,
  COALESCE((
    SELECT MAX(`existing_events`.`sequence`)
    FROM `events` AS `existing_events`
    WHERE `existing_events`.`thread_id` = `thread_operations`.`thread_id`
  ), 0) + 1,
  'system/thread/interrupted',
  NULL,
  NULL,
  NULL,
  NULL,
  json_object(
    'reason',
    CASE json_extract(`thread_operations`.`payload`, '$.interruptionReason')
      WHEN 'manual-stop' THEN 'manual-stop'
      WHEN 'host-daemon-restarted' THEN 'host-daemon-restarted'
      WHEN 'provider-turn-idle' THEN 'provider-turn-idle'
      ELSE 'manual-stop'
    END
  ),
  `thread_operations`.`requested_at`
FROM `thread_operations`
INNER JOIN `threads` ON `threads`.`id` = `thread_operations`.`thread_id`
WHERE `thread_operations`.`kind` = 'stop'
  AND `thread_operations`.`state` IN ('requested', 'queued');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pending_interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `provider_thread_id` text NOT NULL,
  `provider_request_id` text NOT NULL,
  `session_id` text NOT NULL,
  `status` text NOT NULL,
  `payload` text NOT NULL,
  `resolution` text,
  `status_reason` text,
  `created_at` integer NOT NULL,
  `resolved_at` integer,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_pending_interactions` (
  `id`,
  `thread_id`,
  `turn_id`,
  `provider_id`,
  `provider_thread_id`,
  `provider_request_id`,
  `session_id`,
  `status`,
  `payload`,
  `resolution`,
  `status_reason`,
  `created_at`,
  `resolved_at`,
  `updated_at`
)
SELECT
  `id`,
  `thread_id`,
  `turn_id`,
  `provider_id`,
  `provider_thread_id`,
  `provider_request_id`,
  `session_id`,
  `status`,
  `payload`,
  `resolution`,
  `status_reason`,
  `created_at`,
  `resolved_at`,
  `updated_at`
FROM `pending_interactions`;--> statement-breakpoint
DROP TABLE `pending_interactions`;--> statement-breakpoint
ALTER TABLE `__new_pending_interactions` RENAME TO `pending_interactions`;--> statement-breakpoint
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`provider_id`,`provider_thread_id`,`provider_request_id`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);--> statement-breakpoint
-- Lifecycle operation rows are removed after active resource state backfill.
-- Terminal operation rows are intentionally not copied because durable events retain progress/history.
DROP TABLE `environment_operations`;--> statement-breakpoint
DROP TABLE `project_operations`;--> statement-breakpoint
DROP TABLE `thread_operations`;--> statement-breakpoint
-- Command/request rows are transient orchestration state under the live-RPC cutover and are not replayed.
DROP TABLE `client_turn_requests`;--> statement-breakpoint
DROP TABLE `host_daemon_command_attempts`;--> statement-breakpoint
DROP TABLE `host_daemon_commands`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `projects_deleted_idx` ON `projects` (`deleted_at`);
