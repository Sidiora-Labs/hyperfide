CREATE TABLE hyperfide.runner_not_started_proofs (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 runner_operation_id uuid NOT NULL,install_operation_id uuid NOT NULL,
 runner_plan_digest hyperfide.digest NOT NULL,admission_digest hyperfide.digest NOT NULL,
 expires_at timestamptz NOT NULL,proof_digest hyperfide.digest NOT NULL,
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND (proof->>'kind') IS NOT DISTINCT FROM 'NOT_STARTED'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,runner_operation_id),
 FOREIGN KEY(organisation_id,run_id,runner_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.runner_not_started_proofs FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','runner_operation_id','install_operation_id','runner_plan_digest','admission_digest','expires_at','proof_digest','proof','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.runner_not_started_proofs FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE FUNCTION hyperfide.guard_runner_not_started_proof() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE j hyperfide.runner_remote_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM hyperfide.runner_remote_jobs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.runner_operation_id FOR UPDATE;
 IF NOT FOUND OR j.state<>'ADMITTED' OR j.job_class<>'PREPARATION' OR j.claim_id IS NOT NULL OR j.executor_credential_id IS NOT NULL OR j.claimed_at IS NOT NULL OR j.completed_at IS NOT NULL OR j.result IS NOT NULL OR j.result_digest IS NOT NULL OR j.result_signature IS NOT NULL OR j.expires_at>clock_timestamp() OR j.expires_at<>NEW.expires_at OR j.plan_digest<>NEW.runner_plan_digest
 OR j.plan->'preparation_request'->'job_binding'->>'namespace' IS DISTINCT FROM 'FLEET_INSTALL' OR j.plan->'preparation_request'->'job_binding'->>'job_id' IS DISTINCT FROM NEW.install_operation_id::text OR j.plan->'preparation_request'->'job_binding'->>'input_packet_digest' IS DISTINCT FROM NEW.admission_digest
 OR NOT EXISTS(SELECT 1 FROM hyperfide.fleet_environment_installs e WHERE e.organisation_id=NEW.organisation_id AND e.run_id=NEW.run_id AND e.operation_id=NEW.install_operation_id AND e.admission_digest=NEW.admission_digest AND e.sandbox_id::text=j.plan->'binding'->>'sandbox_id' AND e.boot_id::text=j.plan->'binding'->>'boot_id' AND e.boot_generation::text=j.plan->'binding'->>'boot_generation')
 OR EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND id=NEW.runner_operation_id)
 THEN RAISE EXCEPTION 'NOT_STARTED requires exact expired unclaimed operation and no provider execution' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guarded_proof BEFORE INSERT ON hyperfide.runner_not_started_proofs FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_runner_not_started_proof();
ALTER TABLE hyperfide.runner_remote_jobs ADD COLUMN not_started_proof_id uuid;
ALTER TABLE hyperfide.runner_remote_jobs ADD FOREIGN KEY(organisation_id,run_id,not_started_proof_id) REFERENCES hyperfide.runner_not_started_proofs(organisation_id,run_id,id);
CREATE FUNCTION hyperfide.guard_not_started_runner_claim() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF NEW.not_started_proof_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hyperfide.runner_not_started_proofs p WHERE p.organisation_id=NEW.organisation_id AND p.run_id=NEW.run_id AND p.id=NEW.not_started_proof_id AND p.runner_operation_id=NEW.operation_id) THEN RAISE EXCEPTION 'NOT_STARTED fence must match its exact operation' USING ERRCODE='23514'; END IF;
 IF OLD.not_started_proof_id IS NOT NULL AND NEW.not_started_proof_id IS DISTINCT FROM OLD.not_started_proof_id THEN RAISE EXCEPTION 'NOT_STARTED fence is immutable' USING ERRCODE='23514'; END IF;
 IF (OLD.not_started_proof_id IS NOT NULL OR EXISTS(SELECT 1 FROM hyperfide.runner_not_started_proofs WHERE organisation_id=OLD.organisation_id AND run_id=OLD.run_id AND runner_operation_id=OLD.operation_id))
 AND (NEW.state<>OLD.state OR ROW(NEW.claim_id,NEW.executor_credential_id,NEW.claimed_at,NEW.result,NEW.result_digest,NEW.result_signature,NEW.completed_at) IS DISTINCT FROM ROW(OLD.claim_id,OLD.executor_credential_id,OLD.claimed_at,OLD.result,OLD.result_digest,OLD.result_signature,OLD.completed_at))
 THEN RAISE EXCEPTION 'NOT_STARTED proof permanently fences original runner operation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aaa_not_started_claim_fence BEFORE UPDATE ON hyperfide.runner_remote_jobs FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_not_started_runner_claim();
CREATE TABLE hyperfide.fleet_install_not_started_recoveries (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 predecessor_install_operation_id uuid NOT NULL,logical_operation_id uuid NOT NULL,proof_id uuid NOT NULL,decision_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organisation_id,run_id,operation_id),UNIQUE(organisation_id,run_id,predecessor_install_operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,predecessor_install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,logical_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,proof_id) REFERENCES hyperfide.runner_not_started_proofs(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,decision_id) REFERENCES hyperfide.fleet_decisions(organisation_id,run_id,id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_not_started_recoveries FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','predecessor_install_operation_id','logical_operation_id','proof_id','decision_id','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_not_started_recoveries FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
ALTER TABLE hyperfide.fleet_install_delivery_executions ADD COLUMN target_binding jsonb CHECK(target_binding IS NULL OR jsonb_typeof(target_binding)='object');
CREATE FUNCTION hyperfide.guard_install_execution_target() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE a hyperfide.resource_job_allocations%ROWTYPE; d hyperfide.fleet_install_deliveries%ROWTYPE; e hyperfide.fleet_environment_installs%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' AND OLD.target_binding IS NOT NULL AND NEW.target_binding IS DISTINCT FROM OLD.target_binding THEN RAISE EXCEPTION 'Execution target is write-once' USING ERRCODE='23514'; END IF;
 IF NEW.target_binding IS NOT NULL AND (TG_OP='INSERT' OR OLD.target_binding IS NULL) THEN
  IF (SELECT count(*) FROM jsonb_object_keys(NEW.target_binding))<>7 OR NOT NEW.target_binding ?& ARRAY['allocation_id','request_id','reservation_id','session_id','slot_id','boot_id','boot_generation'] THEN RAISE EXCEPTION 'Exact execution target required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(NEW.target_binding) x WHERE jsonb_typeof(x.value) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Execution target values must be non-null strings' USING ERRCODE='23514'; END IF;
  SELECT * INTO a FROM hyperfide.resource_job_allocations WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND id=(NEW.target_binding->>'allocation_id')::uuid FOR SHARE;
  SELECT * INTO d FROM hyperfide.fleet_install_deliveries WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND id=NEW.delivery_id FOR SHARE;
  SELECT * INTO e FROM hyperfide.fleet_environment_installs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.operation_id FOR SHARE;
  IF a.id IS NULL OR d.id IS NULL OR e.operation_id IS NULL OR a.state<>'ACTIVE' OR a.job_kind<>'PREPARATION' OR a.request_id::text IS DISTINCT FROM (NEW.target_binding->>'request_id') OR a.reservation_id::text IS DISTINCT FROM (NEW.target_binding->>'reservation_id') OR a.assignee_session_id::text IS DISTINCT FROM (NEW.target_binding->>'session_id') OR a.slot_id::text IS DISTINCT FROM (NEW.target_binding->>'slot_id') OR a.sandbox_boot_generation::text IS DISTINCT FROM (NEW.target_binding->>'boot_generation') OR e.boot_id::text IS DISTINCT FROM (NEW.target_binding->>'boot_id') OR a.sandbox_id<>e.sandbox_id OR a.sandbox_boot_generation<>e.boot_generation OR d.sandbox_id<>e.sandbox_id OR d.boot_id<>e.boot_id OR d.boot_generation<>e.boot_generation OR d.input_digest<>e.input_digest OR d.environment_id<>e.environment_id OR d.environment_generation<>e.environment_generation
 OR NOT EXISTS(SELECT 1 FROM hyperfide.fleet_install_heads h WHERE h.organisation_id=NEW.organisation_id AND h.run_id=NEW.run_id AND h.current_operation_id=NEW.operation_id AND h.logical_operation_id=NEW.logical_operation_id AND d.operation_id=h.logical_operation_id)
  THEN RAISE EXCEPTION 'Execution target must match actual current preparation allocation and environment' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_execution_target BEFORE INSERT OR UPDATE ON hyperfide.fleet_install_delivery_executions FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_install_execution_target();

CREATE FUNCTION hyperfide.attach_not_started_runner_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 UPDATE hyperfide.runner_remote_jobs SET not_started_proof_id=NEW.id WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.runner_operation_id AND not_started_proof_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original operation already fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attach_runner_fence AFTER INSERT ON hyperfide.runner_not_started_proofs FOR EACH ROW EXECUTE FUNCTION hyperfide.attach_not_started_runner_fence();
