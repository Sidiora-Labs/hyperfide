UPDATE `pending_interactions`
SET
  `status` = 'interrupted',
  `status_reason` = COALESCE(`status_reason`, 'Pending interaction expired'),
  `resolved_at` = COALESCE(`resolved_at`, `updated_at`, `created_at`),
  `updated_at` = CASE
    WHEN `updated_at` < COALESCE(`resolved_at`, `updated_at`, `created_at`)
      THEN COALESCE(`resolved_at`, `updated_at`, `created_at`)
    ELSE `updated_at`
  END
WHERE `status` = 'expired';
--> statement-breakpoint
UPDATE `events`
SET `data` = json_set(
  `data`,
  '$.status',
  'interrupted',
  '$.statusReason',
  COALESCE(
    json_extract(`data`, '$.statusReason'),
    'Pending interaction expired'
  )
)
WHERE `type` IN (
    'system/permissionGrant/lifecycle',
    'system/userQuestion/lifecycle'
  )
  AND json_extract(`data`, '$.status') = 'expired';
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_pending_interactions` (
  `id` text PRIMARY KEY NOT NULL,
  `thread_id` text NOT NULL,
  `turn_id` text NOT NULL,
  `provider_id` text NOT NULL,
  `provider_thread_id` text NOT NULL,
  `provider_request_id` text NOT NULL,
  `status` text NOT NULL,
  `payload` text NOT NULL,
  `resolution` text,
  `status_reason` text,
  `created_at` integer NOT NULL,
  `resolved_at` integer,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pending_interactions` (
  `id`,
  `thread_id`,
  `turn_id`,
  `provider_id`,
  `provider_thread_id`,
  `provider_request_id`,
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
  `status`,
  `payload`,
  `resolution`,
  `status_reason`,
  `created_at`,
  `resolved_at`,
  `updated_at`
FROM `pending_interactions`;
--> statement-breakpoint
DROP TABLE `pending_interactions`;
--> statement-breakpoint
ALTER TABLE `__new_pending_interactions` RENAME TO `pending_interactions`;
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_interactions_provider_request_idx` ON `pending_interactions` (`provider_id`,`provider_thread_id`,`provider_request_id`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_created_idx` ON `pending_interactions` (`thread_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_thread_status_created_idx` ON `pending_interactions` (`thread_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `pending_interactions_status_created_idx` ON `pending_interactions` (`status`,`created_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
