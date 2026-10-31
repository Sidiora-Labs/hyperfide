CREATE TABLE `client_turn_requests` (
	`request_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`environment_id` text,
	`request_event_sequence` integer NOT NULL,
	`command_id` text NOT NULL,
	`command_type` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`message` text,
	`created_at` integer NOT NULL,
	`command_completed_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `client_turn_requests_thread_sequence_idx` ON `client_turn_requests` (`thread_id`,`request_event_sequence`);--> statement-breakpoint
CREATE INDEX `client_turn_requests_command_idx` ON `client_turn_requests` (`command_id`);--> statement-breakpoint
CREATE INDEX `client_turn_requests_thread_status_idx` ON `client_turn_requests` (`thread_id`,`status`);--> statement-breakpoint
CREATE INDEX `client_turn_requests_thread_request_idx` ON `client_turn_requests` (`thread_id`,`request_id`);