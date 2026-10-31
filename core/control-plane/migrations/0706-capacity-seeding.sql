-- Existing policies retain unknown provenance until an approved configure call.
ALTER TABLE hyperfide.scheduling_policies ADD COLUMN provenance_digest hyperfide.digest;
ALTER TABLE hyperfide.scheduling_policies ADD COLUMN qualification_state text NOT NULL DEFAULT 'UNQUALIFIED'
 CHECK(qualification_state IN ('UNQUALIFIED','QUALIFIED','STALE'));
ALTER TABLE hyperfide.scheduling_policies ADD CONSTRAINT qualified_policy_provenance
 CHECK(qualification_state<>'QUALIFIED' OR provenance_digest IS NOT NULL);

-- A sandbox row is the authority for the current boot. This also covers replacement
-- paths outside provider reconciliation without reviving an allocated or retired slot.
CREATE FUNCTION hyperfide.retire_obsolete_worker_slots() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE hyperfide.worker_slots SET state='RETIRED',state_version=state_version+1
 WHERE organisation_id=NEW.organisation_id AND sandbox_id=NEW.id AND state<>'RETIRED'
 AND (boot_generation<>NEW.boot_generation OR NEW.observed_state<>'RUNNING' OR NEW.desired_state<>'RUNNING');
 RETURN NEW;
END $$;
CREATE TRIGGER retire_obsolete_worker_slots AFTER UPDATE OF boot_generation,observed_state,desired_state
 ON hyperfide.sandboxes FOR EACH ROW EXECUTE FUNCTION hyperfide.retire_obsolete_worker_slots();

UPDATE hyperfide.worker_slots w SET state='RETIRED',state_version=w.state_version+1
 FROM hyperfide.sandboxes s WHERE s.organisation_id=w.organisation_id AND s.id=w.sandbox_id
 AND w.state<>'RETIRED' AND (w.boot_generation<>s.boot_generation OR s.observed_state<>'RUNNING' OR s.desired_state<>'RUNNING');
