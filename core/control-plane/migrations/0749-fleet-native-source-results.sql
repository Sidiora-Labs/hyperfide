CREATE TABLE hyperfide.fleet_native_source_results (
 organisation_id uuid NOT NULL,run_id uuid NOT NULL,operation_id uuid NOT NULL,decision_id uuid NOT NULL,actor_id uuid NOT NULL,
 source_scope jsonb NOT NULL CHECK(jsonb_typeof(source_scope)='object'),source_action text NOT NULL CHECK(source_action LIKE 'source.%'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object' AND result->>'state' IN ('COMMITTED','REFUSED')),
 result_digest text NOT NULL CHECK(result_digest ~ '^sha256:[0-9a-f]{64}$'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,operation_id) REFERENCES hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id),
 FOREIGN KEY(organisation_id,run_id,decision_id) REFERENCES hyperfide.fleet_decisions(organisation_id,run_id,id)
);
CREATE INDEX fleet_native_source_results_actor ON hyperfide.fleet_native_source_results(organisation_id,run_id,actor_id,created_at DESC,operation_id DESC);
CREATE TRIGGER immutable_binding BEFORE UPDATE OR DELETE ON hyperfide.fleet_native_source_results FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.fleet_native_source_results FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
