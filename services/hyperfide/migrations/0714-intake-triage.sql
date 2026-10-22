-- Attributable intake triage (hyperfide-v21 3.17, req 2.5). An external issue leaves
-- NEEDS_TRIAGE only by a person or the leader deciding: dismissed as needing no finding,
-- or linked to the finding it reports. The row records who decided, why and when, so a
-- dismissal is never anonymous. Rows triaged before this migration keep null attribution;
-- every transition after it must carry all three, and once set they cannot be rewritten.
ALTER TABLE hyperfide.finding_external_intake
 ADD COLUMN triaged_by uuid,
 ADD COLUMN triage_reason text CHECK(triage_reason IS NULL OR (length(triage_reason) BETWEEN 1 AND 4096)),
 ADD COLUMN triaged_at timestamptz,
 ADD CONSTRAINT finding_external_intake_triage_complete CHECK(
  (triaged_by IS NULL)=(triage_reason IS NULL) AND (triaged_by IS NULL)=(triaged_at IS NULL)
  AND (state<>'NEEDS_TRIAGE' OR triaged_by IS NULL));

CREATE FUNCTION hyperfide.finding_intake_triage_attributed() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.triaged_by IS NOT NULL AND (NEW.triaged_by IS DISTINCT FROM OLD.triaged_by
   OR NEW.triage_reason IS DISTINCT FROM OLD.triage_reason OR NEW.triaged_at IS DISTINCT FROM OLD.triaged_at) THEN
  RAISE EXCEPTION 'intake triage attribution is immutable once recorded' USING ERRCODE='23514';
 END IF;
 IF NEW.state<>'NEEDS_TRIAGE' AND NEW.triaged_by IS NULL AND (TG_OP='INSERT' OR OLD.state='NEEDS_TRIAGE') THEN
  RAISE EXCEPTION 'an external issue leaves triage only with who triaged it, why and when' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER finding_intake_triage_attributed BEFORE INSERT OR UPDATE ON hyperfide.finding_external_intake
 FOR EACH ROW EXECUTE FUNCTION hyperfide.finding_intake_triage_attributed();
