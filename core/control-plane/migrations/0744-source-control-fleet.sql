CREATE TABLE hyperfide.source_fleet_runs (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, run_id uuid NOT NULL,
 revision_id text NOT NULL, root_tree_id text NOT NULL, authority_epoch uuid NOT NULL,
 source_authority_epoch bigint NOT NULL CHECK(source_authority_epoch>0), leader_generation bigint NOT NULL CHECK(leader_generation>0),
 source_manifest_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,run_id,repository_id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_fleet_assignments (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 assignment_id uuid NOT NULL, assignment_generation bigint NOT NULL CHECK(assignment_generation>0),
 run_id uuid NOT NULL, task_id uuid NOT NULL, attempt_id uuid NOT NULL, attempt_generation bigint NOT NULL CHECK(attempt_generation>0),
 workspace_id uuid NOT NULL, worker_principal_id uuid NOT NULL, worker_credential_id uuid NOT NULL, manager_principal_id uuid NOT NULL, capability_id uuid NOT NULL,
 run_authority_epoch uuid NOT NULL, source_authority_epoch bigint NOT NULL CHECK(source_authority_epoch>0),
 sandbox_id uuid NOT NULL, slot_id uuid NOT NULL, sandbox_boot_generation bigint NOT NULL CHECK(sandbox_boot_generation>0),
 base_revision_id text NOT NULL, closure_digest text NOT NULL, environment_digest text NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), submission_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,assignment_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,workspace_id),
 UNIQUE(organisation_id,workspace_id),
 UNIQUE(organisation_id,run_id,task_id,attempt_id,attempt_generation),
 FOREIGN KEY(organisation_id,run_id,task_id,attempt_id,attempt_generation) REFERENCES hyperfide.attempts(organisation_id,run_id,task_id,id,generation),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,workspace_id) REFERENCES hyperfide.source_workspaces,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,capability_id) REFERENCES hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id)
);
CREATE TABLE hyperfide.source_fleet_submissions (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 custody_id uuid NOT NULL, custody_generation bigint NOT NULL CHECK(custody_generation>0), assignment_id uuid NOT NULL,
 run_id uuid NOT NULL, task_id uuid NOT NULL, attempt_id uuid NOT NULL, attempt_generation bigint NOT NULL CHECK(attempt_generation>0),
 revision_id text NOT NULL, root_tree_id text NOT NULL, run_authority_epoch uuid NOT NULL, source_authority_epoch bigint NOT NULL CHECK(source_authority_epoch>0),
 spec_revision_id uuid NOT NULL, spec_generation bigint NOT NULL CHECK(spec_generation>0), criteria_digest text NOT NULL,
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'), input_manifest jsonb NOT NULL CHECK(jsonb_typeof(input_manifest)='object'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), authority text NOT NULL DEFAULT 'ACTIVE' CHECK(authority IN('ACTIVE','REVOKED','SUPERSEDED','RELEASED')),
 qualification_outcome text NOT NULL DEFAULT 'PENDING' CHECK(qualification_outcome IN('PENDING','PASS','FAIL')), current_qualification_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,custody_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,assignment_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,assignment_id,custody_id),
 UNIQUE(organisation_id,run_id,task_id,custody_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,assignment_id) REFERENCES hyperfide.source_fleet_assignments,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,custody_id) REFERENCES hyperfide.source_native_custodies,
 FOREIGN KEY(organisation_id,run_id,task_id,attempt_id,attempt_generation) REFERENCES hyperfide.attempts(organisation_id,run_id,task_id,id,generation)
);
CREATE UNIQUE INDEX source_fleet_current_custody ON hyperfide.source_fleet_submissions(organisation_id,run_id,task_id) WHERE authority='ACTIVE';
ALTER TABLE hyperfide.tasks ADD COLUMN current_native_custody_id uuid;
ALTER TABLE hyperfide.tasks ADD CONSTRAINT task_native_custody_fk FOREIGN KEY(organisation_id,run_id,id,current_native_custody_id)
 REFERENCES hyperfide.source_fleet_submissions(organisation_id,run_id,task_id,custody_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE hyperfide.tasks ADD CONSTRAINT task_one_source_custody CHECK(current_native_custody_id IS NULL OR current_custody_id IS NULL);
CREATE TABLE hyperfide.source_fleet_qualifications (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 run_id uuid NOT NULL, task_id uuid NOT NULL, custody_id uuid NOT NULL, custody_generation bigint NOT NULL CHECK(custody_generation>0),
 qualification_id text NOT NULL, candidate_id uuid NOT NULL, candidate_qualification_id text NOT NULL,
 criteria_digest text NOT NULL, spec_revision_id uuid NOT NULL, spec_generation bigint NOT NULL CHECK(spec_generation>0),
 policy_digest text NOT NULL, input_digest text NOT NULL, receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,qualification_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,custody_id,qualification_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,custody_id) REFERENCES hyperfide.source_fleet_submissions
);
ALTER TABLE hyperfide.source_fleet_assignments ADD CONSTRAINT source_fleet_assignment_submission_fk
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,assignment_id,submission_id)
 REFERENCES hyperfide.source_fleet_submissions(organisation_id,repository_id,security_domain_id,assignment_id,custody_id);
ALTER TABLE hyperfide.source_fleet_submissions ADD CONSTRAINT source_fleet_current_qualification_fk
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,custody_id,current_qualification_id)
 REFERENCES hyperfide.source_fleet_qualifications(organisation_id,repository_id,security_domain_id,custody_id,qualification_id);
CREATE FUNCTION hyperfide.source_fleet_custody_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.authority<>'ACTIVE' AND NEW.authority IS DISTINCT FROM OLD.authority THEN
  RAISE EXCEPTION 'Native fleet custody disposition is permanent' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_fleet_custody_terminal BEFORE UPDATE ON hyperfide.source_fleet_submissions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_fleet_custody_terminal();
CREATE TRIGGER source_fleet_run_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_fleet_runs FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_fleet_assignment_binding BEFORE UPDATE ON hyperfide.source_fleet_assignments FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','assignment_id','assignment_generation','run_id','task_id','attempt_id','attempt_generation','workspace_id','worker_principal_id','worker_credential_id','manager_principal_id','capability_id','run_authority_epoch','source_authority_epoch','sandbox_id','slot_id','sandbox_boot_generation','base_revision_id','closure_digest','environment_digest','result','created_at');
CREATE TRIGGER source_fleet_submission_binding BEFORE UPDATE ON hyperfide.source_fleet_submissions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','custody_id','custody_generation','assignment_id','run_id','task_id','attempt_id','attempt_generation','revision_id','root_tree_id','run_authority_epoch','source_authority_epoch','spec_revision_id','spec_generation','criteria_digest','policy','input_manifest','result','created_at');
CREATE TRIGGER source_fleet_qualification_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_fleet_qualifications FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['source_fleet_runs','source_fleet_assignments','source_fleet_submissions','source_fleet_qualifications'] LOOP
  EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',item);
 END LOOP;
 FOREACH item IN ARRAY ARRAY['source_fleet_assignments','source_fleet_submissions'] LOOP
  EXECUTE format('CREATE TRIGGER source_fleet_delete_guard BEFORE DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable()',item);
 END LOOP;
END $$;
