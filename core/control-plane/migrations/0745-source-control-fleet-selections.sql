CREATE TABLE hyperfide.source_fleet_selections (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, run_id uuid NOT NULL,
 selection_id uuid NOT NULL, generation bigint NOT NULL CHECK(generation>0), previous_revision_id text NOT NULL,
 revision_id text NOT NULL, root_tree_id text NOT NULL, acceptance_id text NOT NULL, acceptance_digest text NOT NULL,
 run_authority_epoch uuid NOT NULL, source_authority_epoch bigint NOT NULL CHECK(source_authority_epoch>0),
 receipt jsonb NOT NULL CHECK(jsonb_typeof(receipt)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,run_id,selection_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,run_id,generation),
 UNIQUE(organisation_id,repository_id,security_domain_id,run_id,selection_id,generation),
 FOREIGN KEY(organisation_id,run_id,repository_id) REFERENCES hyperfide.source_fleet_runs(organisation_id,run_id,repository_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,acceptance_id) REFERENCES hyperfide.source_native_acceptances
);
CREATE TABLE hyperfide.source_fleet_selection_heads (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL, run_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0), selection_id uuid,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,run_id),
 FOREIGN KEY(organisation_id,run_id,repository_id) REFERENCES hyperfide.source_fleet_runs(organisation_id,run_id,repository_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,run_id,selection_id,generation) REFERENCES hyperfide.source_fleet_selections(organisation_id,repository_id,security_domain_id,run_id,selection_id,generation),
 CHECK((generation=0)=(selection_id IS NULL))
);
CREATE TRIGGER source_fleet_selection_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_fleet_selections FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_fleet_selection_head_binding BEFORE UPDATE ON hyperfide.source_fleet_selection_heads FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','run_id');
CREATE FUNCTION hyperfide.source_fleet_selection_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.generation<>OLD.generation+1 OR NEW.selection_id IS NULL THEN
  RAISE EXCEPTION 'Native fleet source selection must advance exactly one generation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_fleet_selection_advance BEFORE UPDATE ON hyperfide.source_fleet_selection_heads FOR EACH ROW EXECUTE FUNCTION hyperfide.source_fleet_selection_advance();
CREATE TRIGGER source_fleet_selection_head_delete BEFORE DELETE ON hyperfide.source_fleet_selection_heads FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['source_fleet_selections','source_fleet_selection_heads'] LOOP
  EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',item);
 END LOOP;
END $$;
