ALTER TABLE hyperfide.source_native_objects ADD COLUMN gc_partition smallint GENERATED ALWAYS AS (get_byte(decode(substr(object_id,8,2),'hex'),0)%16) STORED;
CREATE INDEX source_native_gc_discovery ON hyperfide.source_native_objects(organisation_id,repository_id,security_domain_id,gc_partition,state,created_at,object_id);
CREATE INDEX source_object_pins_expiry ON hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,expires_at);
CREATE TABLE hyperfide.source_retention_policies (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 generation bigint NOT NULL CHECK(generation>0),minimum_age_seconds integer NOT NULL CHECK(minimum_age_seconds BETWEEN 0 AND 31536000),
 quarantine_seconds integer NOT NULL CHECK(quarantine_seconds BETWEEN 0 AND 31536000),backup_until timestamptz NOT NULL,
 backend_identity text NOT NULL,independent_expiration boolean NOT NULL CHECK(NOT independent_expiration),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id)
);
CREATE TABLE hyperfide.source_collection_work (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 object_id text NOT NULL,incarnation_id uuid NOT NULL,generation bigint NOT NULL,partition smallint NOT NULL CHECK(partition BETWEEN 0 AND 15),
 operation_id uuid NOT NULL,storage_key text NOT NULL,size_bytes bigint NOT NULL,
 policy_generation bigint NOT NULL,state text NOT NULL CHECK(state IN ('QUARANTINED','DELETE_PENDING','ABSENT','RESCUED')),
 eligible_at timestamptz NOT NULL,quarantined_at timestamptz NOT NULL DEFAULT clock_timestamp(),attempts integer NOT NULL DEFAULT 0,last_outcome text,last_attempt_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id),UNIQUE(operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) REFERENCES hyperfide.source_object_placements
);
CREATE INDEX source_collection_ready ON hyperfide.source_collection_work(organisation_id,repository_id,security_domain_id,partition,state,eligible_at,object_id);
CREATE TABLE hyperfide.source_retention_roots (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 root_id uuid NOT NULL,owner_kind text NOT NULL CHECK(owner_kind IN ('WORKSPACE','CUSTODY','CANDIDATE','EVIDENCE','IMPORT','EXPORT','BACKUP','HOLD')),
 owner_id text NOT NULL,object_id text NOT NULL,incarnation_id uuid NOT NULL,expires_at timestamptz,state text NOT NULL CHECK(state IN ('ACTIVE','RELEASED')),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,root_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) REFERENCES hyperfide.source_object_placements
);
CREATE TABLE hyperfide.source_child_reservations (
 organisation_id uuid NOT NULL,repository_id uuid NOT NULL,security_domain_id uuid NOT NULL,
 reservation_id uuid NOT NULL,parent_object_id text NOT NULL,parent_incarnation_id uuid NOT NULL,
 child_object_id text NOT NULL,child_incarnation_id uuid NOT NULL,position integer NOT NULL CHECK(position>=0),
 state text NOT NULL CHECK(state IN ('RESERVED','ADOPTED','RELEASED')),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,reservation_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,parent_object_id,parent_incarnation_id,position),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,parent_object_id,parent_incarnation_id) REFERENCES hyperfide.source_object_placements,
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,child_object_id,child_incarnation_id) REFERENCES hyperfide.source_object_placements
);
CREATE FUNCTION hyperfide.source_pin_generation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE object_state text; current_id uuid; placement_state text; placement_verified boolean;
BEGIN
 SELECT state,current_incarnation INTO object_state,current_id FROM hyperfide.source_native_objects WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND object_id=NEW.object_id FOR UPDATE;
 SELECT state,verified_at IS NOT NULL INTO placement_state,placement_verified FROM hyperfide.source_object_placements WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND object_id=NEW.object_id AND incarnation_id=NEW.incarnation_id FOR UPDATE;
 IF current_id IS DISTINCT FROM NEW.incarnation_id OR object_state IN ('DELETE_PENDING','ABSENT') OR placement_state IN ('DELETE_PENDING','ABSENT') OR (NEW.owner_kind<>'UPLOAD' AND (((object_state='QUARANTINED' OR placement_state='QUARANTINED') AND NOT placement_verified) OR object_state NOT IN ('VERIFIED','QUARANTINED') OR placement_state NOT IN ('VERIFIED','QUARANTINED'))) THEN RAISE EXCEPTION 'Source pin generation is no longer referenceable' USING ERRCODE='23514'; END IF;
 IF object_state='QUARANTINED' THEN
  UPDATE hyperfide.source_native_objects SET state='VERIFIED' WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND object_id=NEW.object_id;
  UPDATE hyperfide.source_object_placements SET state='VERIFIED' WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND object_id=NEW.object_id AND incarnation_id=NEW.incarnation_id;
  UPDATE hyperfide.source_collection_work SET state='RESCUED',last_outcome='PIN_ACQUIRED' WHERE organisation_id=NEW.organisation_id AND repository_id=NEW.repository_id AND security_domain_id=NEW.security_domain_id AND object_id=NEW.object_id AND incarnation_id=NEW.incarnation_id AND state='QUARANTINED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_pin_fence BEFORE INSERT OR UPDATE ON hyperfide.source_object_pins FOR EACH ROW EXECUTE FUNCTION hyperfide.source_pin_generation_fence();
CREATE TRIGGER immutable_source_collection_identity BEFORE UPDATE ON hyperfide.source_collection_work FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','object_id','incarnation_id','generation','partition','operation_id','storage_key','size_bytes');
CREATE TRIGGER immutable_source_root_identity BEFORE UPDATE ON hyperfide.source_retention_roots FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','root_id','owner_kind','owner_id','object_id','incarnation_id');
CREATE TRIGGER immutable_source_reservation_identity BEFORE UPDATE ON hyperfide.source_child_reservations FOR EACH ROW EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','reservation_id','parent_object_id','parent_incarnation_id','child_object_id','child_incarnation_id','position');
DO $$ DECLARE name text;BEGIN FOREACH name IN ARRAY ARRAY['source_retention_policies','source_collection_work','source_retention_roots','source_child_reservations'] LOOP EXECUTE format('CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.%I FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation()',name);END LOOP;END $$;
