CREATE TABLE hyperfide.source_backups (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,backup_id uuid NOT NULL,
 profile jsonb NOT NULL,profile_digest text NOT NULL,source_epoch bigint NOT NULL,
 manifest jsonb NOT NULL,manifest_digest text NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('CAPTURED','VERIFYING','READY','ACTIVATED','FAILED')),
 object_count bigint NOT NULL DEFAULT 0 CHECK(object_count>=0),pending_objects bigint NOT NULL DEFAULT 0 CHECK(pending_objects>=0 AND pending_objects<=object_count),object_bytes bigint NOT NULL DEFAULT 0 CHECK(object_bytes>=0),
 failure_code text,verified_at timestamptz,verification_operation_id uuid,verification_requested_at timestamptz,recovery_result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,backup_id)
);
CREATE TABLE hyperfide.source_backup_objects (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,backup_id uuid NOT NULL,
 object_id text NOT NULL,incarnation_id uuid NOT NULL,storage_key text NOT NULL,size_bytes bigint NOT NULL,
 verified boolean NOT NULL DEFAULT false,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,backup_id,object_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,backup_id) REFERENCES hyperfide.source_backups
);
CREATE TABLE hyperfide.source_recovery_state (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 operation_id uuid NOT NULL,deployment_id uuid NOT NULL,external_epoch uuid NOT NULL,state text NOT NULL CHECK(state IN ('VERIFYING','READY')),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id)
);
CREATE TABLE hyperfide.source_partition_routes (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,partition smallint NOT NULL CHECK(partition BETWEEN 0 AND 15),
 generation bigint NOT NULL CHECK(generation>0),owner_id text NOT NULL,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,partition)
);
CREATE TABLE hyperfide.source_partition_moves (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,operation_id uuid NOT NULL,
 partition smallint NOT NULL,request_digest text NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,operation_id)
);
CREATE TRIGGER immutable_source_backup_identity BEFORE UPDATE ON hyperfide.source_backups FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','backup_id','profile','profile_digest','source_epoch','manifest','manifest_digest','expires_at','created_at');
CREATE TRIGGER immutable_source_backup_object_identity BEFORE UPDATE ON hyperfide.source_backup_objects FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','backup_id','object_id','incarnation_id','storage_key','size_bytes');
CREATE TRIGGER immutable_source_partition_move BEFORE UPDATE OR DELETE ON hyperfide.source_partition_moves FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
DO $$ DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['source_backups','source_backup_objects','source_recovery_state','source_partition_routes','source_partition_moves'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',name);END LOOP;END $$;
