ALTER TABLE `projects` ADD `sort_key` text DEFAULT 'V' NOT NULL;--> statement-breakpoint
UPDATE `projects`
SET `sort_key` = (
	SELECT printf('%016d', ranked.position)
	FROM (
		SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS position
		FROM `projects`
	) AS ranked
	WHERE ranked.id = `projects`.`id`
);--> statement-breakpoint
CREATE INDEX `projects_sort_idx` ON `projects` (`sort_key`,`id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `sort_key` text;--> statement-breakpoint
UPDATE `threads`
SET `sort_key` = (
	SELECT printf('%016d', ranked.position)
	FROM (
		SELECT
			id,
			ROW_NUMBER() OVER (
				PARTITION BY project_id
				ORDER BY created_at DESC, id
			) AS position
		FROM `threads`
		WHERE type = 'manager'
	) AS ranked
	WHERE ranked.id = `threads`.`id`
)
WHERE `type` = 'manager';--> statement-breakpoint
CREATE INDEX `threads_project_type_sort_idx` ON `threads` (`project_id`,`type`,`sort_key`,`id`);
