CREATE TABLE hyperfide.source_recovery_effects (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,backup_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('UPLOAD','DELETE','PUBLICATION')),effect_id text NOT NULL,
 snapshot jsonb NOT NULL,state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RESOLVED')),
 outcome jsonb,observed_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,backup_id,kind,effect_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,backup_id) REFERENCES hyperfide.source_backups,
 CHECK((state='RESOLVED')=(outcome IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE TRIGGER immutable_source_recovery_effect BEFORE UPDATE ON hyperfide.source_recovery_effects FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','backup_id','kind','effect_id','snapshot');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_recovery_effects FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER retain_source_recovery_effect BEFORE DELETE ON hyperfide.source_recovery_effects FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
ALTER TABLE hyperfide.source_backups ADD COLUMN effect_count bigint NOT NULL DEFAULT 0 CHECK(effect_count>=0),ADD COLUMN pending_effects bigint NOT NULL DEFAULT 0 CHECK(pending_effects>=0 AND pending_effects<=effect_count);
