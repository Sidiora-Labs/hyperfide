CREATE TABLE hyperfide.source_transfers (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 transfer_id uuid NOT NULL, principal_id uuid NOT NULL, capability_id uuid NOT NULL, credential_id uuid NOT NULL,
 credential_snapshot jsonb NOT NULL, request_digest text NOT NULL, direction text NOT NULL CHECK(direction IN ('UPLOAD','DOWNLOAD')),
 object_id text NOT NULL, kind text NOT NULL, size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 8388608),
 paths jsonb NOT NULL, revision_id text, expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN ('PREPARING','ACTIVE','FINALIZING','COMPLETED','CANCELLED','FAILED')),
 upload_id uuid, grant_id uuid, grant_value jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,transfer_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,capability_id) REFERENCES hyperfide.source_capabilities,
 CHECK(jsonb_typeof(paths)='array' AND jsonb_typeof(credential_snapshot)='object')
);
CREATE UNIQUE INDEX source_transfers_grant ON hyperfide.source_transfers(grant_id) WHERE grant_id IS NOT NULL;
CREATE TABLE hyperfide.source_transfer_parts (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,transfer_id uuid NOT NULL,
 part_index integer NOT NULL CHECK(part_index BETWEEN 0 AND 7), offset_bytes bigint NOT NULL, size_bytes bigint NOT NULL,
 digest text NOT NULL, object_id text, state text NOT NULL CHECK(state IN ('PENDING','COMPLETE')),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,transfer_id,part_index),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,transfer_id) REFERENCES hyperfide.source_transfers,
 CHECK(offset_bytes>=0 AND size_bytes BETWEEN 1 AND 1048576)
);
CREATE TRIGGER immutable_source_transfer_identity BEFORE UPDATE ON hyperfide.source_transfers FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','transfer_id','principal_id','capability_id','credential_id','credential_snapshot','request_digest','direction','object_id','kind','size_bytes','paths','revision_id','expires_at');
CREATE TRIGGER immutable_source_transfer_part BEFORE UPDATE ON hyperfide.source_transfer_parts FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','transfer_id','part_index','offset_bytes','size_bytes','digest');
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_transfers FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_transfer_parts FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
