CREATE INDEX `host_daemon_commands_host_type_state_idx` ON `host_daemon_commands` (`host_id`,`type`,`state`);--> statement-breakpoint
CREATE INDEX `host_daemon_commands_type_state_idx` ON `host_daemon_commands` (`type`,`state`);
