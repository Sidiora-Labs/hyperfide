CREATE TABLE hyperfide.source_graph_builds (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 build_id uuid NOT NULL, request_digest text NOT NULL, revision_id text NOT NULL, root_tree_id text NOT NULL,
 identity jsonb NOT NULL, paths jsonb NOT NULL, state text NOT NULL CHECK(state IN ('BUILDING','READY','PUBLISHED')),
 coverage jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,build_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 CHECK(jsonb_typeof(identity)='object' AND jsonb_typeof(paths)='array')
);
CREATE TABLE hyperfide.source_graph_extractions (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 cache_key text NOT NULL, path text NOT NULL, content_digest text NOT NULL, facts jsonb NOT NULL, complete boolean NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,cache_key),
 CHECK(jsonb_typeof(facts)='array')
);
CREATE TABLE hyperfide.source_graph_files (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 build_id uuid NOT NULL, path text NOT NULL, cache_key text NOT NULL, content_digest text NOT NULL,
 body text NOT NULL, dependencies jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,build_id,path),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,build_id) REFERENCES hyperfide.source_graph_builds,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,cache_key) REFERENCES hyperfide.source_graph_extractions,
 CHECK(jsonb_typeof(dependencies)='array')
);
CREATE TABLE hyperfide.source_graph_channels (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 channel text NOT NULL, generation bigint NOT NULL CHECK(generation>0), build_id uuid NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,channel),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,build_id) REFERENCES hyperfide.source_graph_builds
);
CREATE TABLE hyperfide.source_graph_publications (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 operation_id uuid NOT NULL, request_digest text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,operation_id)
);
CREATE TRIGGER source_graph_extractions_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_graph_extractions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_graph_files_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_graph_files FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_graph_publications_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_graph_publications FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_graph_builds FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_graph_extractions FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_graph_files FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_graph_channels FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_graph_publications FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER immutable_source_graph_identity BEFORE UPDATE ON hyperfide.source_graph_builds FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','build_id','request_digest','revision_id','root_tree_id','identity','paths');
CREATE FUNCTION hyperfide.source_graph_files_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM hyperfide.source_graph_builds WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND build_id=NEW.build_id AND state<>'BUILDING') THEN RAISE EXCEPTION 'Native graph is frozen' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_graph_files_frozen BEFORE INSERT ON hyperfide.source_graph_files FOR EACH ROW EXECUTE FUNCTION hyperfide.source_graph_files_frozen();

CREATE FUNCTION hyperfide.source_graph_build_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='PUBLISHED' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Published native graph is immutable' USING ERRCODE='23514'; END IF;
 IF OLD.state='READY' AND (NEW.state<>'PUBLISHED' OR NEW.coverage IS DISTINCT FROM OLD.coverage) THEN RAISE EXCEPTION 'Ready native graph may only be published' USING ERRCODE='23514'; END IF;
 IF OLD.state='BUILDING' AND NEW.state NOT IN ('BUILDING','READY') THEN RAISE EXCEPTION 'Native graph must complete before publication' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_graph_build_fence BEFORE UPDATE ON hyperfide.source_graph_builds FOR EACH ROW EXECUTE FUNCTION hyperfide.source_graph_build_fence();
