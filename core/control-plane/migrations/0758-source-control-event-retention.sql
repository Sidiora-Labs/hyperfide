ALTER TABLE hyperfide.source_events ADD COLUMN creator_xid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX source_event_transaction_discovery ON hyperfide.source_events(organisation_id,repository_id,security_domain_id,creator_xid,event_id);
ALTER TABLE hyperfide.source_event_consumers
 ADD COLUMN authority_epoch bigint NOT NULL DEFAULT 1 CHECK(authority_epoch>0),
 ADD COLUMN state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN('ACTIVE','RESNAPSHOT_REQUIRED')),
 ADD COLUMN retention_max_events integer NOT NULL DEFAULT 10000 CHECK(retention_max_events BETWEEN 1 AND 100000),
 ADD COLUMN retention_expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
 ADD COLUMN retained_events integer NOT NULL DEFAULT 0 CHECK(retained_events>=0),
 ADD COLUMN resnapshot_reason text CHECK(resnapshot_reason IN('EVENT_BUDGET','RETENTION_EXPIRED')),
 ADD COLUMN previous_subscription_epoch uuid,
 ADD COLUMN snapshot_boundary pg_snapshot,
 ADD COLUMN boundary text NOT NULL DEFAULT 'REGISTERED' CHECK(boundary IN('REGISTERED','RESNAPSHOT'));
UPDATE hyperfide.source_event_consumers c SET retained_events=(SELECT count(*) FROM (SELECT 1 FROM hyperfide.source_event_deliveries d WHERE d.organisation_id=c.organisation_id AND d.repository_id=c.repository_id AND d.security_domain_id=c.security_domain_id AND d.consumer_id=c.consumer_id LIMIT 100001) bounded);
UPDATE hyperfide.source_event_consumers SET state='RESNAPSHOT_REQUIRED',resnapshot_reason='EVENT_BUDGET' WHERE retained_events>=retention_max_events;
CREATE INDEX source_event_consumer_retention ON hyperfide.source_event_consumers(organisation_id,repository_id,security_domain_id,state,retention_expires_at);

UPDATE hyperfide.source_event_consumers c SET authority_epoch=r.authority_epoch FROM hyperfide.source_repositories r WHERE r.organisation_id=c.organisation_id AND r.repository_id=c.repository_id AND r.security_domain_id=c.security_domain_id;
DROP TRIGGER source_inbox_immutable ON hyperfide.source_event_inbox;
CREATE TRIGGER source_inbox_immutable_update BEFORE UPDATE ON hyperfide.source_event_inbox FOR EACH ROW EXECUTE FUNCTION hyperfide.source_metadata_immutable();
CREATE FUNCTION hyperfide.source_event_retired_inbox_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hyperfide.source_event_consumers WHERE organisation_id=OLD.organisation_id AND repository_id=OLD.repository_id AND security_domain_id=OLD.security_domain_id AND consumer_id=OLD.consumer_id AND state='RESNAPSHOT_REQUIRED' FOR SHARE)
 THEN RAISE EXCEPTION 'active subscription inbox is immutable' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER source_inbox_retired_delete BEFORE DELETE ON hyperfide.source_event_inbox FOR EACH ROW EXECUTE FUNCTION hyperfide.source_event_retired_inbox_delete();
