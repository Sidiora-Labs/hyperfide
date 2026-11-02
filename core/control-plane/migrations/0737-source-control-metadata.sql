CREATE TABLE hyperfide.source_repositories (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 authority_epoch bigint NOT NULL CHECK(authority_epoch>0), policy_version text NOT NULL CHECK(length(policy_version) BETWEEN 1 AND 256),
 durability_profile text NOT NULL CHECK(length(durability_profile) BETWEEN 1 AND 256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id)
);
CREATE TABLE hyperfide.source_revisions (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 revision_id text NOT NULL CHECK(revision_id ~ '^sha256:[a-f0-9]{64}$'), root_tree_id text NOT NULL CHECK(root_tree_id ~ '^sha256:[a-f0-9]{64}$'),
 descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'), authority_epoch bigint NOT NULL CHECK(authority_epoch>0),
 root_protection jsonb NOT NULL CHECK(jsonb_typeof(root_protection)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,revision_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_repositories
);
CREATE TABLE hyperfide.source_revision_parents (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 revision_id text NOT NULL, position integer NOT NULL CHECK(position>=0 AND position<256), parent_revision_id text NOT NULL,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,revision_id,position),
 UNIQUE(organisation_id,repository_id,security_domain_id,revision_id,parent_revision_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,parent_revision_id) REFERENCES hyperfide.source_revisions,
 CHECK(revision_id<>parent_revision_id)
);
CREATE INDEX source_revision_parent_children ON hyperfide.source_revision_parents(organisation_id,repository_id,security_domain_id,parent_revision_id,revision_id);
CREATE TABLE hyperfide.source_change_revisions (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 change_id uuid NOT NULL, revision_id text NOT NULL, predecessor_revision_ids jsonb NOT NULL CHECK(jsonb_typeof(predecessor_revision_ids)='array' AND jsonb_array_length(predecessor_revision_ids)<=256),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,change_id,revision_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_metadata_operations (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 principal_id uuid NOT NULL, operation_id uuid NOT NULL, action text NOT NULL, idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN('PENDING','COMMITTED','CANCELLED','FAILED')), result jsonb, result_digest text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,principal_id,operation_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,principal_id,action,idempotency_key),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_repositories,
 CHECK((state='COMMITTED')=(result IS NOT NULL AND result_digest IS NOT NULL)),
 CHECK(result_digest IS NULL OR result_digest ~ '^sha256:[a-f0-9]{64}$')
);
CREATE TABLE hyperfide.source_events (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 event_id uuid NOT NULL, aggregate_id text NOT NULL, aggregate_generation bigint NOT NULL CHECK(aggregate_generation>0),
 event_type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,event_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,aggregate_id,aggregate_generation),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id) REFERENCES hyperfide.source_repositories
);
CREATE TABLE hyperfide.source_event_consumers (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 consumer_id uuid NOT NULL, principal_id uuid NOT NULL, subscription_epoch uuid NOT NULL,
 bootstrap_revision_id text NOT NULL, backfill_high_id uuid, backfill_after_id uuid, backfill_complete boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,consumer_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,bootstrap_revision_id) REFERENCES hyperfide.source_revisions
);
CREATE TABLE hyperfide.source_event_deliveries (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 consumer_id uuid NOT NULL, event_id uuid NOT NULL, state text NOT NULL CHECK(state IN('PENDING','LEASED','ACKNOWLEDGED')),
 lease_id uuid, lease_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), acknowledged_at timestamptz, acknowledged_lease_id uuid,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,consumer_id,event_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,consumer_id) REFERENCES hyperfide.source_event_consumers,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,event_id) REFERENCES hyperfide.source_events,
 CHECK((state='LEASED')=(lease_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX source_pending_event_deliveries ON hyperfide.source_event_deliveries(organisation_id,repository_id,security_domain_id,consumer_id,state,lease_expires_at,event_id);
CREATE TABLE hyperfide.source_event_inbox (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 consumer_id uuid NOT NULL, event_id uuid NOT NULL, result jsonb NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,consumer_id,event_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,consumer_id,event_id) REFERENCES hyperfide.source_event_deliveries
);
CREATE FUNCTION hyperfide.source_metadata_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable native source metadata' USING ERRCODE='23514'; END $$;
CREATE TRIGGER source_revisions_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_revisions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_revision_parents_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_revision_parents FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_change_revisions_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_change_revisions FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_events_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_events FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE FUNCTION hyperfide.source_operation_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state<>'PENDING' OR ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.principal_id,OLD.operation_id,OLD.action,OLD.idempotency_key,OLD.request_digest,OLD.created_at)
 IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.principal_id,NEW.operation_id,NEW.action,NEW.idempotency_key,NEW.request_digest,NEW.created_at)
 THEN RAISE EXCEPTION 'native source operation identity/result is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_operation_transition BEFORE UPDATE ON hyperfide.source_metadata_operations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_operation_transition();
CREATE TRIGGER source_operation_delete_guard BEFORE DELETE ON hyperfide.source_metadata_operations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE TRIGGER source_inbox_immutable BEFORE UPDATE OR DELETE ON hyperfide.source_event_inbox FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE FUNCTION hyperfide.source_repository_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.organisation_id,OLD.repository_id,OLD.security_domain_id,OLD.created_at) IS DISTINCT FROM ROW(NEW.organisation_id,NEW.repository_id,NEW.security_domain_id,NEW.created_at)
 OR NEW.authority_epoch<OLD.authority_epoch
 OR ROW(OLD.policy_version,OLD.durability_profile) IS DISTINCT FROM ROW(NEW.policy_version,NEW.durability_profile) AND NEW.authority_epoch<=OLD.authority_epoch
 THEN RAISE EXCEPTION 'source authority changes require an advancing epoch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_repository_transition BEFORE UPDATE ON hyperfide.source_repositories FOR EACH ROW EXECUTE FUNCTION hyperfide.source_repository_transition();
DO $$
DECLARE table_name text;
BEGIN
 FOREACH table_name IN ARRAY ARRAY['source_repositories','source_revisions','source_revision_parents','source_change_revisions','source_metadata_operations','source_events','source_event_consumers','source_event_deliveries','source_event_inbox']
 LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',table_name); END LOOP;
END $$;
