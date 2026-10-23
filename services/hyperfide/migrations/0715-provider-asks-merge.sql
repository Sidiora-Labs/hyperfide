-- Provider resolution Asks join the asks store (hyperfide-v21 3.23). Overdue
-- orphans and QUARANTINED intents are now raised as decision Asks in
-- hyperfide.asks through the human.ask.raise path, so human.ask.list, the
-- deadline sweep and every Ask surface see them; human.ask.answer applies the
-- operator's answer to the provider inventory. This table carries what the
-- generic Ask head cannot: the provider subject an Ask is about and, once
-- settled, the provider_resolutions row that settled it.
CREATE TABLE hyperfide.provider_resolution_ask_links (
 organisation_id uuid NOT NULL,
 ask_id uuid NOT NULL,
 subject_key text NOT NULL CHECK(length(subject_key) BETWEEN 1 AND 512),
 subject_kind text NOT NULL CHECK(subject_kind IN ('ORPHAN','INTENT')),
 pool_id uuid NOT NULL,
 native_sandbox_id text,
 intent_id uuid,
 window_seconds integer NOT NULL CHECK(window_seconds>0),
 subject_since timestamptz NOT NULL,
 -- The 0708 provider_resolution_asks row this Ask replaced, for Asks copied below.
 migrated_from uuid,
 resolution_id uuid,
 linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,ask_id),
 FOREIGN KEY(organisation_id,ask_id) REFERENCES hyperfide.asks(organisation_id,id),
 FOREIGN KEY(organisation_id,pool_id) REFERENCES hyperfide.provider_pools(organisation_id,id),
 FOREIGN KEY(organisation_id,intent_id) REFERENCES hyperfide.provisioning_intents(organisation_id,id),
 FOREIGN KEY(organisation_id,resolution_id) REFERENCES hyperfide.provider_resolutions(organisation_id,id),
 FOREIGN KEY(organisation_id,migrated_from) REFERENCES hyperfide.provider_resolution_asks(organisation_id,id),
 CHECK(subject_kind<>'ORPHAN' OR (native_sandbox_id IS NOT NULL AND intent_id IS NULL)),
 CHECK(subject_kind<>'INTENT' OR (intent_id IS NOT NULL AND native_sandbox_id IS NULL))
);
CREATE INDEX provider_resolution_ask_links_subject ON hyperfide.provider_resolution_ask_links(organisation_id,subject_key);
CREATE INDEX provider_resolution_ask_links_pool ON hyperfide.provider_resolution_ask_links(organisation_id,pool_id,linked_at);
CREATE UNIQUE INDEX provider_resolution_ask_links_migrated ON hyperfide.provider_resolution_ask_links(organisation_id,migrated_from) WHERE migrated_from IS NOT NULL;

-- A link names its subject for life; the settling resolution is written once.
CREATE FUNCTION hyperfide.provider_resolution_ask_link_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'provider Ask links are durable' USING ERRCODE='23514'; END IF;
 IF OLD.resolution_id IS NOT NULL AND NEW.resolution_id IS DISTINCT FROM OLD.resolution_id THEN
  RAISE EXCEPTION 'a provider Ask is settled by one resolution' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_resolution_ask_links FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE TRIGGER provider_resolution_ask_link_identity BEFORE UPDATE ON hyperfide.provider_resolution_ask_links FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','ask_id','subject_key','subject_kind','pool_id','native_sandbox_id','intent_id','window_seconds','subject_since','migrated_from','linked_at');
CREATE TRIGGER provider_resolution_ask_link_settle BEFORE UPDATE OR DELETE ON hyperfide.provider_resolution_ask_links FOR EACH ROW EXECUTE FUNCTION hyperfide.provider_resolution_ask_link_guard();

-- Copy every open 0708 Ask into hyperfide.asks with the decision policy of
-- ASK_POLICY revision v21-3.6.1 (proceed-and-flag, 14400 s, chain operator).
-- The deadline counts from this migration, not the original raise, so a copied
-- Ask is not expired by the sweep before an operator has seen it. Its run is
-- the intent's run, or for an orphan the run of the credential that raised it;
-- a row whose raiser is no longer known has no run to list it under and stays
-- in the old table only. The id is derived from the old row so a re-run copies
-- nothing twice.
INSERT INTO hyperfide.asks(organisation_id,id,run_id,kind,title,body,options,recommended,deadline,default_policy,chain,raised_by,raised_at)
SELECT a.organisation_id,md5('hyperfide.provider-resolution-ask:'||a.organisation_id||':'||a.id)::uuid,COALESCE(i.run_id,p.run_id),'decision',a.title,
 'Provider '||lower(a.subject_kind)||' '||a.subject_key||' unresolved since '||a.subject_since||' (policy window '||a.window_seconds||' s); copied from provider_resolution_asks '||a.id||'.'||
 COALESCE((SELECT string_agg(E'\n'||(o->>'id')||': '||COALESCE(o->>'effect',''),'' ORDER BY n) FROM jsonb_array_elements(a.options) WITH ORDINALITY AS e(o,n)),''),
 jsonb_path_query_array(a.options,'$[*].id'),a.recommended,GREATEST(a.raised_at,clock_timestamp())+interval '14400 seconds','proceed-and-flag','["operator"]'::jsonb,
 a.raised_by_credential_id,a.raised_at
FROM hyperfide.provider_resolution_asks a
LEFT JOIN hyperfide.provisioning_intents i ON i.organisation_id=a.organisation_id AND i.id=a.intent_id
LEFT JOIN hyperfide.identity_principals p ON p.credential_id=a.raised_by_credential_id AND p.organisation_id=a.organisation_id
WHERE a.state='OPEN' AND COALESCE(i.run_id,p.run_id) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM hyperfide.asks x WHERE x.organisation_id=a.organisation_id AND x.id=md5('hyperfide.provider-resolution-ask:'||a.organisation_id||':'||a.id)::uuid);
INSERT INTO hyperfide.provider_resolution_ask_links(organisation_id,ask_id,subject_key,subject_kind,pool_id,native_sandbox_id,intent_id,window_seconds,subject_since,migrated_from)
SELECT a.organisation_id,x.id,a.subject_key,a.subject_kind,a.pool_id,a.native_sandbox_id,a.intent_id,a.window_seconds,a.subject_since,a.id
FROM hyperfide.provider_resolution_asks a
JOIN hyperfide.asks x ON x.organisation_id=a.organisation_id AND x.id=md5('hyperfide.provider-resolution-ask:'||a.organisation_id||':'||a.id)::uuid
WHERE a.state='OPEN'
ON CONFLICT DO NOTHING;

-- The 0708 table is read-only history from here on: new provider Asks are
-- raised only into hyperfide.asks, and an old row is never answered in place.
CREATE FUNCTION hyperfide.reject_legacy_provider_ask_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'provider_resolution_asks is read-only history; provider Asks live in hyperfide.asks (migration 0715)' USING ERRCODE='23514'; END $$;
CREATE TRIGGER provider_resolution_asks_read_only BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_resolution_asks FOR EACH ROW EXECUTE FUNCTION hyperfide.reject_legacy_provider_ask_write();
CREATE TRIGGER provider_resolution_asks_no_truncate BEFORE TRUNCATE ON hyperfide.provider_resolution_asks FOR EACH STATEMENT EXECUTE FUNCTION hyperfide.reject_legacy_provider_ask_write();
