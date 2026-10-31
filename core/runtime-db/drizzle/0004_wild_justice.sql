ALTER TABLE `queued_thread_messages` RENAME TO `__old_queued_thread_messages`;--> statement-breakpoint
CREATE TABLE `queued_thread_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`content` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`permission_mode` text NOT NULL,
	`service_tier` text NOT NULL,
	`claimed_at` integer,
	`claim_token` text,
	`sort_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `queued_thread_messages` (
	`id`,
	`thread_id`,
	`content`,
	`model`,
	`reasoning_level`,
	`permission_mode`,
	`service_tier`,
	`claimed_at`,
	`claim_token`,
	`sort_key`,
	`created_at`,
	`updated_at`
)
SELECT
	`id`,
	`thread_id`,
	`content`,
	`model`,
	`reasoning_level`,
	`permission_mode`,
	`service_tier`,
	`claimed_at`,
	`claim_token`,
	printf(
		'%016d',
		ROW_NUMBER() OVER (
			PARTITION BY `thread_id`
			ORDER BY `created_at`, `id`
		)
	),
	`created_at`,
	`updated_at`
FROM `__old_queued_thread_messages`;--> statement-breakpoint
DROP TABLE `__old_queued_thread_messages`;--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_created_idx` ON `queued_thread_messages` (`thread_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `queued_thread_messages_thread_sort_idx` ON `queued_thread_messages` (`thread_id`,`sort_key`,`id`);
