-- The Ask primitive (hyperfide-v21 3.1, req 3): the one durable channel from an
-- agent to a human for a secret, variable, permission, decision or question
-- (spec/workflow.kvx [asks]). hyperfide.asks is the mutable head readers list;
-- hyperfide.ask_events is its append-only history, written only by the head's
-- own trigger, one row per state_version.
--
-- Lifecycle: OPEN -> ANSWERED | EXPIRED, and EXPIRED -> ANSWERED for a blocking
-- Ask. Expiry is legal only once the deadline has passed. A proceed-and-flag Ask
-- expires by taking its recommended option as the answer with
-- decided_by_default (D11: the default taken is recorded as a decision naming
-- the Ask it replaced). A blocking Ask expires with no answer and stays the
-- reason its task waits (D4) until a human answers it late.
--
-- raised_by and answered_by are credential ids, as in provider_resolutions; an
-- org-scoped Ask (no run) carries no task, attempt or session.
CREATE TABLE hyperfide.asks (
 organisation_id uuid NOT NULL REFERENCES hyperfide.organisations(id),
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 run_id uuid,
 kind text NOT NULL CHECK(kind IN ('secret','variable','permission','decision','question')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 512),
 body text NOT NULL DEFAULT '' CHECK(length(body)<=65536),
 options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(options)='array' AND octet_length(options::text)<=65536
  AND NOT jsonb_path_exists(options,'$[*] ? (@.type() != "string")')),
 recommended text,
 deadline timestamptz,
 default_policy text NOT NULL CHECK(default_policy IN ('block','proceed-and-flag')),
 chain jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(chain)='array' AND octet_length(chain::text)<=65536
  AND NOT jsonb_path_exists(chain,'$[*] ? (@.type() != "string")')),
 task uuid,
 attempt uuid,
 session uuid,
 sandbox uuid,
 raised_by uuid NOT NULL,
 raised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','ANSWERED','EXPIRED')),
 answered_by uuid,
 answer text CHECK(length(answer) BETWEEN 1 AND 65536),
 decided_by_default boolean NOT NULL DEFAULT false,
 answered_at timestamptz,
 expired_at timestamptz,
 state_version bigint NOT NULL DEFAULT 1 CHECK(state_version>=1),
 PRIMARY KEY(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id,task) REFERENCES hyperfide.tasks(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,attempt) REFERENCES hyperfide.attempts(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,run_id,session) REFERENCES hyperfide.agent_sessions(organisation_id,run_id,id),
 FOREIGN KEY(organisation_id,sandbox) REFERENCES hyperfide.sandboxes(organisation_id,id),
 CHECK(run_id IS NOT NULL OR (task IS NULL AND attempt IS NULL AND session IS NULL)),
 CHECK((recommended IS NULL)=(jsonb_array_length(options)=0) AND (recommended IS NULL OR options ? recommended)),
 -- workflow [hard_rules] no_silent_default: these kinds are never defaulted.
 CHECK(kind NOT IN ('secret','variable','permission') OR default_policy='block'),
 CHECK(default_policy='block' OR (recommended IS NOT NULL AND deadline IS NOT NULL)),
 CHECK(deadline IS NULL OR deadline>raised_at),
 -- A secret is answered with a reference (D17), never with its value.
 CHECK(kind<>'secret' OR answer IS NULL OR answer ~ '^secret-ref:[A-Za-z0-9._-]{1,200}$'),
 CHECK(state<>'OPEN' OR (answer IS NULL AND answered_by IS NULL AND answered_at IS NULL AND expired_at IS NULL AND NOT decided_by_default)),
 CHECK(state<>'ANSWERED' OR (answer IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL AND NOT decided_by_default)),
 CHECK(state<>'EXPIRED' OR (answered_by IS NULL AND answered_at IS NULL AND expired_at IS NOT NULL AND
  CASE default_policy WHEN 'proceed-and-flag' THEN decided_by_default AND answer=recommended ELSE answer IS NULL AND NOT decided_by_default END))
);
CREATE INDEX asks_open ON hyperfide.asks(organisation_id,state,deadline) WHERE state<>'ANSWERED';
CREATE INDEX asks_task ON hyperfide.asks(organisation_id,run_id,task) WHERE task IS NOT NULL;

CREATE TABLE hyperfide.ask_events (
 organisation_id uuid NOT NULL,
 ask_id uuid NOT NULL,
 state_version bigint NOT NULL CHECK(state_version>=1),
 event_type text NOT NULL CHECK(event_type IN ('RAISED','ANSWERED','EXPIRED')),
 state text NOT NULL CHECK(state IN ('OPEN','ANSWERED','EXPIRED')),
 actor uuid,
 answer text,
 decided_by_default boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,ask_id,state_version),
 FOREIGN KEY(organisation_id,ask_id) REFERENCES hyperfide.asks(organisation_id,id),
 CHECK(event_type='EXPIRED' OR actor IS NOT NULL)
);

CREATE FUNCTION hyperfide.ask_head_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'asks are durable and cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'OPEN' OR NEW.state_version<>1 THEN RAISE EXCEPTION 'an ask is raised OPEN at state_version 1' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.state_version<>OLD.state_version+1 THEN RAISE EXCEPTION 'ask state_version must advance by one' USING ERRCODE='23514'; END IF;
 IF NOT ((OLD.state='OPEN' AND NEW.state IN ('ANSWERED','EXPIRED'))
      OR (OLD.state='EXPIRED' AND NEW.state='ANSWERED' AND OLD.default_policy='block')) THEN
  RAISE EXCEPTION 'illegal ask transition % -> %',OLD.state,NEW.state USING ERRCODE='23514';
 END IF;
 IF NEW.state='EXPIRED' AND (OLD.deadline IS NULL OR clock_timestamp()<OLD.deadline) THEN
  RAISE EXCEPTION 'ask cannot expire before its deadline' USING ERRCODE='23514';
 END IF;
 IF NEW.state='ANSWERED' THEN NEW.expired_at=OLD.expired_at; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hyperfide.ask_record_event() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 INSERT INTO hyperfide.ask_events(organisation_id,ask_id,state_version,event_type,state,actor,answer,decided_by_default)
 VALUES(NEW.organisation_id,NEW.id,NEW.state_version,
  CASE WHEN TG_OP='INSERT' THEN 'RAISED' ELSE NEW.state END,NEW.state,
  CASE WHEN TG_OP='INSERT' THEN NEW.raised_by ELSE NEW.answered_by END,NEW.answer,NEW.decided_by_default);
 RETURN NULL;
END $$;
-- Only the head's trigger can write history: an event must match the head as it now stands.
CREATE FUNCTION hyperfide.ask_event_matches_head() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hyperfide.asks a WHERE a.organisation_id=NEW.organisation_id AND a.id=NEW.ask_id
   AND a.state_version=NEW.state_version AND a.state=NEW.state AND a.answer IS NOT DISTINCT FROM NEW.answer
   AND a.decided_by_default=NEW.decided_by_default) THEN
  RAISE EXCEPTION 'ask event does not match the ask head' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hyperfide.reject_ask_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ask history is append-only' USING ERRCODE='23514'; END $$;

CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.asks FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER ask_identity BEFORE UPDATE ON hyperfide.asks FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','id','run_id','kind','title','body','options','recommended','deadline','default_policy','chain','task','attempt','session','sandbox','raised_by','raised_at');
CREATE TRIGGER ask_lifecycle BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.asks FOR EACH ROW EXECUTE FUNCTION hyperfide.ask_head_guard();
CREATE TRIGGER ask_history AFTER INSERT OR UPDATE ON hyperfide.asks FOR EACH ROW EXECUTE FUNCTION hyperfide.ask_record_event();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.ask_events FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER ask_event_source BEFORE INSERT ON hyperfide.ask_events FOR EACH ROW EXECUTE FUNCTION hyperfide.ask_event_matches_head();
CREATE TRIGGER ask_event_immutable BEFORE UPDATE OR DELETE ON hyperfide.ask_events FOR EACH ROW EXECUTE FUNCTION hyperfide.reject_ask_history_mutation();
