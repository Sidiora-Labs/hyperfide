ALTER TABLE `threads` ADD `pinned_at` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `pin_sort_key` text;--> statement-breakpoint
CREATE INDEX `threads_pin_sort_idx` ON `threads` (`archived_at`,`deleted_at`,`pin_sort_key`,`id`) WHERE `pinned_at` IS NOT NULL;
