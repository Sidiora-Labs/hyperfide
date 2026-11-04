CREATE TABLE hyperfide.source_candidate_queue_clock (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,service_sequence bigint NOT NULL DEFAULT 0 CHECK(service_sequence>=0),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id)
);
CREATE TABLE hyperfide.source_candidate_queue_proposals (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,proposal_id uuid NOT NULL,
 candidate_id uuid NOT NULL,manifest_digest text NOT NULL,created_by_principal_id uuid NOT NULL,manifest jsonb NOT NULL,
 expires_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,proposal_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,candidate_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,candidate_id) REFERENCES hyperfide.source_native_candidates
);
CREATE TABLE hyperfide.source_candidate_queue_owners (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,domain_id uuid NOT NULL,principal_id uuid NOT NULL,
 service_round bigint NOT NULL DEFAULT 0 CHECK(service_round>=0),pending_work integer NOT NULL DEFAULT 0 CHECK(pending_work>=0),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,domain_id,principal_id)
);
CREATE INDEX source_candidate_queue_fair_owners ON hyperfide.source_candidate_queue_owners(organisation_id,repository_id,security_domain_id,service_round,domain_id,principal_id) WHERE pending_work>0;
CREATE TABLE hyperfide.source_candidate_queue_work (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,work_id uuid NOT NULL,
 domain_id uuid NOT NULL,principal_id uuid NOT NULL,manifest jsonb NOT NULL,expires_at timestamptz NOT NULL,
 state text NOT NULL CHECK(state IN('PENDING','LEASED','SUCCEEDED','FAILED','SPLIT','EXPIRED','EXHAUSTED','STALE')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
 batch_id uuid,parent_batch_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,work_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,domain_id,principal_id) REFERENCES hyperfide.source_candidate_queue_owners
);
CREATE INDEX source_candidate_queue_pending ON hyperfide.source_candidate_queue_work(organisation_id,repository_id,security_domain_id,domain_id,principal_id,state,created_at,work_id);
CREATE INDEX source_candidate_queue_expiration ON hyperfide.source_candidate_queue_work(organisation_id,repository_id,security_domain_id,expires_at) WHERE state IN('PENDING','LEASED','FAILED');
CREATE TABLE hyperfide.source_candidate_batches (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,batch_id uuid NOT NULL,work_id uuid NOT NULL,
 owner_principal_id uuid NOT NULL,lease_id uuid NOT NULL,lease_expires_at timestamptz NOT NULL,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 state text NOT NULL CHECK(state IN('CLAIMED','BOUND','PASSED','FAILED','ISOLATED','EXPIRED')),
 candidate_id uuid,qualification_id text,evidence jsonb,result jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,batch_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,candidate_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,work_id) REFERENCES hyperfide.source_candidate_queue_work,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,candidate_id) REFERENCES hyperfide.source_native_candidates
);
CREATE INDEX source_candidate_batches_expiration ON hyperfide.source_candidate_batches(organisation_id,repository_id,security_domain_id,lease_expires_at) WHERE state IN('CLAIMED','BOUND','FAILED');
CREATE FUNCTION hyperfide.source_candidate_queue_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='source_candidate_queue_work' THEN
  IF NOT ((OLD.state='PENDING' AND NEW.state IN('LEASED','EXPIRED','EXHAUSTED','STALE')) OR (OLD.state='LEASED' AND NEW.state IN('SUCCEEDED','FAILED','PENDING','EXPIRED','EXHAUSTED')) OR (OLD.state='FAILED' AND NEW.state IN('SPLIT','PENDING','EXPIRED','EXHAUSTED')))
  THEN RAISE EXCEPTION 'invalid candidate work state transition' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.work_id,NEW.domain_id,NEW.principal_id,NEW.manifest,NEW.expires_at,NEW.max_attempts,NEW.parent_batch_id,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.work_id,OLD.domain_id,OLD.principal_id,OLD.manifest,OLD.expires_at,OLD.max_attempts,OLD.parent_batch_id,OLD.created_at)
   OR NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 THEN RAISE EXCEPTION 'invalid native candidate work transition' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT ((OLD.state='CLAIMED' AND NEW.state IN('BOUND','EXPIRED')) OR (OLD.state='BOUND' AND NEW.state IN('PASSED','FAILED','EXPIRED')) OR (OLD.state='FAILED' AND NEW.state IN('ISOLATED','EXPIRED')))
  THEN RAISE EXCEPTION 'invalid candidate batch state transition' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.batch_id,NEW.work_id,NEW.owner_principal_id,NEW.lease_id,NEW.lease_expires_at,NEW.attempt,NEW.created_at)
   IS DISTINCT FROM ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.batch_id,OLD.work_id,OLD.owner_principal_id,OLD.lease_id,OLD.lease_expires_at,OLD.attempt,OLD.created_at)
   OR OLD.candidate_id IS NOT NULL AND OLD.candidate_id IS DISTINCT FROM NEW.candidate_id
   OR OLD.evidence IS NOT NULL AND OLD.evidence IS DISTINCT FROM NEW.evidence
   OR OLD.qualification_id IS NOT NULL AND OLD.qualification_id IS DISTINCT FROM NEW.qualification_id
   OR OLD.result IS NOT NULL AND OLD.result IS DISTINCT FROM NEW.result THEN RAISE EXCEPTION 'invalid native candidate batch transition' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_candidate_proposals_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_candidate_queue_proposals FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_candidate_work_transition BEFORE UPDATE ON hyperfide.source_candidate_queue_work FOR EACH ROW EXECUTE FUNCTION hyperfide.source_candidate_queue_transition();
CREATE TRIGGER source_candidate_batch_transition BEFORE UPDATE ON hyperfide.source_candidate_batches FOR EACH ROW EXECUTE FUNCTION hyperfide.source_candidate_queue_transition();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['source_candidate_queue_clock','source_candidate_queue_proposals','source_candidate_queue_owners','source_candidate_queue_work','source_candidate_batches'] LOOP
 EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',item);
 END LOOP;
END $$;
