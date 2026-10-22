-- Blocked is the waiting state (hyperfide-v21 3.3, req 3 ac_2, D4).
--
-- A RUNNING task whose current attempt raises a blocking Ask (default_policy
-- 'block') enters BLOCKED with tasks.blocked_ask naming that Ask. An expired
-- blocking Ask still waits (0709). When the named Ask is answered the task
-- moves to the next waiting blocking Ask of the same attempt if there is one,
-- otherwise back to RUNNING; if a stop revoked the attempt meanwhile it stays
-- BLOCKED as a stop hold with no Ask reference.
--
-- BLOCKED with a NULL blocked_ask is the older stop hold (recovery/stop.ts);
-- readers that need "waiting on a human" test blocked_ask, never state alone.
ALTER TABLE hyperfide.tasks ADD COLUMN blocked_ask uuid;
ALTER TABLE hyperfide.tasks ADD CONSTRAINT tasks_blocked_ask_fk FOREIGN KEY(organisation_id,blocked_ask) REFERENCES hyperfide.asks(organisation_id,id);
ALTER TABLE hyperfide.tasks ADD CONSTRAINT tasks_blocked_ask_state CHECK(blocked_ask IS NULL OR state='BLOCKED');
CREATE INDEX tasks_blocked_ask ON hyperfide.tasks(organisation_id,blocked_ask) WHERE blocked_ask IS NOT NULL;

-- The one predicate for "this Ask holds its task": blocking, unanswered, and
-- raised by the task's current attempt (or by the task with no attempt).
CREATE FUNCTION hyperfide.ask_holds_task(a hyperfide.asks,t hyperfide.tasks) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hyperfide AS $$
 SELECT a.default_policy='block' AND a.state IN ('OPEN','EXPIRED') AND a.organisation_id=t.organisation_id
  AND a.run_id=t.run_id AND a.task=t.id AND (a.attempt IS NULL OR a.attempt IS NOT DISTINCT FROM t.current_attempt_id)
$$;

CREATE FUNCTION hyperfide.ask_task_wait() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE t hyperfide.tasks; next_ask uuid; live boolean;
BEGIN
 IF NEW.task IS NULL OR NEW.default_policy<>'block' THEN RETURN NULL; END IF;
 IF TG_OP='INSERT' THEN
  UPDATE hyperfide.tasks x SET state='BLOCKED',blocked_ask=NEW.id,state_version=x.state_version+1
   WHERE x.organisation_id=NEW.organisation_id AND x.run_id=NEW.run_id AND x.id=NEW.task AND x.state='RUNNING'
   AND (NEW.attempt IS NULL OR x.current_attempt_id=NEW.attempt);
  RETURN NULL;
 END IF;
 IF NEW.state<>'ANSWERED' THEN RETURN NULL; END IF;
 SELECT * INTO t FROM hyperfide.tasks x WHERE x.organisation_id=NEW.organisation_id AND x.run_id=NEW.run_id AND x.id=NEW.task AND x.blocked_ask=NEW.id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT a.id INTO next_ask FROM hyperfide.asks a WHERE a.organisation_id=t.organisation_id AND a.task=t.id AND a.id<>NEW.id
  AND hyperfide.ask_holds_task(a,t) ORDER BY a.raised_at,a.id LIMIT 1;
 IF next_ask IS NOT NULL THEN
  UPDATE hyperfide.tasks SET blocked_ask=next_ask,state_version=state_version+1 WHERE organisation_id=t.organisation_id AND run_id=t.run_id AND id=t.id;
  RETURN NULL;
 END IF;
 SELECT EXISTS(SELECT 1 FROM hyperfide.attempts a WHERE a.organisation_id=t.organisation_id AND a.run_id=t.run_id AND a.id=t.current_attempt_id
  AND a.compute_authority='CURRENT' AND a.execution_state NOT IN ('SUCCEEDED','FAILED','CANCELLED','SUBMITTED')) INTO live;
 UPDATE hyperfide.tasks SET state=CASE WHEN live THEN 'RUNNING' ELSE 'BLOCKED' END,blocked_ask=NULL,state_version=state_version+1
  WHERE organisation_id=t.organisation_id AND run_id=t.run_id AND id=t.id;
 RETURN NULL;
END $$;

-- Only an answer (or a cancel) releases a task from its Ask; a reference is
-- only ever set to an Ask that holds the task.
CREATE FUNCTION hyperfide.task_ask_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE a hyperfide.asks;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.blocked_ask IS NOT NULL THEN RAISE EXCEPTION 'a task is never created waiting on an ask' USING ERRCODE='23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.blocked_ask IS NOT DISTINCT FROM OLD.blocked_ask THEN RETURN NEW; END IF;
 IF OLD.blocked_ask IS NOT NULL AND NEW.state<>'CANCELLED' THEN
  SELECT * INTO a FROM hyperfide.asks WHERE organisation_id=OLD.organisation_id AND id=OLD.blocked_ask;
  IF a.state<>'ANSWERED' THEN
   RAISE EXCEPTION 'task % waits on unanswered ask %',OLD.id,OLD.blocked_ask USING ERRCODE='23514';
  END IF;
 END IF;
 IF NEW.blocked_ask IS NOT NULL THEN
  SELECT * INTO a FROM hyperfide.asks WHERE organisation_id=NEW.organisation_id AND id=NEW.blocked_ask;
  IF NOT FOUND OR NOT hyperfide.ask_holds_task(a,NEW) THEN
   RAISE EXCEPTION 'ask % does not hold task %',NEW.blocked_ask,NEW.id USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER ask_task_wait AFTER INSERT OR UPDATE ON hyperfide.asks FOR EACH ROW EXECUTE FUNCTION hyperfide.ask_task_wait();
CREATE TRIGGER task_ask_guard BEFORE INSERT OR UPDATE ON hyperfide.tasks FOR EACH ROW EXECUTE FUNCTION hyperfide.task_ask_guard();
