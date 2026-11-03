CREATE TABLE hyperfide.source_projection_policies (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 policy_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),policy_digest text NOT NULL,policy jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,policy_id,version)
);
CREATE TABLE hyperfide.source_git_imports (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 import_id uuid NOT NULL,principal_id uuid NOT NULL,authority_epoch bigint NOT NULL,request_digest text NOT NULL,request jsonb NOT NULL,
 source_id text NOT NULL,repository_identity text NOT NULL,tip_oid text NOT NULL,base_revision_id text NOT NULL,
 policy_id uuid NOT NULL,policy_version integer NOT NULL,policy_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('IMPORTING','COMPLETE','BLOCKED')),generation bigint NOT NULL DEFAULT 1,
 pending jsonb NOT NULL,revision_id text,diagnostic jsonb,metrics jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,import_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,base_revision_id) REFERENCES hyperfide.source_revisions,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,policy_id,policy_version) REFERENCES hyperfide.source_projection_policies
);
CREATE TABLE hyperfide.source_git_import_objects (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 import_id uuid NOT NULL,git_oid text NOT NULL,git_kind text NOT NULL,archive_object_id text NOT NULL,native_object_id text,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,import_id,git_oid),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,import_id) REFERENCES hyperfide.source_git_imports
);
CREATE TABLE hyperfide.source_git_import_commits (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 import_id uuid NOT NULL,git_oid text NOT NULL,revision_id text NOT NULL,ordered_parent_oids jsonb NOT NULL,
 provenance jsonb NOT NULL,disposition text NOT NULL CHECK(disposition IN ('IMPORTED','COLLAPSED')),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,import_id,git_oid),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,import_id) REFERENCES hyperfide.source_git_imports,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_git_import_tags (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 import_id uuid NOT NULL,git_oid text NOT NULL,target_oid text NOT NULL,revision_id text NOT NULL,tag jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,import_id,git_oid),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,import_id) REFERENCES hyperfide.source_git_imports
);
CREATE TABLE hyperfide.source_git_contributions (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 contribution_id uuid NOT NULL,provider text NOT NULL,provider_identity text NOT NULL,source_id text NOT NULL,tip_oid text NOT NULL,
 import_id uuid NOT NULL,request_digest text NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,contribution_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,import_id) REFERENCES hyperfide.source_git_imports
);
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['source_projection_policies','source_git_imports','source_git_import_objects','source_git_import_commits','source_git_import_tags','source_git_contributions'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',t);END LOOP;END $$;
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['source_projection_policies','source_git_import_objects','source_git_import_commits','source_git_import_tags','source_git_contributions'] LOOP EXECUTE format('CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable()',t);END LOOP;END $$;
CREATE FUNCTION hyperfide.source_git_import_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'IMPORTING' OR NEW.generation<>OLD.generation+1 OR
 ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.import_id,OLD.principal_id,OLD.authority_epoch,OLD.request_digest,OLD.request,OLD.source_id,OLD.repository_identity,OLD.tip_oid,OLD.base_revision_id,OLD.policy_id,OLD.policy_version,OLD.policy_digest,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.import_id,NEW.principal_id,NEW.authority_epoch,NEW.request_digest,NEW.request,NEW.source_id,NEW.repository_identity,NEW.tip_oid,NEW.base_revision_id,NEW.policy_id,NEW.policy_version,NEW.policy_digest,NEW.created_at)
 THEN RAISE EXCEPTION 'invalid source import transition' USING ERRCODE='23514';END IF;RETURN NEW;END $$;
CREATE TRIGGER transition BEFORE UPDATE OR DELETE ON hyperfide.source_git_imports FOR EACH ROW EXECUTE FUNCTION hyperfide.source_git_import_transition();
