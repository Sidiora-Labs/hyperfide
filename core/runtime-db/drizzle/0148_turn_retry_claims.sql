CREATE TABLE `turn_retry_claims` (
	`thread_id` text NOT NULL REFERENCES `threads`(`id`) ON DELETE CASCADE,
	`original_request_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`thread_id`, `original_request_id`, `attempt`)
);
