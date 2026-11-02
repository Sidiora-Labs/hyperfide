CREATE TABLE hyperfide.source_transformations (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL, authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 kind text NOT NULL CHECK(kind IN ('MERGE','REBASE','REVERT')),
 request jsonb NOT NULL CHECK(jsonb_typeof(request)='object'),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0),
 status text NOT NULL CHECK(status IN ('ACTIVE','CONFLICT','COMPLETED')),
 next_step integer NOT NULL DEFAULT 0 CHECK(next_step>=0 AND next_step<=64),
 tip_revision_id text NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id) REFERENCES hyperfide.source_metadata_operations,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,tip_revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_transformation_steps (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL, step integer NOT NULL CHECK(step>=0 AND step<64),
 input_digest text NOT NULL CHECK(input_digest ~ '^sha256:[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id,step),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id) REFERENCES hyperfide.source_transformations
);
CREATE TABLE hyperfide.source_transformation_conflicts (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL,
 conflict_id text NOT NULL CHECK(conflict_id ~ '^sha256:[a-f0-9]{64}$'),
 step integer NOT NULL CHECK(step>=0 AND step<64),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id,conflict_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id) REFERENCES hyperfide.source_transformations
);
CREATE TABLE hyperfide.source_transformation_resolutions (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL,
 conflict_id text NOT NULL CHECK(conflict_id ~ '^sha256:[a-f0-9]{64}$'),
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$'),
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id,conflict_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id,conflict_id) REFERENCES hyperfide.source_transformation_conflicts
);
CREATE FUNCTION hyperfide.source_transformation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status='COMPLETED' OR NEW.generation<>OLD.generation+1
 OR ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.principal_id,OLD.operation_id,OLD.authority_epoch,OLD.kind,OLD.request,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.principal_id,NEW.operation_id,NEW.authority_epoch,NEW.kind,NEW.request,NEW.created_at)
 OR NEW.next_step<OLD.next_step OR NEW.next_step>OLD.next_step+1
 THEN RAISE EXCEPTION 'invalid native transformation transition' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_transformation_transition BEFORE UPDATE ON hyperfide.source_transformations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_transformation_transition();
CREATE TRIGGER source_transformations_delete_guard BEFORE DELETE ON hyperfide.source_transformations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_transformation_steps_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_transformation_steps FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_transformation_conflicts_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_transformation_conflicts FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_transformation_resolutions_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_transformation_resolutions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
DO $$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['source_transformations','source_transformation_steps','source_transformation_conflicts','source_transformation_resolutions']
 LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',table_name); END LOOP;
END $$;
