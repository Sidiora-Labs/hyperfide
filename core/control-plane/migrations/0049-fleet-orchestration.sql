CREATE TABLE hyperfide.fleet_cohorts (
 organisation_id uuid NOT NULL, run_id uuid NOT NULL, id uuid NOT NULL,
 host_id text NOT NULL, authority_epoch uuid NOT NULL, leader_session_id uuid NOT NULL,
 leader_generation bigint NOT NULL CHECK(leader_generation>0), cohort_generation bigint NOT NULL CHECK(cohort_generation>0),
 controller_identity jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id), UNIQUE(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,leader_session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_actor_sessions (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,session_id uuid NOT NULL,cohort_id uuid NOT NULL,
 cohort_generation bigint NOT NULL,actor_role text NOT NULL CHECK(actor_role IN ('PRIMARY','WAVE_MANAGER')),
 delegation_id uuid,manager_generation bigint,native_session_id text,process_identity jsonb,
 state text NOT NULL CHECK(state IN ('REGISTERED','REASONING','WAITING_FOR_MANAGER','READY','UNKNOWN')),
 plan_generation bigint NOT NULL DEFAULT 0 CHECK(plan_generation>=0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,session_id),
 FOREIGN KEY(organisation_id,run_id,session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,cohort_id) REFERENCES hyperfide.fleet_cohorts(organisation_id,run_id,id),
 CHECK((actor_role='WAVE_MANAGER')=(delegation_id IS NOT NULL AND manager_generation IS NOT NULL))
);
CREATE TABLE hyperfide.fleet_delegations (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,package_id uuid NOT NULL,manager_session_id uuid NOT NULL,
 manager_generation bigint NOT NULL CHECK(manager_generation>0),leader_generation bigint NOT NULL CHECK(leader_generation>0),
 budget jsonb NOT NULL CHECK(jsonb_typeof(budget)='object'),decision_id uuid NOT NULL,
 PRIMARY KEY(organisation_id,run_id,package_id),
 FOREIGN KEY(organisation_id,run_id,package_id) REFERENCES hyperfide.hierarchy_packages(organisation_id,run_id,package_id),
 FOREIGN KEY(organisation_id,run_id,manager_session_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_observations (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,
 cohort_generation bigint NOT NULL,context_digest hyperfide.digest NOT NULL,body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,actor_id,context_digest),
 FOREIGN KEY(organisation_id,run_id,actor_id) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_reasoning (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,actor_id uuid NOT NULL,
 request_digest hyperfide.digest NOT NULL,observation_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('PREPARED','RUNNING','WAITING_FOR_MANAGER','COMPLETED','UNKNOWN')),
 process_identity jsonb,native_session_id text,result jsonb,reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,observation_id) REFERENCES hyperfide.fleet_observations(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_decisions (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,operation_id uuid NOT NULL,actor_id uuid NOT NULL,
 action text NOT NULL,context_digest hyperfide.digest NOT NULL,payload_digest hyperfide.digest NOT NULL,
 reasoning_id uuid NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,reasoning_id) REFERENCES hyperfide.fleet_reasoning(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_effect_receipts (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,decision_id uuid NOT NULL,
 payload_digest hyperfide.digest NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,decision_id) REFERENCES hyperfide.fleet_decisions(organisation_id,run_id,id)
);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_observations FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','actor_id','cohort_generation','context_digest','body','created_at');
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_decisions FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','operation_id','actor_id','action','context_digest','payload_digest','reasoning_id','body','created_at');
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_effect_receipts FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','operation_id','decision_id','payload_digest','result','created_at');
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['fleet_cohorts','fleet_actor_sessions','fleet_delegations','fleet_observations','fleet_reasoning','fleet_decisions','fleet_effect_receipts'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',t); END LOOP; END $$;
