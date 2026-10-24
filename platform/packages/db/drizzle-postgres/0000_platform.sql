CREATE SCHEMA IF NOT EXISTS "platform";
--> statement-breakpoint
CREATE TABLE "platform"."app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"caffeinate" bigint DEFAULT 0 NOT NULL,
	"show_keyboard_hints" bigint DEFAULT 1 NOT NULL,
	"steer_active_thread_on_enter" bigint DEFAULT 0 NOT NULL,
	"show_unhandled_provider_events" bigint DEFAULT 0 NOT NULL,
	"codex_memory_enabled" bigint DEFAULT 1 NOT NULL,
	"claude_code_memory_enabled" bigint DEFAULT 1 NOT NULL,
	"codex_subagents_disabled" bigint DEFAULT 0 NOT NULL,
	"claude_code_subagents_disabled" bigint DEFAULT 0 NOT NULL,
	"claude_code_workflows_disabled" bigint DEFAULT 0 NOT NULL,
	"keybinding_overrides" text DEFAULT '[]' NOT NULL,
	"onboarding_completed_at" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."app_settings_values" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."app_theme" (
	"id" text PRIMARY KEY NOT NULL,
	"theme_id" text NOT NULL,
	"favicon_color" text DEFAULT 'default' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"start" text,
	"prefix" text,
	"key" text NOT NULL,
	"referenceId" text NOT NULL,
	"refillInterval" bigint,
	"refillAmount" bigint,
	"lastRefillAt" bigint,
	"enabled" bigint NOT NULL,
	"rateLimitEnabled" bigint NOT NULL,
	"rateLimitTimeWindow" bigint NOT NULL,
	"rateLimitMax" bigint NOT NULL,
	"requestCount" bigint NOT NULL,
	"remaining" bigint,
	"lastRequest" bigint,
	"expiresAt" bigint,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL,
	"permissions" text,
	"metadata" text,
	"configId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" bigint NOT NULL,
	"image" text,
	"createdAt" bigint NOT NULL,
	"updatedAt" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."diff_viewed_files" (
	"environment_id" text NOT NULL,
	"target_key" text NOT NULL,
	"path" text NOT NULL,
	"revision" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "diff_viewed_files_environment_id_target_key_path_pk" PRIMARY KEY("environment_id","target_key","path")
);
--> statement-breakpoint
CREATE TABLE "platform"."environment_hook_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"host_id" text NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "platform"."environment_variables" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"encryption_version" bigint NOT NULL,
	"note" text,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."environments" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"project_id" text NOT NULL,
	"host_id" text NOT NULL,
	"path" text,
	"is_git_repo" bigint DEFAULT 0 NOT NULL,
	"is_worktree" bigint DEFAULT 0 NOT NULL,
	"branch_name" text,
	"base_branch" text,
	"default_branch" text,
	"merge_base_branch" text,
	"environment_provider_id" text,
	"environment_provider_plugin_id" text,
	"provider_owns_path" bigint DEFAULT 0 NOT NULL,
	"environment_provider_selection" text,
	"environment_provider_instance_key" text,
	"retire_at" bigint,
	"teardown_attempt" bigint DEFAULT 0 NOT NULL,
	"teardown_status" text,
	"teardown_message" text,
	"resource" text,
	"owner_thread_id" text,
	"attempt" bigint DEFAULT 0 NOT NULL,
	"status_message" text,
	"pending_log" text DEFAULT '' NOT NULL,
	"claim_path" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."events" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"environment_id" text,
	"scope_kind" text NOT NULL,
	"turn_id" text,
	"provider_thread_id" text,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"item_id" text,
	"item_kind" text,
	"parent_tool_call_id" text,
	"data" text DEFAULT '{}' NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "events_scope_shape_check" CHECK ((
        ("platform"."events"."scope_kind" = 'turn' AND "platform"."events"."turn_id" IS NOT NULL)
        OR
        ("platform"."events"."scope_kind" = 'thread' AND "platform"."events"."turn_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "platform"."host_daemon_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"host_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"host_name" text NOT NULL,
	"data_dir" text NOT NULL,
	"protocol_version" bigint NOT NULL,
	"heartbeat_interval_ms" bigint NOT NULL,
	"lease_timeout_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"lease_expires_at" bigint NOT NULL,
	"closed_at" bigint,
	"close_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"connect_machine_id" text,
	"machine_provider_id" text,
	"launch_key" text,
	"machine_inputs" text,
	"machine_attempt" bigint DEFAULT 0 NOT NULL,
	"pending_log" text DEFAULT '' NOT NULL,
	"machine_operation_id" text,
	"server_access_provider_id" text,
	"server_access_grant_id" text,
	"resource" text,
	"phase" text DEFAULT 'active' NOT NULL,
	"suspended_at" bigint,
	"status_message" text,
	"suspend_retry_at" bigint,
	"remove_retry_at" bigint,
	"teardown_attempt" bigint DEFAULT 0 NOT NULL,
	"teardown_status" text,
	"max_permission_mode" text DEFAULT 'full' NOT NULL,
	"destroyed_at" bigint,
	"last_seen_at" bigint,
	"last_rejected_protocol_version" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."plugins" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"provenance" text DEFAULT 'direct' NOT NULL,
	"catalog_entry_id" text,
	"catalog_marketplace_name" text,
	"source_kind" text DEFAULT 'path' NOT NULL,
	"source_path" text,
	"source_builtin_name" text,
	"source_npm_package" text,
	"source_npm_registry" text,
	"source_npm_requested_spec" text,
	"source_npm_spec_kind" text,
	"source_git_url" text,
	"source_git_subdirectory" text,
	"source_git_requested_ref" text,
	"source_git_ref_kind" text,
	"source_git_range" text,
	"source_git_tag_prefix" text,
	"source_git_resolved_tag" text,
	"npm_resolved_version" text,
	"npm_integrity" text,
	"git_resolved_commit" text,
	"last_update_check_at" bigint,
	"available_compatible_version" text,
	"newest_incompatible_version" text,
	"update_status_detail" text,
	"last_failure_version" text,
	"last_failure_at" bigint,
	"last_failure_detail" text,
	"active_artifact_id" text,
	"normalization_version" bigint DEFAULT 0 NOT NULL,
	"root_dir" text NOT NULL,
	"version" text NOT NULL,
	"enabled" bigint DEFAULT 1 NOT NULL,
	"enabled_follows_default" bigint DEFAULT 0 NOT NULL,
	"removed_at" bigint,
	"installed_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."maintenance_scan_cursors" (
	"id" text PRIMARY KEY NOT NULL,
	"policy" text NOT NULL,
	"version" bigint NOT NULL,
	"item_kind" text NOT NULL,
	"output_path" text NOT NULL,
	"last_created_at" bigint DEFAULT 0 NOT NULL,
	"last_event_id" text DEFAULT '' NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."pending_interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"origin_kind" text DEFAULT 'provider' NOT NULL,
	"turn_id" text,
	"provider_id" text,
	"provider_thread_id" text,
	"provider_request_id" text,
	"plugin_id" text,
	"renderer_id" text,
	"status" text NOT NULL,
	"payload" text NOT NULL,
	"resolution" text,
	"status_reason" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint,
	"resolved_at" bigint,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"npm_resolved_version" text,
	"git_resolved_commit" text,
	"git_checkout_root" text,
	"path" text NOT NULL,
	"integrity" text,
	"content_hash" text,
	"validation_result" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"validated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_kv" (
	"plugin_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "plugin_kv_plugin_id_key_pk" PRIMARY KEY("plugin_id","key")
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_marketplace_icons" (
	"marketplace_name" text NOT NULL,
	"entry_id" text NOT NULL,
	"source_url" text NOT NULL,
	"content_type" text NOT NULL,
	"etag" text,
	"content_hash" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "plugin_marketplace_icons_marketplace_name_entry_id_pk" PRIMARY KEY("marketplace_name","entry_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_marketplaces" (
	"name" text PRIMARY KEY NOT NULL,
	"source_kind" text DEFAULT 'https' NOT NULL,
	"manifest_url" text NOT NULL,
	"source_git_ref" text,
	"source_git_subdirectory" text,
	"source_git_commit" text,
	"manifest_json" text NOT NULL,
	"stats_json" text,
	"etag" text,
	"last_modified" text,
	"last_successful_refresh_at" bigint,
	"last_attempted_refresh_at" bigint,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_schedules" (
	"plugin_id" text NOT NULL,
	"name" text NOT NULL,
	"cron" text NOT NULL,
	"next_run_at" bigint NOT NULL,
	"last_run_at" bigint,
	"last_status" text,
	"last_error" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "plugin_schedules_plugin_id_name_pk" PRIMARY KEY("plugin_id","name")
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_settings" (
	"plugin_id" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "plugin_settings_plugin_id_key_pk" PRIMARY KEY("plugin_id","key")
);
--> statement-breakpoint
CREATE TABLE "platform"."plugin_state_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"from_artifact_id" text,
	"to_artifact_id" text NOT NULL,
	"snapshot_path" text NOT NULL,
	"database_path" text,
	"state_path" text NOT NULL,
	"secrets_path" text,
	"registration_path" text,
	"status" text NOT NULL,
	"rollback_candidate_version" text,
	"rollback_source_fingerprint" text,
	"rollback_hyperfide_version" text,
	"rollback_sdk_version" text,
	"rollback_detail" text,
	"created_at" bigint NOT NULL,
	"retained_until" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."project_attachment_backfills" (
	"project_id" text PRIMARY KEY NOT NULL,
	"phase" text NOT NULL,
	"thread_cursor" text NOT NULL,
	"input_cursor" bigint NOT NULL,
	"input_id" text NOT NULL,
	"input_sequence" bigint NOT NULL,
	"attempted_at" bigint NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "platform"."project_attachment_threads" (
	"attachment_id" text NOT NULL,
	"thread_id" text NOT NULL,
	CONSTRAINT "project_attachment_threads_attachment_id_thread_id_pk" PRIMARY KEY("attachment_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."project_attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"stored_path" text NOT NULL,
	"original_name" text NOT NULL,
	"mime_type" text,
	"size_bytes" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"ready_at" bigint,
	"deletion_claimed_at" bigint,
	CONSTRAINT "project_attachments_size_check" CHECK ("platform"."project_attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform"."project_execution_defaults" (
	"project_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"service_tier" text NOT NULL,
	"reasoning_level" text NOT NULL,
	"permission_mode" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."project_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"host_id" text,
	"path" text,
	"owns_path" bigint DEFAULT 0 NOT NULL,
	"is_default" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "project_sources_shape_check" CHECK ((
        "platform"."project_sources"."type" = 'local_path' AND "platform"."project_sources"."host_id" IS NOT NULL AND "platform"."project_sources"."path" IS NOT NULL
      ))
);
--> statement-breakpoint
CREATE TABLE "platform"."projects" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'standard' NOT NULL,
	"name" text NOT NULL,
	"git_remote_url" text,
	"sort_key" text DEFAULT 'V' NOT NULL,
	"deleted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."prompt_history_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"scope" text NOT NULL,
	"request_sequence" bigint NOT NULL,
	"input" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."provider_model_catalogs" (
	"host_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"scope_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"models_json" text NOT NULL,
	"selected_only_models_json" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "provider_model_catalogs_host_id_provider_id_scope_key_pk" PRIMARY KEY("host_id","provider_id","scope_key")
);
--> statement-breakpoint
CREATE TABLE "platform"."queued_thread_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"system_notice" text,
	"thread_id" text NOT NULL,
	"content" text NOT NULL,
	"sender_thread_id" text,
	"origin" text,
	"origin_plugin_id" text,
	"requested_by_initiator" text,
	"requested_by_thread_id" text,
	"model" text NOT NULL,
	"reasoning_level" text NOT NULL,
	"permission_mode" text NOT NULL,
	"service_tier" text NOT NULL,
	"group_with_next" bigint DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"send_at" bigint,
	"waiting_on" text,
	"wait_holder" text,
	"failure_reason" text,
	"failure_count" bigint DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint,
	"payload_kind" text DEFAULT 'inline' NOT NULL,
	"retry_of_turn_request_id" text,
	"retry_attempt" bigint,
	"retry_reason" text,
	"claimed_at" bigint,
	"claim_token" text,
	"edit_held_until" bigint,
	"sort_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "queued_thread_messages_state_check" CHECK (CASE "platform"."queued_thread_messages"."state"
        WHEN 'claimed' THEN "platform"."queued_thread_messages"."claimed_at" IS NOT NULL
        WHEN 'failed_retrying' THEN "platform"."queued_thread_messages"."claimed_at" IS NULL AND "platform"."queued_thread_messages"."failure_reason" IS NOT NULL AND "platform"."queued_thread_messages"."next_attempt_at" IS NOT NULL
        WHEN 'failed_exhausted' THEN "platform"."queued_thread_messages"."claimed_at" IS NULL AND "platform"."queued_thread_messages"."failure_reason" IS NOT NULL AND "platform"."queued_thread_messages"."next_attempt_at" IS NULL
        WHEN 'scheduled' THEN "platform"."queued_thread_messages"."claimed_at" IS NULL AND "platform"."queued_thread_messages"."failure_reason" IS NULL AND "platform"."queued_thread_messages"."send_at" IS NOT NULL
        WHEN 'waiting' THEN "platform"."queued_thread_messages"."claimed_at" IS NULL AND "platform"."queued_thread_messages"."failure_reason" IS NULL AND "platform"."queued_thread_messages"."send_at" IS NULL AND "platform"."queued_thread_messages"."waiting_on" IS NOT NULL
        WHEN 'queued' THEN "platform"."queued_thread_messages"."claimed_at" IS NULL AND "platform"."queued_thread_messages"."failure_reason" IS NULL AND "platform"."queued_thread_messages"."send_at" IS NULL AND "platform"."queued_thread_messages"."waiting_on" IS NULL
        ELSE false
      END),
	CONSTRAINT "queued_thread_messages_claim_check" CHECK (("platform"."queued_thread_messages"."claimed_at" IS NULL) = ("platform"."queued_thread_messages"."claim_token" IS NULL)),
	CONSTRAINT "queued_thread_messages_failure_check" CHECK (("platform"."queued_thread_messages"."failure_reason" IS NULL AND "platform"."queued_thread_messages"."failure_count" = 0 AND "platform"."queued_thread_messages"."next_attempt_at" IS NULL)
        OR ("platform"."queued_thread_messages"."failure_reason" IS NOT NULL AND "platform"."queued_thread_messages"."failure_count" > 0)),
	CONSTRAINT "queued_thread_messages_schedule_check" CHECK ("platform"."queued_thread_messages"."send_at" IS NULL OR "platform"."queued_thread_messages"."waiting_on" IS NOT NULL),
	CONSTRAINT "queued_thread_messages_wait_holder_check" CHECK ("platform"."queued_thread_messages"."wait_holder" IS NOT DISTINCT FROM (CASE WHEN ("platform"."queued_thread_messages"."waiting_on"::jsonb ->> 'kind') = 'plugin' THEN 'plugin:' || ("platform"."queued_thread_messages"."waiting_on"::jsonb ->> 'pluginId') END))
);
--> statement-breakpoint
CREATE TABLE "platform"."retained_event_outputs" (
	"event_id" text PRIMARY KEY NOT NULL,
	"output_path" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."system_experiments" (
	"key" text PRIMARY KEY NOT NULL,
	"value" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."terminal_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text,
	"environment_id" text,
	"host_id" text NOT NULL,
	"daemon_session_id" text,
	"title" text NOT NULL,
	"initial_cwd" text NOT NULL,
	"cols" bigint NOT NULL,
	"rows" bigint NOT NULL,
	"status" text NOT NULL,
	"exit_code" bigint,
	"close_reason" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"last_user_input_at" bigint
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_conversation_outlines" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"projection_key" text NOT NULL,
	"items_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_dynamic_context_file_states" (
	"thread_id" text NOT NULL,
	"file_key" text NOT NULL,
	"content_status" text NOT NULL,
	"content_hash" text NOT NULL,
	"shown_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_plugin_metadata" (
	"thread_id" text NOT NULL,
	"plugin_id" text NOT NULL,
	"metadata_json" text NOT NULL,
	CONSTRAINT "thread_plugin_metadata_thread_id_plugin_id_pk" PRIMARY KEY("thread_id","plugin_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_pruning_cursors" (
	"policy" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"thread_id" text,
	"version" bigint NOT NULL,
	"last_thread_id" text DEFAULT '' NOT NULL,
	"current_thread_id" text,
	"step" bigint DEFAULT 0 NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"upper_sequence" bigint DEFAULT 0 NOT NULL,
	"work_revision" bigint DEFAULT 0 NOT NULL,
	"cycle" bigint DEFAULT 0 NOT NULL,
	"latest_root_sequence" bigint DEFAULT 0 NOT NULL,
	"latest_context_sequence" bigint DEFAULT 0 NOT NULL,
	"probe_event_id" text,
	"probe_phase" bigint DEFAULT 0 NOT NULL,
	"probe_sequence" bigint DEFAULT 0 NOT NULL,
	"probe_witness_id" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "thread_pruning_cursors_policy_scope_pk" PRIMARY KEY("policy","scope"),
	CONSTRAINT "thread_pruning_cursors_scope_check" CHECK ("platform"."thread_pruning_cursors"."scope" = coalesce("platform"."thread_pruning_cursors"."thread_id", ''))
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_pruning_work" (
	"policy" text NOT NULL,
	"thread_id" text NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	CONSTRAINT "thread_pruning_work_policy_thread_id_pk" PRIMARY KEY("policy","thread_id")
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_search_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_key" text NOT NULL,
	"source_seq" bigint,
	"text" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."thread_tabs" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"tabs_json" text NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."threads" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"environment_id" text,
	"provider_id" text NOT NULL,
	"model_override" text,
	"reasoning_level_override" text,
	"title" text,
	"title_fallback" text,
	"section_id" text,
	"status" text DEFAULT 'starting' NOT NULL,
	"startup_context" text,
	"parent_thread_id" text,
	"lifecycle_owner_thread_id" text,
	"source_thread_id" text,
	"origin_kind" text,
	"origin_plugin_id" text,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"parent_notifications" text DEFAULT 'auto' NOT NULL,
	"archived_at" bigint,
	"pinned_at" bigint,
	"pin_sort_key" text,
	"deleted_at" bigint,
	"storage_deleted_at" bigint,
	"last_read_at" bigint,
	"latest_attention_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."ui_preference_defaults" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."ui_preferences" (
	"key" text PRIMARY KEY NOT NULL,
	"value_json" text NOT NULL,
	"revision" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."apikey" ADD CONSTRAINT "apikey_referenceId_user_id_fk" FOREIGN KEY ("referenceId") REFERENCES "platform"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."diff_viewed_files" ADD CONSTRAINT "diff_viewed_files_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "platform"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."environment_variables" ADD CONSTRAINT "environment_variables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."environments" ADD CONSTRAINT "environments_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "platform"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."events" ADD CONSTRAINT "events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."events" ADD CONSTRAINT "events_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "platform"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."host_daemon_sessions" ADD CONSTRAINT "host_daemon_sessions_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "platform"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."plugins" ADD CONSTRAINT "plugins_active_artifact_id_plugin_artifacts_id_fk" FOREIGN KEY ("active_artifact_id") REFERENCES "platform"."plugin_artifacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."pending_interactions" ADD CONSTRAINT "pending_interactions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_attachment_backfills" ADD CONSTRAINT "project_attachment_backfills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_attachment_threads" ADD CONSTRAINT "project_attachment_threads_attachment_id_project_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "platform"."project_attachments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_attachment_threads" ADD CONSTRAINT "project_attachment_threads_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_attachments" ADD CONSTRAINT "project_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_execution_defaults" ADD CONSTRAINT "project_execution_defaults_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_sources" ADD CONSTRAINT "project_sources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."project_sources" ADD CONSTRAINT "project_sources_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "platform"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."prompt_history_entries" ADD CONSTRAINT "prompt_history_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."prompt_history_entries" ADD CONSTRAINT "prompt_history_entries_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."provider_model_catalogs" ADD CONSTRAINT "provider_model_catalogs_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "platform"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."queued_thread_messages" ADD CONSTRAINT "queued_thread_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."retained_event_outputs" ADD CONSTRAINT "retained_event_outputs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "platform"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "platform"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "platform"."hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."terminal_sessions" ADD CONSTRAINT "terminal_sessions_daemon_session_id_host_daemon_sessions_id_fk" FOREIGN KEY ("daemon_session_id") REFERENCES "platform"."host_daemon_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_conversation_outlines" ADD CONSTRAINT "thread_conversation_outlines_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_dynamic_context_file_states" ADD CONSTRAINT "thread_dynamic_context_file_states_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_plugin_metadata" ADD CONSTRAINT "thread_plugin_metadata_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_pruning_cursors" ADD CONSTRAINT "thread_pruning_cursors_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_pruning_work" ADD CONSTRAINT "thread_pruning_work_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_search_segments" ADD CONSTRAINT "thread_search_segments_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."thread_tabs" ADD CONSTRAINT "thread_tabs_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "platform"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "platform"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "platform"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_section_id_thread_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "platform"."thread_sections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_parent_thread_id_threads_id_fk" FOREIGN KEY ("parent_thread_id") REFERENCES "platform"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_lifecycle_owner_thread_id_threads_id_fk" FOREIGN KEY ("lifecycle_owner_thread_id") REFERENCES "platform"."threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."threads" ADD CONSTRAINT "threads_source_thread_id_threads_id_fk" FOREIGN KEY ("source_thread_id") REFERENCES "platform"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apikey_key_unique" ON "platform"."apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "apikey_reference_id_idx" ON "platform"."apikey" USING btree ("referenceId");--> statement-breakpoint
CREATE INDEX "apikey_config_id_idx" ON "platform"."apikey" USING btree ("configId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_unique" ON "platform"."user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variables_global_name" ON "platform"."environment_variables" USING btree ("name") WHERE "platform"."environment_variables"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environment_variables_project_name" ON "platform"."environment_variables" USING btree ("project_id","name") WHERE "platform"."environment_variables"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_project_host_path_idx" ON "platform"."environments" USING btree ("project_id","host_id","path");--> statement-breakpoint
CREATE INDEX "environments_host_path_lookup_idx" ON "platform"."environments" USING btree ("host_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_owner_thread_idx" ON "platform"."environments" USING btree ("owner_thread_id") WHERE "platform"."environments"."owner_thread_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "environments_claim_idx" ON "platform"."environments" USING btree ("host_id","claim_path");--> statement-breakpoint
CREATE INDEX "environments_project_idx" ON "platform"."environments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "environments_status_idx" ON "platform"."environments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "environments_provider_instance_idx" ON "platform"."environments" USING btree ("environment_provider_id","environment_provider_instance_key");--> statement-breakpoint
CREATE INDEX "environments_provider_lifecycle_idx" ON "platform"."environments" USING btree ("environment_provider_id") WHERE "platform"."environments"."status" <> 'destroyed' OR "platform"."environments"."teardown_status" IS DISTINCT FROM 'removed';--> statement-breakpoint
CREATE UNIQUE INDEX "events_thread_sequence_idx" ON "platform"."events" USING btree ("thread_id","sequence");--> statement-breakpoint
CREATE INDEX "events_delegating_item_lookup_idx" ON "platform"."events" USING btree ("thread_id","item_id","sequence","item_kind") WHERE "platform"."events"."item_kind" IN ('toolCall', 'delegation');--> statement-breakpoint
CREATE INDEX "events_plan_steps_thread_sequence_idx" ON "platform"."events" USING btree ("thread_id","sequence") WHERE ("platform"."events"."item_kind" = 'planSteps' AND "platform"."events"."type" = 'item/completed') OR "platform"."events"."type" = 'turn/plan/updated';--> statement-breakpoint
CREATE INDEX "events_parent_tool_call_thread_parent_sequence_idx" ON "platform"."events" USING btree ("thread_id","parent_tool_call_id","sequence") WHERE "platform"."events"."parent_tool_call_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "events_thread_type_item_kind_sequence_idx" ON "platform"."events" USING btree ("thread_id","type","item_kind","sequence");--> statement-breakpoint
CREATE INDEX "events_background_task_thread_type_item_sequence_idx" ON "platform"."events" USING btree ("thread_id","type","item_id","sequence") WHERE "platform"."events"."item_kind" = 'backgroundTask';--> statement-breakpoint
CREATE INDEX "events_thread_type_sequence_idx" ON "platform"."events" USING btree ("thread_id","type","sequence");--> statement-breakpoint
CREATE INDEX "events_thread_turn_type_item_sequence_idx" ON "platform"."events" USING btree ("thread_id","turn_id","type","item_id","sequence");--> statement-breakpoint
CREATE INDEX "events_item_lifecycle_thread_item_sequence_idx" ON "platform"."events" USING btree ("thread_id","item_id","sequence") WHERE "platform"."events"."type" IN ('item/started', 'item/completed', 'item/backgroundTask/completed');--> statement-breakpoint
CREATE INDEX "events_environment_idx" ON "platform"."events" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "events_provider_identity_idx" ON "platform"."events" USING btree ("provider_thread_id","created_at") WHERE "platform"."events"."type" = 'thread/identity';--> statement-breakpoint
CREATE INDEX "events_completed_item_truncation_idx" ON "platform"."events" USING btree ("item_kind","created_at","id") WHERE "platform"."events"."type" = 'item/completed';--> statement-breakpoint
CREATE INDEX "events_thread_state_thread_sequence_idx" ON "platform"."events" USING btree ("thread_id","sequence") WHERE "platform"."events"."type" IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated');--> statement-breakpoint
CREATE INDEX "host_daemon_sessions_host_status_idx" ON "platform"."host_daemon_sessions" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "host_daemon_sessions_host_latest_idx" ON "platform"."host_daemon_sessions" USING btree ("host_id","updated_at","created_at","id");--> statement-breakpoint
CREATE INDEX "host_daemon_sessions_closed_prune_idx" ON "platform"."host_daemon_sessions" USING btree ("status","closed_at","id");--> statement-breakpoint
CREATE INDEX "hosts_last_seen_idx" ON "platform"."hosts" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "hosts_pending_provider_idx" ON "platform"."hosts" USING btree ("machine_provider_id") WHERE "platform"."hosts"."destroyed_at" IS NULL AND "platform"."hosts"."phase" <> 'destroyed';--> statement-breakpoint
CREATE UNIQUE INDEX "hosts_live_launch_key_idx" ON "platform"."hosts" USING btree ("launch_key") WHERE "platform"."hosts"."destroyed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_scan_cursors_path_idx" ON "platform"."maintenance_scan_cursors" USING btree ("policy","version","item_kind","output_path");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_interactions_provider_request_idx" ON "platform"."pending_interactions" USING btree ("provider_id","provider_thread_id","provider_request_id");--> statement-breakpoint
CREATE INDEX "pending_interactions_thread_created_idx" ON "platform"."pending_interactions" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "pending_interactions_thread_status_created_idx" ON "platform"."pending_interactions" USING btree ("thread_id","status","created_at");--> statement-breakpoint
CREATE INDEX "pending_interactions_status_created_idx" ON "platform"."pending_interactions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "pending_interactions_plugin_status_created_idx" ON "platform"."pending_interactions" USING btree ("plugin_id","status","created_at");--> statement-breakpoint
CREATE INDEX "plugin_artifacts_plugin_idx" ON "platform"."plugin_artifacts" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_state_snapshots_plugin_idx" ON "platform"."plugin_state_snapshots" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX "plugin_state_snapshots_retention_idx" ON "platform"."plugin_state_snapshots" USING btree ("retained_until");--> statement-breakpoint
CREATE INDEX "project_attachment_threads_thread_idx" ON "platform"."project_attachment_threads" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_attachments_project_path_idx" ON "platform"."project_attachments" USING btree ("project_id","stored_path");--> statement-breakpoint
CREATE INDEX "project_attachments_project_created_idx" ON "platform"."project_attachments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_attachments_deletion_idx" ON "platform"."project_attachments" USING btree ("project_id","deletion_claimed_at","id") WHERE "platform"."project_attachments"."deletion_claimed_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_execution_defaults_project_idx" ON "platform"."project_execution_defaults" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sources_project_idx" ON "platform"."project_sources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_sources_host_idx" ON "platform"."project_sources" USING btree ("host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_project_host_idx" ON "platform"."project_sources" USING btree ("project_id","host_id");--> statement-breakpoint
CREATE UNIQUE INDEX "project_sources_default_project_idx" ON "platform"."project_sources" USING btree ("project_id") WHERE "platform"."project_sources"."is_default" = 1;--> statement-breakpoint
CREATE INDEX "projects_updated_idx" ON "platform"."projects" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "projects_deleted_idx" ON "platform"."projects" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "projects_sort_idx" ON "platform"."projects" USING btree ("sort_key","id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_personal_singleton_idx" ON "platform"."projects" USING btree ("kind") WHERE "platform"."projects"."kind" = 'personal';--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_history_entries_thread_request_idx" ON "platform"."prompt_history_entries" USING btree ("thread_id","request_sequence");--> statement-breakpoint
CREATE INDEX "prompt_history_entries_project_scope_created_idx" ON "platform"."prompt_history_entries" USING btree ("project_id","scope","created_at","request_sequence","id");--> statement-breakpoint
CREATE INDEX "prompt_history_entries_created_idx" ON "platform"."prompt_history_entries" USING btree ("created_at","request_sequence","id");--> statement-breakpoint
CREATE INDEX "prompt_history_entries_thread_scope_created_idx" ON "platform"."prompt_history_entries" USING btree ("thread_id","scope","created_at","request_sequence","id");--> statement-breakpoint
CREATE INDEX "queued_thread_messages_thread_created_idx" ON "platform"."queued_thread_messages" USING btree ("thread_id","created_at","id");--> statement-breakpoint
CREATE INDEX "queued_thread_messages_thread_sort_idx" ON "platform"."queued_thread_messages" USING btree ("thread_id","sort_key","id");--> statement-breakpoint
CREATE INDEX "queued_thread_messages_due_idx" ON "platform"."queued_thread_messages" USING btree ("state","send_at","id");--> statement-breakpoint
CREATE INDEX "queued_thread_messages_retry_idx" ON "platform"."queued_thread_messages" USING btree ("state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "queued_thread_messages_wait_holder_idx" ON "platform"."queued_thread_messages" USING btree ("wait_holder","id") WHERE "platform"."queued_thread_messages"."wait_holder" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "retained_event_outputs_expiry_idx" ON "platform"."retained_event_outputs" USING btree ("expires_at","event_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_thread_status_updated_idx" ON "platform"."terminal_sessions" USING btree ("thread_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "terminal_sessions_environment_status_idx" ON "platform"."terminal_sessions" USING btree ("environment_id","status");--> statement-breakpoint
CREATE INDEX "terminal_sessions_status_thread_idx" ON "platform"."terminal_sessions" USING btree ("status","thread_id");--> statement-breakpoint
CREATE INDEX "terminal_sessions_host_status_idx" ON "platform"."terminal_sessions" USING btree ("host_id","status");--> statement-breakpoint
CREATE INDEX "terminal_sessions_daemon_session_idx" ON "platform"."terminal_sessions" USING btree ("daemon_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_dynamic_context_file_states_thread_file_idx" ON "platform"."thread_dynamic_context_file_states" USING btree ("thread_id","file_key");--> statement-breakpoint
CREATE INDEX "thread_pruning_cursors_thread_idx" ON "platform"."thread_pruning_cursors" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_pruning_work_thread_idx" ON "platform"."thread_pruning_work" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_search_segments_source_idx" ON "platform"."thread_search_segments" USING btree ("thread_id","source_kind","source_key");--> statement-breakpoint
CREATE INDEX "thread_search_segments_thread_source_seq_idx" ON "platform"."thread_search_segments" USING btree ("thread_id","source_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "thread_sections_name_idx" ON "platform"."thread_sections" USING btree ("name");--> statement-breakpoint
CREATE INDEX "threads_project_id_idx" ON "platform"."threads" USING btree ("project_id","id");--> statement-breakpoint
CREATE INDEX "threads_project_updated_idx" ON "platform"."threads" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "threads_project_archived_deleted_idx" ON "platform"."threads" USING btree ("project_id","archived_at","deleted_at","id");--> statement-breakpoint
CREATE INDEX "threads_pin_sort_idx" ON "platform"."threads" USING btree ("archived_at","deleted_at","pin_sort_key","id") WHERE "platform"."threads"."pinned_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_environment_idx" ON "platform"."threads" USING btree ("environment_id");--> statement-breakpoint
CREATE INDEX "threads_lifecycle_owner_idx" ON "platform"."threads" USING btree ("lifecycle_owner_thread_id");--> statement-breakpoint
CREATE INDEX "threads_parent_idx" ON "platform"."threads" USING btree ("parent_thread_id");--> statement-breakpoint
CREATE INDEX "threads_source_origin_idx" ON "platform"."threads" USING btree ("source_thread_id","origin_kind");--> statement-breakpoint
CREATE INDEX "threads_origin_plugin_archived_idx" ON "platform"."threads" USING btree ("origin_plugin_id","archived_at");--> statement-breakpoint
CREATE INDEX "threads_section_archived_deleted_idx" ON "platform"."threads" USING btree ("section_id","archived_at","deleted_at","id");--> statement-breakpoint
CREATE INDEX "threads_archived_status_idx" ON "platform"."threads" USING btree ("archived_at","status");--> statement-breakpoint
CREATE INDEX "threads_deleted_cleanup_idx" ON "platform"."threads" USING btree ("deleted_at") WHERE "platform"."threads"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "threads_environment_archived_deleted_idx" ON "platform"."threads" USING btree ("environment_id","archived_at","deleted_at");--> statement-breakpoint
CREATE INDEX "threads_active_maintenance_idx" ON "platform"."threads" USING btree ("status") WHERE "platform"."threads"."deleted_at" IS NULL;
--> statement-breakpoint
INSERT INTO "platform"."projects" ("id", "kind", "name", "sort_key", "created_at", "updated_at")
VALUES ('proj_personal', 'personal', 'Personal', 'V', (EXTRACT(EPOCH FROM now()) * 1000)::bigint, (EXTRACT(EPOCH FROM now()) * 1000)::bigint)
ON CONFLICT DO NOTHING;
