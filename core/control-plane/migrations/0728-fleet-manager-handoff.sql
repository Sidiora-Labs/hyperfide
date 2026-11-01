ALTER TABLE hyperfide.fleet_bootstrap_credentials ADD COLUMN handoff_id uuid;
ALTER TABLE hyperfide.fleet_bootstrap_credentials ADD CONSTRAINT fleet_bootstrap_handoff_fk
 FOREIGN KEY(organisation_id,run_id,handoff_id) REFERENCES hyperfide.hierarchy_handoffs(organisation_id,run_id,id);
ALTER TABLE hyperfide.fleet_bootstrap_credentials ADD CONSTRAINT fleet_bootstrap_handoff_scope
 CHECK(handoff_id IS NULL OR (delegation_id IS NOT NULL AND manager_generation IS NOT NULL AND replacement_from_generation IS NULL AND leader_generation>0 AND cohort_generation>0));
CREATE TRIGGER immutable_handoff BEFORE UPDATE OR DELETE ON hyperfide.fleet_bootstrap_credentials
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('handoff_id');
