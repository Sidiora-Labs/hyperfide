CREATE TABLE hyperfide.source_authority_domains (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 authority_epoch bigint NOT NULL CHECK(authority_epoch>0),policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 256),
 enabled boolean NOT NULL DEFAULT true,PRIMARY KEY(organisation_id,repository_id,security_domain_id)
);
CREATE TABLE hyperfide.source_principal_credentials (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,credential_id uuid NOT NULL,
 principal_id uuid NOT NULL,principal_kind text NOT NULL CHECK(principal_kind IN('human','automation','import','worker','service')),
 credential_version bigint NOT NULL CHECK(credential_version>0),issuer text NOT NULL,audience text NOT NULL,signing_key_id text NOT NULL,
 expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,credential_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_authority_domains
);
CREATE TABLE hyperfide.source_capabilities (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,id uuid NOT NULL,
 principal_id uuid NOT NULL,credential_id uuid NOT NULL,principal_kind text NOT NULL CHECK(principal_kind IN('human','automation','import','worker','service')),
 authority_epoch bigint NOT NULL CHECK(authority_epoch>0),policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 256),
 actions text[] NOT NULL CHECK(cardinality(actions) BETWEEN 1 AND 64),path_prefixes text[] NOT NULL CHECK(cardinality(path_prefixes) BETWEEN 1 AND 256),
 revision_ids text[],managed_binding jsonb,expires_at timestamptz NOT NULL,revoked_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_authority_domains,
 CHECK(managed_binding IS NULL OR jsonb_typeof(managed_binding)='object')
);
CREATE INDEX source_capabilities_principal ON hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,principal_id,credential_id) WHERE revoked_at IS NULL;
CREATE TABLE hyperfide.source_transfer_grants (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,id uuid NOT NULL,
 principal_id uuid NOT NULL,capability_id uuid NOT NULL,object_id text NOT NULL,incarnation_id uuid NOT NULL,
 method text NOT NULL CHECK(method IN('GET','PUT')),upload_id uuid,grant_digest text NOT NULL CHECK(grant_digest ~ '^sha256:[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,capability_id) REFERENCES hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) REFERENCES hyperfide.source_object_placements,
 CHECK((method='GET' AND upload_id IS NULL) OR (method='PUT' AND upload_id IS NOT NULL))
);
CREATE TABLE hyperfide.source_audit (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,id uuid NOT NULL,
 principal_id uuid NOT NULL,operation_id uuid NOT NULL,record jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,id),
 CHECK(jsonb_typeof(record)='object' AND octet_length(record::text)<=16384)
);
CREATE FUNCTION hyperfide.source_security_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN RAISE EXCEPTION 'Source grant and audit records are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER source_transfer_grants_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_transfer_grants FOR EACH ROW EXECUTE FUNCTION hyperfide.source_security_immutable();
CREATE TRIGGER source_audit_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_audit FOR EACH ROW EXECUTE FUNCTION hyperfide.source_security_immutable();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['source_authority_domains','source_principal_credentials','source_capabilities','source_transfer_grants','source_audit'] LOOP
  EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',name);
 END LOOP;
END $$;
