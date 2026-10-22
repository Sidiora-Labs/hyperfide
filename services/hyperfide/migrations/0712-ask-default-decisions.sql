-- Decided-by-default records (hyperfide-v21 3.6, req 3 ac_4, D11). When a
-- proceed-and-flag Ask reaches its deadline unanswered, the service takes the
-- recommended option and records that choice here as a decision: which Ask it
-- replaced, the default taken, the options that were open, and the escalation
-- chain of who would have answered. One record per Ask; records are immutable,
-- so the flag a human reviews later cannot be edited away.
CREATE TABLE hyperfide.ask_default_decisions (
 organisation_id uuid NOT NULL,
 run_id uuid NOT NULL,
 id uuid NOT NULL,
 ask_id uuid NOT NULL,
 ask_state_version bigint NOT NULL CHECK(ask_state_version>=2),
 kind text NOT NULL CHECK(kind IN ('decision','question')),
 title text NOT NULL CHECK(length(title) BETWEEN 1 AND 512),
 default_taken text NOT NULL CHECK(length(default_taken) BETWEEN 1 AND 512),
 options jsonb NOT NULL CHECK(jsonb_typeof(options)='array' AND options ? default_taken),
 would_have_answered jsonb NOT NULL CHECK(jsonb_typeof(would_have_answered)='array' AND jsonb_array_length(would_have_answered)>=1
  AND NOT jsonb_path_exists(would_have_answered,'$[*] ? (@.type() != "string")')),
 policy_revision text NOT NULL CHECK(length(policy_revision) BETWEEN 1 AND 128),
 task uuid,
 attempt uuid,
 deadline timestamptz NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_by uuid NOT NULL,
 PRIMARY KEY(organisation_id,run_id,id),
 UNIQUE(organisation_id,ask_id),
 FOREIGN KEY(organisation_id,ask_id) REFERENCES hyperfide.asks(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 CHECK(decided_at>=deadline)
);
CREATE INDEX ask_default_decisions_run ON hyperfide.ask_default_decisions(organisation_id,run_id,decided_at);

-- The record must match the Ask head it names: expired by default with this answer.
CREATE FUNCTION hyperfide.ask_default_decision_matches_ask() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hyperfide.asks a WHERE a.organisation_id=NEW.organisation_id AND a.id=NEW.ask_id
   AND a.run_id=NEW.run_id AND a.state='EXPIRED' AND a.decided_by_default AND a.answer=NEW.default_taken
   AND a.state_version=NEW.ask_state_version AND a.kind=NEW.kind AND a.deadline=NEW.deadline
   AND a.task IS NOT DISTINCT FROM NEW.task AND a.attempt IS NOT DISTINCT FROM NEW.attempt) THEN
  RAISE EXCEPTION 'a default decision must name an Ask that expired by taking that default' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION hyperfide.reject_ask_default_decision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'default decisions are immutable' USING ERRCODE='23514'; END $$;

CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.ask_default_decisions FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER ask_default_decision_source BEFORE INSERT ON hyperfide.ask_default_decisions FOR EACH ROW EXECUTE FUNCTION hyperfide.ask_default_decision_matches_ask();
CREATE TRIGGER ask_default_decision_immutable BEFORE UPDATE OR DELETE ON hyperfide.ask_default_decisions FOR EACH ROW EXECUTE FUNCTION hyperfide.reject_ask_default_decision_mutation();
