-- Typed no-Git source bytes retained independently of the coding VM.
CREATE TABLE hyperfide.fleet_source_archive_custodies (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 custody_id uuid NOT NULL,custody_generation bigint NOT NULL CHECK(custody_generation>0),
 task_id uuid NOT NULL,attempt_id uuid NOT NULL,attempt_generation bigint NOT NULL CHECK(attempt_generation>0),
 sandbox_id uuid NOT NULL,boot_id uuid NOT NULL,boot_generation bigint NOT NULL CHECK(boot_generation>0),
 slot_id uuid NOT NULL,slot_generation bigint NOT NULL CHECK(slot_generation>0),session_id uuid NOT NULL,workspace_id uuid NOT NULL,
 launch_id uuid NOT NULL,command_id uuid NOT NULL,producer_operation_id uuid NOT NULL,
 archive_artifact_id uuid NOT NULL,capture_receipt_artifact_id uuid NOT NULL,
 archive_artifact_digest hyperfide.digest NOT NULL,capture_receipt_artifact_digest hyperfide.digest NOT NULL,
 archive_digest hyperfide.digest NOT NULL,archive_size_bytes bigint NOT NULL CHECK(archive_size_bytes>0),
 inventory_digest hyperfide.digest NOT NULL,baseline_source_revision text NOT NULL,source_manifest_digest hyperfide.digest NOT NULL,
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),capture_receipt jsonb NOT NULL CHECK(jsonb_typeof(capture_receipt)='object'),
 registration_operation_id uuid NOT NULL,registration_payload_digest hyperfide.digest NOT NULL,
 captured_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,registration_operation_id),
 UNIQUE(organisation_id,run_id,custody_id,archive_digest),
 FOREIGN KEY(organisation_id,run_id,custody_id,custody_generation) REFERENCES hyperfide.submission_custodies(organisation_id,run_id,id,custody_generation),
 FOREIGN KEY(organisation_id,run_id,task_id,attempt_id,attempt_generation) REFERENCES hyperfide.attempts(organisation_id,run_id,task_id,id,generation),
 FOREIGN KEY(organisation_id,sandbox_id,boot_generation) REFERENCES hyperfide.sandbox_boots(organisation_id,sandbox_id,boot_generation),
 FOREIGN KEY(organisation_id,run_id,archive_artifact_id) REFERENCES hyperfide.artifacts(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,capture_receipt_artifact_id) REFERENCES hyperfide.artifacts(organisation_id,run_id,id)
);
CREATE TABLE hyperfide.fleet_source_archive_artifacts (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,archive_id uuid NOT NULL,artifact_id uuid NOT NULL,
 artifact_digest hyperfide.digest NOT NULL,role text NOT NULL CHECK(length(role) BETWEEN 1 AND 64),
 PRIMARY KEY(organisation_id,run_id,archive_id,artifact_id),
 FOREIGN KEY(organisation_id,run_id,archive_id) REFERENCES hyperfide.fleet_source_archive_custodies(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,artifact_id) REFERENCES hyperfide.artifacts(organisation_id,run_id,id)
);
CREATE INDEX fleet_source_archive_boot ON hyperfide.fleet_source_archive_custodies(organisation_id,run_id,sandbox_id,boot_generation,attempt_id);
CREATE INDEX fleet_source_archive_reference ON hyperfide.fleet_source_archive_artifacts(organisation_id,run_id,artifact_id);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_source_archive_custodies FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_source_archive_artifacts FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hyperfide.fleet_source_archive_custodies FOR EACH ROW EXECUTE FUNCTION hyperfide.assurance_immutable();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON hyperfide.fleet_source_archive_artifacts FOR EACH ROW EXECUTE FUNCTION hyperfide.assurance_immutable();
CREATE TABLE hyperfide.fleet_source_archive_deliveries (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,id uuid NOT NULL,
 operation_id uuid NOT NULL,actor_id uuid NOT NULL,request_digest hyperfide.digest NOT NULL,
 custody_id uuid NOT NULL,archive_id uuid NOT NULL,
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 capture_request jsonb NOT NULL CHECK(jsonb_typeof(capture_request)='object'),
 capture_request_digest hyperfide.digest NOT NULL,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 create_operation jsonb NOT NULL CHECK(jsonb_typeof(create_operation)='object'),
 binding jsonb NOT NULL CHECK(jsonb_typeof(binding)='object'),
 deadline_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('PINNED','SUBMITTING','COMPLETED','UNKNOWN')),
 capture_receipt jsonb,artifact_references jsonb,last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,id),UNIQUE(organisation_id,run_id,operation_id),
 UNIQUE(organisation_id,run_id,archive_id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id)
);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_source_archive_deliveries FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_source_archive_deliveries FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','run_id','id','operation_id','actor_id','request_digest','custody_id','archive_id','request','capture_request','capture_request_digest','policy','create_operation','binding','deadline_at','created_at');
