CREATE TABLE hyperfide.source_git_publications (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL,operation_id uuid NOT NULL,authority_epoch bigint NOT NULL,
 request jsonb NOT NULL,destination_key text NOT NULL,configuration_digest text NOT NULL,target_ref text NOT NULL,
 acceptance_id text NOT NULL,revision_id text NOT NULL,root_tree_id text NOT NULL,acceptance_digest text NOT NULL,
 expected_old_oid text,git_oid text,projection_manifest text,projection_mappings jsonb,
 projection_lineage uuid NOT NULL,base_checkpoint_generation bigint,
 status text NOT NULL CHECK(status IN ('QUEUED','READY','DISPATCHED','OUTCOME_UNKNOWN','PUBLISHED','REMOTE_DIVERGED','REJECTED','CANCELLED')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),credential_expires_at timestamptz,
 checkpoint_generation bigint,root_protection jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id) REFERENCES hyperfide.source_metadata_operations,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 CHECK(expected_old_oid IS NULL OR expected_old_oid ~ '^git:sha1:[a-f0-9]{40}$'),
 CHECK(git_oid IS NULL OR git_oid ~ '^git:sha1:[a-f0-9]{40}$')
);
CREATE TABLE hyperfide.source_git_targets (
 destination_key text NOT NULL,target_ref text NOT NULL,
 active_operation_id uuid,active_organisation_id uuid,active_repository_id uuid,active_security_domain_id uuid,active_principal_id uuid,
 checkpoint_generation bigint NOT NULL DEFAULT 0 CHECK(checkpoint_generation>=0),git_oid text,
 PRIMARY KEY(destination_key,target_ref),
 CHECK((active_operation_id IS NULL)=(active_organisation_id IS NULL))
);
CREATE TABLE hyperfide.source_git_mappings (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL,operation_id uuid NOT NULL,
 native_kind text NOT NULL CHECK(native_kind IN ('revision','tree','file','symlink')),native_id text NOT NULL,mapping jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id,native_kind,native_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id) REFERENCES hyperfide.source_git_publications
);
CREATE INDEX source_git_publication_checkpoint ON hyperfide.source_git_publications(destination_key,target_ref,checkpoint_generation) WHERE status='PUBLISHED';
CREATE FUNCTION hyperfide.source_git_publication_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IN ('PUBLISHED','REMOTE_DIVERGED','REJECTED','CANCELLED') OR NEW.generation<>OLD.generation+1
 OR ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.principal_id,OLD.operation_id,OLD.authority_epoch,OLD.request,OLD.destination_key,OLD.configuration_digest,OLD.target_ref,OLD.acceptance_id,OLD.revision_id,OLD.root_tree_id,OLD.acceptance_digest,OLD.expected_old_oid,OLD.projection_lineage,OLD.base_checkpoint_generation,OLD.root_protection,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.principal_id,NEW.operation_id,NEW.authority_epoch,NEW.request,NEW.destination_key,NEW.configuration_digest,NEW.target_ref,NEW.acceptance_id,NEW.revision_id,NEW.root_tree_id,NEW.acceptance_digest,NEW.expected_old_oid,NEW.projection_lineage,NEW.base_checkpoint_generation,NEW.root_protection,NEW.created_at)
 OR NOT ((OLD.status='QUEUED' AND NEW.status IN ('READY','CANCELLED','REMOTE_DIVERGED')) OR (OLD.status='READY' AND NEW.status IN ('DISPATCHED','CANCELLED','REMOTE_DIVERGED')) OR (OLD.status='DISPATCHED' AND NEW.status IN ('OUTCOME_UNKNOWN','PUBLISHED','REMOTE_DIVERGED','REJECTED')) OR (OLD.status='OUTCOME_UNKNOWN' AND NEW.status IN ('PUBLISHED','REMOTE_DIVERGED','REJECTED')))
 THEN RAISE EXCEPTION 'invalid native publication transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_git_publication_transition BEFORE UPDATE ON hyperfide.source_git_publications FOR EACH ROW EXECUTE FUNCTION hyperfide.source_git_publication_transition();
CREATE TRIGGER source_git_publication_delete_guard BEFORE DELETE ON hyperfide.source_git_publications FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_git_mapping_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_git_mappings FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE FUNCTION hyperfide.source_git_cancel_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='CANCELLED' AND OLD.action='source.publications.create' AND EXISTS(SELECT 1 FROM hyperfide.source_git_publications p WHERE p.organisation_id=OLD.organisation_id AND p.repository_id=OLD.repository_id AND p.security_domain_id=OLD.security_domain_id AND p.principal_id=OLD.principal_id AND p.operation_id=OLD.operation_id AND p.status IN ('DISPATCHED','OUTCOME_UNKNOWN'))
 THEN RAISE EXCEPTION 'issued publication requires reconciliation' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_git_cancel_guard BEFORE UPDATE ON hyperfide.source_metadata_operations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_git_cancel_guard();
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['source_git_publications','source_git_targets','source_git_mappings'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',t);END LOOP;END $$;
