CREATE TABLE hyperfide.source_epoch_adoptions (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 from_epoch bigint NOT NULL CHECK(from_epoch>0),to_epoch bigint NOT NULL CHECK(to_epoch=from_epoch+1),
 migration_id uuid NOT NULL,policy_version text NOT NULL,policy_map jsonb NOT NULL,domain_map jsonb NOT NULL,skipped_domains jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,to_epoch)
);
CREATE TRIGGER source_epoch_adoption_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_epoch_adoptions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_epoch_adoptions FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
