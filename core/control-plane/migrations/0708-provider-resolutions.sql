-- Operator resolution of provider orphans and QUARANTINED provisioning intents
-- (hyperfide-v21 2.1). Before this, both states had no exit and held capacity
-- as unknown forever. Every resolution is an append-only audit row naming the
-- principal that decided; unresolved items older than the policy window become
-- decision Asks here until the general hyperfide.asks table (v21 3.1) absorbs them.
CREATE TABLE hyperfide.provider_resolutions (
 organisation_id uuid NOT NULL,
 id uuid NOT NULL,
 run_id uuid NOT NULL,
 subject_kind text NOT NULL CHECK(subject_kind IN ('ORPHAN','INTENT')),
 pool_id uuid NOT NULL,
 native_sandbox_id text,
 intent_id uuid,
 resolution text NOT NULL CHECK(resolution IN ('RETAIN','DELETE','RELEASE','RETRY')),
 prior_state text NOT NULL,
 resulting_state text NOT NULL,
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 1024),
 evidence_digest hyperfide.digest,
 released_reservations integer NOT NULL DEFAULT 0 CHECK(released_reservations>=0),
 decided_by_credential_id uuid NOT NULL,
 decided_by_actor_id uuid NOT NULL,
 decided_by_role text NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,pool_id) REFERENCES hyperfide.provider_pools(organisation_id,id),
 FOREIGN KEY(organisation_id,intent_id) REFERENCES hyperfide.provisioning_intents(organisation_id,id),
 FOREIGN KEY(organisation_id,pool_id,native_sandbox_id) REFERENCES hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id),
 CHECK(subject_kind<>'ORPHAN' OR (native_sandbox_id IS NOT NULL AND intent_id IS NULL AND resolution IN ('RETAIN','DELETE'))),
 CHECK(subject_kind<>'INTENT' OR (intent_id IS NOT NULL AND native_sandbox_id IS NULL AND resolution IN ('RELEASE','RETRY'))),
 CHECK(resolution<>'DELETE' OR evidence_digest IS NOT NULL)
);
CREATE INDEX provider_resolutions_subject ON hyperfide.provider_resolutions(organisation_id,pool_id,decided_at);
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_resolutions FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER provider_resolution_immutable BEFORE UPDATE OR DELETE ON hyperfide.provider_resolutions FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','id','run_id','subject_kind','pool_id','native_sandbox_id','intent_id','resolution','prior_state','resulting_state','reason','evidence_digest','released_reservations','decided_by_credential_id','decided_by_actor_id','decided_by_role','decided_at');

-- Decision Asks for items left unresolved past the policy window: one open Ask
-- per subject, answered by the resolution that settles it.
CREATE TABLE hyperfide.provider_resolution_asks (
 organisation_id uuid NOT NULL,
 id uuid NOT NULL,
 subject_key text NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 512),
 subject_kind text NOT NULL CHECK(subject_kind IN ('ORPHAN','INTENT')),
 pool_id uuid NOT NULL,
 native_sandbox_id text,
 intent_id uuid,
 kind text NOT NULL DEFAULT 'decision' CHECK(kind='decision'),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 512),
 options jsonb NOT NULL CHECK(jsonb_typeof(options)='array'),
 recommended text NOT NULL,
 window_seconds integer NOT NULL CHECK(window_seconds>0),
 subject_since timestamptz NOT NULL,
 raised_by_credential_id uuid NOT NULL,
 raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','ANSWERED')),
 resolution_id uuid,
 answered_at timestamptz,
 state_version bigint NOT NULL DEFAULT 1 CHECK(state_version>=1),
 PRIMARY KEY(organisation_id,id),
 FOREIGN KEY(organisation_id,pool_id) REFERENCES hyperfide.provider_pools(organisation_id,id),
 FOREIGN KEY(organisation_id,intent_id) REFERENCES hyperfide.provisioning_intents(organisation_id,id),
 FOREIGN KEY(organisation_id,resolution_id) REFERENCES hyperfide.provider_resolutions(organisation_id,id),
 CHECK((state='ANSWERED')=(resolution_id IS NOT NULL AND answered_at IS NOT NULL))
);
CREATE UNIQUE INDEX provider_resolution_one_open_ask ON hyperfide.provider_resolution_asks(organisation_id,subject_key) WHERE state='OPEN';
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_resolution_asks FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER provider_resolution_ask_identity BEFORE UPDATE ON hyperfide.provider_resolution_asks FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','id','subject_key','subject_kind','pool_id','native_sandbox_id','intent_id','kind','title','options','recommended','window_seconds','subject_since','raised_by_credential_id','raised_at');
