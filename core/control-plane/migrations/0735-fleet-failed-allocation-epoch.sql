ALTER TABLE hyperfide.fleet_install_recoveries
 ADD COLUMN allocation_epoch_operation_id uuid,
 ADD CONSTRAINT fleet_failed_allocation_epoch_self CHECK(allocation_epoch_operation_id IS NULL OR allocation_epoch_operation_id=operation_id),
 ADD CONSTRAINT fleet_failed_allocation_epoch_install FOREIGN KEY(organisation_id,run_id,allocation_epoch_operation_id)
 REFERENCES hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id);
CREATE TRIGGER immutable_allocation_epoch BEFORE UPDATE OR DELETE ON hyperfide.fleet_install_recoveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('allocation_epoch_operation_id');
CREATE FUNCTION hyperfide.guard_failed_allocation_epoch() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE old_job hyperfide.runner_remote_jobs%ROWTYPE; old_install hyperfide.fleet_environment_installs%ROWTYPE; next_install hyperfide.fleet_environment_installs%ROWTYPE; old_allocation hyperfide.resource_job_allocations%ROWTYPE;
BEGIN
 IF NEW.allocation_epoch_operation_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO old_install FROM hyperfide.fleet_environment_installs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.predecessor_install_operation_id FOR SHARE;
 SELECT * INTO next_install FROM hyperfide.fleet_environment_installs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.operation_id FOR SHARE;
 SELECT * INTO old_job FROM hyperfide.runner_remote_jobs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.runner_operation_id FOR SHARE;
 IF old_job.operation_id IS NULL OR old_install.operation_id IS NULL OR next_install.operation_id IS NULL
 OR old_job.operation_id IS DISTINCT FROM old_install.operation_id OR old_job.state IS DISTINCT FROM 'COMPLETED' OR old_job.job_class IS DISTINCT FROM 'PREPARATION'
 OR old_job.claim_id IS NULL OR old_job.native_claimed_at IS NULL OR old_job.result_signature IS NULL
 OR old_job.plan_digest IS DISTINCT FROM NEW.runner_plan_digest OR old_job.result_digest IS DISTINCT FROM NEW.runner_result_digest
 OR old_job.result->>'outcome' IS DISTINCT FROM 'FAILED' OR old_job.result->>'cleanup_status' IS DISTINCT FROM 'CONFIRMED'
 OR old_job.result->'cleanup'->>'complete' IS DISTINCT FROM 'true' OR old_job.result->'cleanup'->>'observed_process_absent' IS DISTINCT FROM 'true'
 OR old_job.result->'cleanup'->>'receipt_digest' IS DISTINCT FROM NEW.quiescence_receipt_digest::text
 OR old_job.result->'native_receipt'->>'digest' IS DISTINCT FROM NEW.quiescence_receipt_digest::text
 OR ROW(old_install.input_digest,old_install.environment_id,old_install.environment_generation,old_install.sandbox_id,old_install.boot_id,old_install.boot_generation,old_install.package_id)
 IS DISTINCT FROM ROW(next_install.input_digest,next_install.environment_id,next_install.environment_generation,next_install.sandbox_id,next_install.boot_id,next_install.boot_generation,next_install.package_id)
 OR next_install.admission->'recovery_of'->>'runner_operation_id' IS DISTINCT FROM old_job.operation_id::text
 OR old_job.plan->'preparation_request'->'job_binding'->>'namespace' IS DISTINCT FROM 'FLEET_INSTALL'
 OR old_job.plan->'preparation_request'->'job_binding'->>'job_id' IS DISTINCT FROM old_install.operation_id::text
 OR old_job.plan->'preparation_request'->'job_binding'->>'input_packet_digest' IS DISTINCT FROM old_install.admission_digest::text
 OR NEW.predecessor_admission_digest IS DISTINCT FROM old_install.admission_digest
 OR next_install.admission->'recovery_of'->>'install_operation_id' IS DISTINCT FROM old_install.operation_id::text
 OR next_install.admission->'recovery_of'->>'admission_digest' IS DISTINCT FROM old_install.admission_digest::text
 OR next_install.admission->'recovery_of'->>'runner_plan_digest' IS DISTINCT FROM NEW.runner_plan_digest::text
 OR next_install.admission->'recovery_of'->>'quiescence_operation_id' IS DISTINCT FROM old_job.operation_id::text
 OR next_install.admission->'recovery_of'->>'quiescence_receipt_digest' IS DISTINCT FROM NEW.quiescence_receipt_digest::text
 OR NOT EXISTS(SELECT 1 FROM hyperfide.fleet_install_heads h WHERE h.organisation_id=NEW.organisation_id AND h.run_id=NEW.run_id AND h.current_operation_id=old_install.operation_id AND h.sandbox_id=old_install.sandbox_id AND h.boot_id=old_install.boot_id AND h.boot_generation=old_install.boot_generation)
 OR NOT EXISTS(SELECT 1 FROM hyperfide.sandboxes s JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation WHERE s.organisation_id=NEW.organisation_id AND s.id=old_install.sandbox_id AND s.boot_generation=old_install.boot_generation AND b.boot_id=old_install.boot_id AND s.observed_state='RUNNING' AND s.desired_state='RUNNING')
 OR NOT EXISTS(SELECT 1 FROM hyperfide.runner_result_artifacts a WHERE a.organisation_id=NEW.organisation_id AND a.run_id=NEW.run_id AND a.operation_id=old_job.operation_id AND a.role='native_receipt' AND a.content_digest=NEW.quiescence_receipt_digest)
 OR next_install.admission->>'logical_operation_id' IS DISTINCT FROM old_install.admission->>'logical_operation_id'
 THEN RAISE EXCEPTION 'fresh failed allocation epoch requires exact retained signed native quiescence and compatible native recovery' USING ERRCODE='23514'; END IF;
 SELECT * INTO old_allocation FROM hyperfide.resource_job_allocations WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND id=(old_job.plan->'allocation'->>'allocation_id')::uuid FOR SHARE;
 IF old_allocation.id IS NULL OR old_allocation.state IS DISTINCT FROM 'RELEASED' OR old_allocation.job_kind IS DISTINCT FROM 'PREPARATION'
 OR old_allocation.reservation_id IS DISTINCT FROM old_job.reservation_id OR old_allocation.assignee_session_id IS DISTINCT FROM old_job.session_id
 OR old_allocation.sandbox_id IS DISTINCT FROM old_install.sandbox_id OR old_allocation.sandbox_boot_generation IS DISTINCT FROM old_install.boot_generation
 OR (SELECT count(*) FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts c ON c.organisation_id=r.organisation_id AND c.id=r.capacity_account_id WHERE r.organisation_id=NEW.organisation_id AND r.run_id=NEW.run_id AND r.request_id=old_allocation.request_id AND r.state='RELEASED' AND r.expires_at<=clock_timestamp() AND c.capacity_class<>'PHYSICAL' AND c.dimension IN('PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'))<>4
 OR (SELECT count(DISTINCT c.dimension) FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts c ON c.organisation_id=r.organisation_id AND c.id=r.capacity_account_id WHERE r.organisation_id=NEW.organisation_id AND r.run_id=NEW.run_id AND r.request_id=old_allocation.request_id)<>4
 OR (SELECT count(*) FROM hyperfide.reservations r WHERE r.organisation_id=NEW.organisation_id AND r.run_id=NEW.run_id AND r.request_id=old_allocation.request_id)<>4
 THEN RAISE EXCEPTION 'fresh failed allocation epoch requires closed exact expired logical vector' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER failed_allocation_epoch_guard BEFORE INSERT ON hyperfide.fleet_install_recoveries
 FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_failed_allocation_epoch();
