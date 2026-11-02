CREATE TABLE hyperfide.source_native_objects (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 object_id text NOT NULL CHECK(object_id ~ '^sha256:[0-9a-f]{64}$'),
 kind text NOT NULL CHECK(kind IN ('blob','chunk','file','tree-leaf','tree-index','manifest','revision')),
 size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 0 AND 8388608),
 tree_prefix text,
 state text NOT NULL CHECK(state IN ('UPLOADING','VERIFIED','QUARANTINED','DELETE_PENDING','ABSENT')),
 generation bigint NOT NULL DEFAULT 1 CHECK(generation>0), current_incarnation uuid NOT NULL,
 CHECK((kind IN ('tree-leaf','tree-index') AND (state<>'VERIFIED' OR tree_prefix IS NOT NULL)) OR (kind NOT IN ('tree-leaf','tree-index') AND tree_prefix IS NULL)),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,object_id)
) PARTITION BY HASH(object_id);
DO $$ BEGIN FOR n IN 0..15 LOOP EXECUTE format('CREATE TABLE hyperfide.source_native_objects_p%s PARTITION OF hyperfide.source_native_objects FOR VALUES WITH (MODULUS 16, REMAINDER %s)',n,n); END LOOP; END $$;
CREATE TABLE hyperfide.source_object_placements (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 object_id text NOT NULL, incarnation_id uuid NOT NULL, generation bigint NOT NULL CHECK(generation>0),
 storage_key text NOT NULL, state text NOT NULL CHECK(state IN ('UPLOADING','VERIFIED','QUARANTINED','DELETE_PENDING','ABSENT')),
 verified_at timestamptz,
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id) REFERENCES hyperfide.source_native_objects,
 UNIQUE(storage_key)
);
CREATE TABLE hyperfide.source_object_uploads (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 upload_id uuid NOT NULL, operation_id uuid NOT NULL, owner_principal_id uuid, object_id text NOT NULL, incarnation_id uuid NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^sha256:[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'UPLOADING' CHECK(status IN ('UPLOADING','UNKNOWN','VERIFIED')),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
 backend_upload_id text, multipart_parts jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,upload_id),
 UNIQUE(organisation_id,repository_id,security_domain_id,operation_id),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) REFERENCES hyperfide.source_object_placements
);
CREATE TABLE hyperfide.source_object_pins (
 organisation_id uuid NOT NULL, repository_id uuid NOT NULL, security_domain_id uuid NOT NULL,
 object_id text NOT NULL, incarnation_id uuid NOT NULL,
 owner_kind text NOT NULL CHECK(owner_kind IN ('OBJECT','REVISION','UPLOAD','READ','WORKSPACE','HOLD')),
 owner_id text NOT NULL, position integer NOT NULL CHECK(position>=0), expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,repository_id,security_domain_id,owner_kind,owner_id,position),
 FOREIGN KEY(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) REFERENCES hyperfide.source_object_placements
);
CREATE INDEX source_object_pins_target ON hyperfide.source_object_pins(organisation_id,repository_id,security_domain_id,object_id,incarnation_id);
CREATE INDEX source_object_uploads_pending ON hyperfide.source_object_uploads(status,expires_at) WHERE status<>'VERIFIED';
CREATE FUNCTION hyperfide.source_storage_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text;
BEGIN
 FOREACH field IN ARRAY TG_ARGV LOOP
  IF to_jsonb(OLD)->field IS DISTINCT FROM to_jsonb(NEW)->field THEN
   RAISE EXCEPTION 'Immutable source storage identity changed' USING ERRCODE='23514';
  END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_source_identity BEFORE UPDATE ON hyperfide.source_native_objects FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','object_id','kind','size_bytes');
CREATE TRIGGER immutable_source_placement BEFORE UPDATE ON hyperfide.source_object_placements FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','object_id','incarnation_id','generation','storage_key');
CREATE TRIGGER immutable_source_upload BEFORE UPDATE ON hyperfide.source_object_uploads FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','upload_id','operation_id','owner_principal_id','object_id','incarnation_id','request_digest');
CREATE TRIGGER immutable_source_pin BEFORE UPDATE ON hyperfide.source_object_pins FOR EACH ROW
 EXECUTE FUNCTION hyperfide.source_storage_immutable('organisation_id','repository_id','security_domain_id','object_id','incarnation_id','owner_kind','owner_id','position');

DO $guard$
BEGIN
 IF to_regprocedure('hyperfide.require_authority_isolation()') IS NULL THEN
  EXECUTE $definition$CREATE FUNCTION hyperfide.require_authority_isolation() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $body$
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','serializable') THEN
  RAISE EXCEPTION 'authority writes require READ COMMITTED or SERIALIZABLE' USING ERRCODE='25001';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $body$$definition$;
 END IF;
END $guard$;
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_native_objects FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_object_placements FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_object_uploads FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.source_object_pins FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();

CREATE FUNCTION hyperfide.source_tree_prefix_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.tree_prefix IS NOT NULL AND OLD.tree_prefix IS DISTINCT FROM NEW.tree_prefix THEN
  RAISE EXCEPTION 'Verified native tree prefix cannot change' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_source_tree_prefix BEFORE UPDATE ON hyperfide.source_native_objects FOR EACH ROW EXECUTE FUNCTION hyperfide.source_tree_prefix_immutable();
