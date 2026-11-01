CREATE TABLE hyperfide.runner_pre_provider_refusals (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 runner_operation_id uuid NOT NULL,claim_id uuid NOT NULL,executor_credential_id uuid NOT NULL,
 runner_plan_digest hyperfide.digest NOT NULL,request_digest hyperfide.digest NOT NULL,
 error_code text NOT NULL CHECK(error_code='PROVIDER_DEADLINE_INVALID'),proof_digest hyperfide.digest NOT NULL,
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND proof->>'kind'='PRE_PROVIDER_REFUSAL'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,runner_operation_id),
 FOREIGN KEY(organisation_id,run_id,runner_operation_id) REFERENCES hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.runner_pre_provider_refusals FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','runner_operation_id','claim_id','executor_credential_id','runner_plan_digest','request_digest','error_code','proof_digest','proof','created_at');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.runner_pre_provider_refusals FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
ALTER TABLE hyperfide.runner_remote_jobs ADD COLUMN native_claim_coverage boolean NOT NULL DEFAULT false,ADD COLUMN native_claimed_at timestamptz,ADD COLUMN native_claim_operation_id uuid,ADD COLUMN pre_provider_refusal_id uuid,ADD COLUMN failure_code text CHECK(failure_code IS NULL OR length(failure_code)<=128);
ALTER TABLE hyperfide.runner_remote_jobs ADD CHECK((native_claimed_at IS NULL)=(native_claim_operation_id IS NULL));
ALTER TABLE hyperfide.runner_remote_jobs ADD FOREIGN KEY(organisation_id,run_id,pre_provider_refusal_id) REFERENCES hyperfide.runner_pre_provider_refusals(organisation_id,run_id,id);
CREATE FUNCTION hyperfide.guard_pre_provider_refusal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE j hyperfide.runner_remote_jobs%ROWTYPE;
BEGIN
 SELECT * INTO j FROM hyperfide.runner_remote_jobs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.runner_operation_id FOR UPDATE;
 IF NOT FOUND OR j.native_claim_coverage IS NOT TRUE OR j.native_claimed_at IS NOT NULL OR j.native_claim_operation_id IS NOT NULL OR j.state NOT IN('CLAIMED','UNKNOWN') OR j.claim_id IS DISTINCT FROM NEW.claim_id OR j.executor_credential_id IS DISTINCT FROM NEW.executor_credential_id OR j.claimed_at IS NULL OR j.result IS NOT NULL OR j.result_digest IS NOT NULL OR j.result_signature IS NOT NULL OR j.completed_at IS NOT NULL OR j.not_started_proof_id IS NOT NULL OR j.pre_provider_refusal_id IS NOT NULL OR j.plan_digest<>NEW.runner_plan_digest
 OR NEW.proof->>'runner_operation_id' IS DISTINCT FROM j.operation_id::text OR NEW.proof->>'claim_id' IS DISTINCT FROM j.claim_id::text OR NEW.proof->>'runner_plan_digest' IS DISTINCT FROM j.plan_digest::text OR NEW.proof->>'request_digest' IS DISTINCT FROM NEW.request_digest::text
 OR NEW.proof->'bound_request'->>'operation_id' IS DISTINCT FROM j.operation_id::text
 OR NEW.proof->'condition'->>'code' IS DISTINCT FROM NEW.error_code
 OR COALESCE((NEW.proof->'bound_request'->>'timeout_ms')::bigint,0)<>LEAST(3600000,(j.plan->'request'->>'timeout_ms')::bigint+60000)
 OR COALESCE((NEW.proof->'condition'->>'maximum_operation_ms')::bigint,0)<100
 OR COALESCE((NEW.proof->'bound_request'->>'timeout_ms')::bigint,0)<=COALESCE((NEW.proof->'condition'->>'maximum_operation_ms')::bigint,0)
 OR EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations WHERE organisation_id=NEW.organisation_id AND id=NEW.runner_operation_id)
 THEN RAISE EXCEPTION 'PRE_PROVIDER_REFUSAL requires exact claimed operation, actual refusal and no provider admission' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guarded_proof BEFORE INSERT ON hyperfide.runner_pre_provider_refusals FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_pre_provider_refusal();
CREATE FUNCTION hyperfide.attach_pre_provider_refusal() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 UPDATE hyperfide.runner_remote_jobs SET pre_provider_refusal_id=NEW.id,failure_code=NEW.error_code WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.runner_operation_id AND pre_provider_refusal_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Original operation already fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER attach_runner_fence AFTER INSERT ON hyperfide.runner_pre_provider_refusals FOR EACH ROW EXECUTE FUNCTION hyperfide.attach_pre_provider_refusal();
CREATE FUNCTION hyperfide.guard_pre_provider_runner_fence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF NEW.native_claim_coverage IS DISTINCT FROM OLD.native_claim_coverage OR (OLD.native_claimed_at IS NOT NULL AND ROW(NEW.native_claimed_at,NEW.native_claim_operation_id) IS DISTINCT FROM ROW(OLD.native_claimed_at,OLD.native_claim_operation_id)) THEN RAISE EXCEPTION 'Native claim coverage and prior claim marker are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.pre_provider_refusal_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM hyperfide.runner_pre_provider_refusals p WHERE p.organisation_id=NEW.organisation_id AND p.run_id=NEW.run_id AND p.id=NEW.pre_provider_refusal_id AND p.runner_operation_id=NEW.operation_id AND p.claim_id=NEW.claim_id AND p.executor_credential_id=NEW.executor_credential_id) THEN RAISE EXCEPTION 'Pre-provider fence differs from exact claim' USING ERRCODE='23514'; END IF;
 IF NEW.pre_provider_refusal_id IS NOT NULL AND NEW.failure_code IS DISTINCT FROM (SELECT error_code FROM hyperfide.runner_pre_provider_refusals WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND id=NEW.pre_provider_refusal_id) THEN RAISE EXCEPTION 'Typed pre-provider refusal reason is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.pre_provider_refusal_id IS NOT NULL AND (NEW.pre_provider_refusal_id IS DISTINCT FROM OLD.pre_provider_refusal_id OR NEW.state NOT IN(OLD.state,'UNKNOWN') OR ROW(NEW.claim_id,NEW.executor_credential_id,NEW.claimed_at,NEW.result,NEW.result_digest,NEW.result_signature,NEW.completed_at,NEW.plan,NEW.plan_digest,NEW.admission_digest,NEW.authority_epoch,NEW.reservation_id,NEW.session_id,NEW.expires_at,NEW.native_claimed_at,NEW.native_claim_operation_id) IS DISTINCT FROM ROW(OLD.claim_id,OLD.executor_credential_id,OLD.claimed_at,OLD.result,OLD.result_digest,OLD.result_signature,OLD.completed_at,OLD.plan,OLD.plan_digest,OLD.admission_digest,OLD.authority_epoch,OLD.reservation_id,OLD.session_id,OLD.expires_at,OLD.native_claimed_at,OLD.native_claim_operation_id)) THEN RAISE EXCEPTION 'Pre-provider refusal permanently fences original claim' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aaa_pre_provider_claim_fence BEFORE UPDATE ON hyperfide.runner_remote_jobs FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_pre_provider_runner_fence();
CREATE FUNCTION hyperfide.guard_provider_refused_dispatch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 PERFORM 1 FROM hyperfide.runner_remote_jobs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM hyperfide.runner_pre_provider_refusals WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND runner_operation_id=NEW.id) THEN RAISE EXCEPTION 'Provider dispatch is permanently fenced by pre-provider refusal' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aaa_pre_provider_dispatch_fence BEFORE INSERT ON hyperfide.provider_remote_operations FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_provider_refused_dispatch();
CREATE TABLE hyperfide.fleet_install_pre_provider_recoveries (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,
 predecessor_install_operation_id uuid NOT NULL,logical_operation_id uuid NOT NULL,proof_id uuid NOT NULL,decision_id uuid NOT NULL,
 PRIMARY KEY(organisation_id,run_id,operation_id),UNIQUE(organisation_id,run_id,predecessor_install_operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,predecessor_install_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,logical_operation_id) REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,proof_id) REFERENCES hyperfide.runner_pre_provider_refusals(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,decision_id) REFERENCES hyperfide.fleet_decisions(organisation_id,run_id,id),CHECK(operation_id<>predecessor_install_operation_id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_pre_provider_recoveries FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','predecessor_install_operation_id','logical_operation_id','proof_id','decision_id');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_install_pre_provider_recoveries FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
