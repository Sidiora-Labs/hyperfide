-- Launch references have a producer (hyperfide-v21 3.15, D17).
--
-- A native launch plan stores the secret references its admission selection
-- declared: the task's env_refs (NAME -> secret-ref:ID) that the sandbox pool's
-- environment profile allows (agents/env_refs.ts). The 12.2 START route issues
-- them from the plan; values never reach this table. Plans created before this
-- migration declared nothing, so the column defaults to the empty map.
CREATE FUNCTION hyperfide.launch_env_refs_valid(refs jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT
SET search_path=pg_catalog AS $$
 SELECT jsonb_typeof(refs)='object'
  AND (SELECT count(*) FROM jsonb_object_keys(refs))<=128
  AND NOT EXISTS (SELECT 1 FROM jsonb_each(refs) e
   WHERE e.key !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
    OR e.key IN ('PATH','HOME','TMPDIR','CODEX_HOME','CLAUDE_CONFIG_DIR','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS')
    OR e.key ~ '^(HF_|LD_|DYLD_)'
    OR jsonb_typeof(e.value)<>'string'
    OR (e.value #>> '{}') !~ '^secret-ref:[A-Za-z0-9][A-Za-z0-9._:/-]{0,239}$')
$$;

ALTER TABLE hyperfide.native_launch_plans ADD COLUMN env_refs jsonb NOT NULL DEFAULT '{}'::jsonb
 CONSTRAINT native_launch_plans_env_refs CHECK(hyperfide.launch_env_refs_valid(env_refs));

DROP TRIGGER immutable_binding ON hyperfide.native_launch_plans;
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.native_launch_plans
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','command_id','launch_id','agent_session_id','slot_id','attempt_id','attempt_generation','connector','connector_plan_digest','admission_reservation_id','reservation_attempt','admission_policy_digest','run_policy_digest','qualification_receipt_digest','packet_digest','payload_digest','plan','created_at','env_refs');
