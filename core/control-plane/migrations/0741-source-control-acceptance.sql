CREATE TABLE hyperfide.source_integration_domains (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,domain_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),revision_id text NOT NULL,root_tree_id text NOT NULL,
 authority_epoch bigint NOT NULL CHECK(authority_epoch>0),policy_id uuid NOT NULL,policy_digest text NOT NULL CHECK(policy_digest ~ '^sha256:[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,domain_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_native_candidates (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,candidate_id uuid NOT NULL,domain_id uuid NOT NULL,
 revision_id text NOT NULL,root_tree_id text NOT NULL,manifest_digest text NOT NULL CHECK(manifest_digest ~ '^sha256:[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,candidate_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,domain_id) REFERENCES hyperfide.source_integration_domains,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE INDEX source_native_candidate_domain_queue ON hyperfide.source_native_candidates(organisation_id,repository_id,security_domain_id,domain_id,created_at,candidate_id);
CREATE TABLE hyperfide.source_candidate_qualifications (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,qualification_id text NOT NULL CHECK(qualification_id ~ '^sha256:[a-f0-9]{64}$'),
 candidate_id uuid NOT NULL,manifest_digest text NOT NULL CHECK(manifest_digest ~ '^sha256:[a-f0-9]{64}$'),result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(organisation_id,repository_id,security_domain_id,qualification_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,candidate_id) REFERENCES hyperfide.source_native_candidates
);
CREATE TABLE hyperfide.source_native_acceptances (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,acceptance_id text NOT NULL CHECK(acceptance_id ~ '^sha256:[a-f0-9]{64}$'),
 domain_id uuid NOT NULL,generation bigint NOT NULL CHECK(generation>0),candidate_id uuid NOT NULL,qualification_id text NOT NULL,
 revision_id text NOT NULL,root_tree_id text NOT NULL,receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,acceptance_id),UNIQUE(organisation_id,repository_id,security_domain_id,domain_id,generation),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,domain_id) REFERENCES hyperfide.source_integration_domains,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,candidate_id) REFERENCES hyperfide.source_native_candidates,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,qualification_id) REFERENCES hyperfide.source_candidate_qualifications,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE INDEX source_native_acceptance_revision_lookup ON hyperfide.source_native_acceptances(organisation_id,repository_id,security_domain_id,revision_id,created_at DESC,acceptance_id);
CREATE FUNCTION hyperfide.source_integration_domain_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.generation<>OLD.generation+1 OR ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.domain_id,NEW.authority_epoch,NEW.created_at) IS DISTINCT FROM ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.domain_id,OLD.authority_epoch,OLD.created_at)
 THEN RAISE EXCEPTION 'invalid native integration domain transition' USING ERRCODE='23514'; END IF;RETURN NEW;
END $$;
CREATE TRIGGER source_integration_domain_transition BEFORE UPDATE ON hyperfide.source_integration_domains FOR EACH ROW EXECUTE FUNCTION hyperfide.source_integration_domain_transition();
CREATE TRIGGER source_integration_domains_delete_guard BEFORE DELETE ON hyperfide.source_integration_domains FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['source_native_candidates','source_candidate_qualifications','source_native_acceptances'] LOOP
 EXECUTE format('CREATE TRIGGER native_acceptance_immutable BEFORE UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable()',table_name);
 END LOOP;
 FOREACH table_name IN ARRAY ARRAY['source_integration_domains','source_native_candidates','source_candidate_qualifications','source_native_acceptances'] LOOP
 EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',table_name);
 END LOOP;
END $$;
