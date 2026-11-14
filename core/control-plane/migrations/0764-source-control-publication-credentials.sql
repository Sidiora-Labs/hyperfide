ALTER TABLE hyperfide.source_git_publications
 ADD COLUMN credential_state jsonb,
 ADD COLUMN cleanup_debt boolean NOT NULL DEFAULT false,
 ADD CONSTRAINT source_git_credential_debt CHECK (
  (credential_state IS NULL AND NOT cleanup_debt) OR
  COALESCE((credential_state IS NOT NULL AND cleanup_debt AND
   jsonb_typeof(credential_state)='object' AND
   credential_state->>'schema_version'='1' AND
   jsonb_typeof(credential_state->'expires_at')='string' AND
   (credential_state - ARRAY['schema_version','expires_at','cleanup_key'])='{}'::jsonb AND
   (NOT credential_state ? 'cleanup_key' OR (credential_state->>'cleanup_key') ~ '^[A-Za-z0-9._:-][A-Za-z0-9._:-]{0,255}$') AND
   (credential_state->>'expires_at')::timestamptz=credential_expires_at),false)
 );
CREATE OR REPLACE FUNCTION hyperfide.source_git_publication_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW) - ARRAY['credential_state','cleanup_debt','credential_expires_at','updated_at'])
    IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY['credential_state','cleanup_debt','credential_expires_at','updated_at']) THEN
  RETURN NEW;
 END IF;
 IF ROW(NEW.credential_state,NEW.cleanup_debt) IS DISTINCT FROM ROW(OLD.credential_state,OLD.cleanup_debt)
 THEN RAISE EXCEPTION 'credential cleanup requires a separate fenced update' USING ERRCODE='23514'; END IF;
 IF OLD.status IN ('PUBLISHED','REMOTE_DIVERGED','REJECTED','CANCELLED') OR NEW.generation<>OLD.generation+1
 OR ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.principal_id,OLD.operation_id,OLD.authority_epoch,OLD.request,OLD.destination_key,OLD.configuration_digest,OLD.target_ref,OLD.acceptance_id,OLD.revision_id,OLD.root_tree_id,OLD.acceptance_digest,OLD.expected_old_oid,OLD.projection_lineage,OLD.base_checkpoint_generation,OLD.root_protection,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.principal_id,NEW.operation_id,NEW.authority_epoch,NEW.request,NEW.destination_key,NEW.configuration_digest,NEW.target_ref,NEW.acceptance_id,NEW.revision_id,NEW.root_tree_id,NEW.acceptance_digest,NEW.expected_old_oid,NEW.projection_lineage,NEW.base_checkpoint_generation,NEW.root_protection,NEW.created_at)
 OR NOT ((OLD.status='QUEUED' AND NEW.status IN ('READY','CANCELLED','REMOTE_DIVERGED')) OR (OLD.status='READY' AND NEW.status IN ('DISPATCHED','CANCELLED','REMOTE_DIVERGED')) OR (OLD.status='DISPATCHED' AND NEW.status IN ('OUTCOME_UNKNOWN','PUBLISHED','REMOTE_DIVERGED','REJECTED')) OR (OLD.status='OUTCOME_UNKNOWN' AND NEW.status IN ('PUBLISHED','REMOTE_DIVERGED','REJECTED')))
 THEN RAISE EXCEPTION 'invalid native publication transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
UPDATE hyperfide.source_git_publications SET
 credential_state=jsonb_build_object('schema_version',1,'expires_at',credential_expires_at),cleanup_debt=true
 WHERE credential_expires_at IS NOT NULL;
CREATE INDEX source_git_publication_cleanup_debt ON hyperfide.source_git_publications(credential_expires_at) WHERE cleanup_debt;
