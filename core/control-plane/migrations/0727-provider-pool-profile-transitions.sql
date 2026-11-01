CREATE TABLE hyperfide.provider_pool_profile_transitions (
 organisation_id uuid NOT NULL,pool_id uuid NOT NULL,id uuid NOT NULL,
 run_id uuid NOT NULL,previous_state_version bigint NOT NULL CHECK(previous_state_version>0),
 old_profile_id uuid,old_profile_digest hyperfide.digest,new_profile_id uuid NOT NULL,new_profile_digest hyperfide.digest NOT NULL,
 old_configuration_digest hyperfide.digest NOT NULL,new_configuration_digest hyperfide.digest NOT NULL,
 actor_credential_id uuid NOT NULL,actor_role text NOT NULL CHECK(actor_role IN('OPERATOR','PROVISIONER')),
 operation_id uuid NOT NULL,payload_digest hyperfide.digest NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organisation_id,id),UNIQUE(organisation_id,pool_id,previous_state_version),
 FOREIGN KEY(organisation_id,pool_id) REFERENCES hyperfide.provider_pools(organisation_id,id),
 FOREIGN KEY(organisation_id,old_profile_id) REFERENCES hyperfide.environment_profiles(organisation_id,id),
 FOREIGN KEY(organisation_id,new_profile_id) REFERENCES hyperfide.environment_profiles(organisation_id,id),
 FOREIGN KEY(organisation_id,run_id) REFERENCES hyperfide.runs(organisation_id,id),
 FOREIGN KEY(actor_credential_id) REFERENCES hyperfide.identity_principals(credential_id),
 FOREIGN KEY(organisation_id,pool_id,old_configuration_digest) REFERENCES hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest),
 FOREIGN KEY(organisation_id,pool_id,new_configuration_digest) REFERENCES hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest)
);
CREATE FUNCTION hyperfide.retain_pool_profile_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'pool profile transition history is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER retained_transition BEFORE UPDATE OR DELETE ON hyperfide.provider_pool_profile_transitions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.retain_pool_profile_transition();
CREATE TRIGGER aaa_supported_isolation BEFORE INSERT OR UPDATE OR DELETE ON hyperfide.provider_pool_profile_transitions
 FOR EACH ROW EXECUTE FUNCTION hyperfide.require_authority_isolation();
CREATE FUNCTION hyperfide.pool_rejected_create_closed(org uuid,intent uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,hyperfide AS $$
 SELECT EXISTS(SELECT 1 FROM hyperfide.provisioning_intents i WHERE i.organisation_id=org AND i.id=intent AND i.kind='CREATE' AND i.state='REJECTED' AND i.native_sandbox_id IS NULL
 AND i.failure_code IN('NEVER_SUBMITTED_EXPIRED','PROVIDER_CREATE_REJECTED')
 AND EXISTS(SELECT 1 FROM hyperfide.provisioning_intent_reservations l WHERE l.organisation_id=i.organisation_id AND l.run_id=i.run_id AND l.intent_id=i.id)
 AND NOT EXISTS(SELECT 1 FROM hyperfide.provisioning_intent_reservations l JOIN hyperfide.reservations r ON r.organisation_id=l.organisation_id AND r.run_id=l.run_id AND r.id=l.reservation_id JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id
  WHERE l.organisation_id=i.organisation_id AND l.run_id=i.run_id AND l.intent_id=i.id AND (r.state<>'RELEASED' OR r.attempt_id IS NOT NULL OR a.pool_id<>i.pool_id OR a.capacity_class<>'PHYSICAL' OR NOT EXISTS(
   SELECT 1 FROM hyperfide.command_inbox n WHERE n.organisation_id=i.organisation_id AND n.run_id=i.run_id AND n.principal_scope='scheduler-resources' AND n.operation='scheduler.reservation.release' AND n.idempotency_key=r.id::text AND n.state='COMPLETED' AND n.result->>'released'='true'
   AND ((i.failure_code='NEVER_SUBMITTED_EXPIRED' AND r.release_reason='NEVER_SUBMITTED_EXPIRED' AND n.result->>'proof_source'='provider.never-submitted' AND n.result->>'proof_id'=i.id::text)
    OR (i.failure_code='PROVIDER_CREATE_REJECTED' AND r.release_reason='PROVIDER_CREATE_REJECTED' AND n.result->>'proof_source'='provider.rejection' AND EXISTS(
     SELECT 1 FROM hyperfide.provider_observations o WHERE o.organisation_id=i.organisation_id AND o.intent_id=i.id AND o.id::text=n.result->>'proof_id' AND o.observation->'operation'=i.operation AND o.observation->'outcome'->'resource'='null'::jsonb
     AND ((o.observation->'outcome'->>'status'='UNKNOWN' AND o.observation->'outcome'->>'acceptance'='UNKNOWN' AND o.observation->'outcome'->'error'->>'provider_code'='BLAXEL_CREATE_HTTP_400') OR
      (o.observation->'outcome'->>'status'='FAILED' AND o.observation->'outcome'->>'acceptance'='CONFIRMED_REJECTED' AND o.observation->'outcome'->'error'->>'provider_code' ~ '^BLAXEL_CREATE_HTTP_4[0-9]{2}$' AND o.observation->'outcome'->'error'->>'provider_code' NOT IN('BLAXEL_CREATE_HTTP_408','BLAXEL_CREATE_HTTP_409','BLAXEL_CREATE_HTTP_425','BLAXEL_CREATE_HTTP_429'))))))))));
$$;
CREATE FUNCTION hyperfide.assert_pool_profile_quiescent(org uuid,pool uuid) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM hyperfide.provider_orphans orphan WHERE orphan.organisation_id=org AND orphan.pool_id=pool AND NOT EXISTS(
  SELECT 1 FROM hyperfide.provisioning_intents i JOIN hyperfide.provider_observations observed ON observed.organisation_id=i.organisation_id AND observed.intent_id=i.id
  JOIN hyperfide.provider_pools actual_pool ON actual_pool.organisation_id=i.organisation_id AND actual_pool.id=i.pool_id
  WHERE orphan.state='DELETED' AND observed.observed_at>=orphan.last_observed_at AND i.organisation_id=org AND i.pool_id=pool AND i.native_sandbox_id=orphan.native_sandbox_id AND i.state='TERMINAL'
  AND (orphan.suspected_intent_id IS NULL OR EXISTS(SELECT 1 FROM hyperfide.provisioning_intents suspected WHERE suspected.organisation_id=org AND suspected.id=orphan.suspected_intent_id AND suspected.pool_id=pool AND suspected.boot_generation=i.boot_generation))
  AND observed.observation->'operation'->>'kind'='observe' AND observed.observation->'operation'->'scope'->>'pool_id'=pool::text
  AND observed.observation->'operation'->'scope'->>'provider'=actual_pool.provider AND observed.observation->'operation'->'scope'->>'provider_account_id'=actual_pool.account_key
  AND observed.observation->'operation'->'scope'->>'environment_id'=actual_pool.environment_key AND observed.observation->'operation'->'scope'->>'region'=actual_pool.region
  AND observed.observation->'operation'->'scope'->>'configuration_digest'=i.configuration_digest
  AND observed.observation->'outcome'->>'status'='SUCCEEDED' AND observed.observation->'outcome'->>'acceptance'='CONFIRMED_ACCEPTED'
  AND observed.observation->'outcome'->'result'->>'provider_state'='DESTROYED' AND observed.observation->'outcome'->'result'->>'health'='ABSENT'
  AND observed.observation->'outcome'->'resource'->>'native_sandbox_id'=orphan.native_sandbox_id AND observed.observation->'outcome'->'resource'->>'sandbox_boot_generation'=i.boot_generation::text)) OR
 EXISTS(SELECT 1 FROM hyperfide.capacity_accounts WHERE organisation_id=org AND pool_id=pool AND (reserved<>0 OR allocated<>0)) OR
 EXISTS(SELECT 1 FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE a.organisation_id=org AND a.pool_id=pool AND r.state<>'RELEASED') OR
 EXISTS(SELECT 1 FROM hyperfide.provisioning_intents WHERE organisation_id=org AND pool_id=pool AND (state NOT IN('TERMINAL','REJECTED') OR kind='CREATE' AND state='REJECTED' AND NOT hyperfide.pool_rejected_create_closed(org,id))) OR
 EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations o JOIN hyperfide.sandboxes s ON s.organisation_id=o.organisation_id AND s.id=o.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND (o.state<>'OBSERVED' OR COALESCE(o.outcome->>'status','UNKNOWN')='UNKNOWN')) OR
 EXISTS(SELECT 1 FROM hyperfide.attempts a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND a.compute_authority='CURRENT') OR
 EXISTS(SELECT 1 FROM hyperfide.agent_sessions a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND a.state IN('REGISTERED','RUNNING','DISCONNECTED')) OR
 EXISTS(SELECT 1 FROM hyperfide.runner_workspaces w JOIN hyperfide.sandboxes s ON s.organisation_id=w.organisation_id AND s.id=w.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND w.state<>'FREE') OR
 EXISTS(SELECT 1 FROM hyperfide.worker_slots w JOIN hyperfide.sandboxes s ON s.organisation_id=w.organisation_id AND s.id=w.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND w.state='ALLOCATED') OR
 EXISTS(SELECT 1 FROM hyperfide.resource_job_allocations a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND a.state<>'RELEASED') OR
 EXISTS(SELECT 1 FROM hyperfide.slot_allocations a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND a.state<>'RELEASED') OR
 EXISTS(SELECT 1 FROM hyperfide.sandbox_execution_charges a JOIN hyperfide.sandboxes s ON s.organisation_id=a.organisation_id AND s.id=a.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND a.state<>'RELEASED') OR
 EXISTS(SELECT 1 FROM hyperfide.identity_enrollment_grants g JOIN hyperfide.sandboxes s ON s.organisation_id=g.organisation_id AND s.id=g.sandbox_id WHERE s.organisation_id=org AND s.pool_id=pool AND g.state='ISSUED' AND g.expires_at>clock_timestamp()) OR
 EXISTS(SELECT 1 FROM hyperfide.sandboxes s WHERE s.organisation_id=org AND s.pool_id=pool AND
  NOT ((s.native_sandbox_id IS NULL AND EXISTS(SELECT 1 FROM hyperfide.provisioning_intents i WHERE i.organisation_id=s.organisation_id AND i.sandbox_id=s.id AND i.boot_generation=s.boot_generation AND i.kind='CREATE' AND i.state='REJECTED' AND hyperfide.pool_rejected_create_closed(org,i.id)))
   OR (s.native_sandbox_id IS NOT NULL AND s.observed_state='DESTROYED' AND EXISTS(SELECT 1 FROM hyperfide.provisioning_intents i JOIN hyperfide.provider_observations o ON o.organisation_id=i.organisation_id AND o.intent_id=i.id JOIN hyperfide.provider_pools actual_pool ON actual_pool.organisation_id=i.organisation_id AND actual_pool.id=i.pool_id WHERE i.organisation_id=s.organisation_id AND i.sandbox_id=s.id AND i.boot_generation=s.boot_generation AND i.native_sandbox_id=s.native_sandbox_id AND i.state='TERMINAL' AND i.pool_id=pool AND o.observation->'operation'->'scope'->>'provider'=actual_pool.provider AND o.observation->'operation'->'scope'->>'provider_account_id'=actual_pool.account_key AND o.observation->'operation'->'scope'->>'environment_id'=actual_pool.environment_key AND o.observation->'operation'->'scope'->>'region'=actual_pool.region AND o.observation->'operation'->'scope'->>'configuration_digest'=i.configuration_digest AND o.observation->'operation'->>'kind'='observe' AND o.observation->'operation'->'scope'->>'pool_id'=pool::text AND o.observation->'outcome'->>'status'='SUCCEEDED' AND o.observation->'outcome'->>'acceptance'='CONFIRMED_ACCEPTED' AND o.observation->'outcome'->'result'->>'provider_state'='DESTROYED' AND o.observation->'outcome'->'result'->>'health'='ABSENT' AND o.observation->'outcome'->'resource'->>'native_sandbox_id'=s.native_sandbox_id AND o.observation->'outcome'->'resource'->>'sandbox_boot_generation'=s.boot_generation::text))))
 THEN RAISE EXCEPTION 'pool profile transition requires quiescent released resources' USING ERRCODE='23514'; END IF;
END $$;
DROP TRIGGER immutable_binding ON hyperfide.provider_pools;
CREATE TRIGGER immutable_binding BEFORE UPDATE ON hyperfide.provider_pools FOR EACH ROW EXECUTE FUNCTION hyperfide.immutable_fields('organisation_id','id','provider','account_key','environment_key','region');
CREATE FUNCTION hyperfide.guard_pool_profile_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
DECLARE admitted boolean;
BEGIN
 IF NEW.profile_id IS NOT DISTINCT FROM OLD.profile_id THEN RETURN NEW; END IF;
 IF OLD.state<>'ACTIVE' OR NEW.state IS DISTINCT FROM OLD.state OR NEW.state_version<>OLD.state_version+1 THEN RAISE EXCEPTION 'pool profile transition version mismatch' USING ERRCODE='23514'; END IF;
 PERFORM hyperfide.assert_pool_profile_quiescent(OLD.organisation_id,OLD.id);
 SELECT true INTO admitted FROM hyperfide.provider_pool_profile_transitions t
 JOIN hyperfide.provider_pool_configurations pc ON pc.organisation_id=t.organisation_id AND pc.pool_id=t.pool_id AND pc.configuration_digest=t.new_configuration_digest AND pc.active
 JOIN hyperfide.environment_profiles p ON p.organisation_id=t.organisation_id AND p.id=t.new_profile_id AND p.content_digest=t.new_profile_digest AND p.provider=OLD.provider
 JOIN hyperfide.identity_principals actor ON actor.credential_id=t.actor_credential_id AND actor.organisation_id=t.organisation_id AND actor.run_id=t.run_id AND actor.role=t.actor_role AND actor.state='ACTIVE' AND actor.expires_at>clock_timestamp() AND 'provider.pools.configure'=ANY(actor.allowed_actions)
 JOIN hyperfide.runs r ON r.organisation_id=actor.organisation_id AND r.id=actor.run_id AND r.authority_epoch=actor.deployment_epoch
 WHERE t.organisation_id=OLD.organisation_id AND t.pool_id=OLD.id AND t.previous_state_version=OLD.state_version
 AND t.old_profile_id IS NOT DISTINCT FROM OLD.profile_id AND t.new_profile_id=NEW.profile_id
 AND (t.old_profile_id IS NULL OR EXISTS(SELECT 1 FROM hyperfide.environment_profiles oldp WHERE oldp.organisation_id=t.organisation_id AND oldp.id=t.old_profile_id AND oldp.content_digest=t.old_profile_digest))
 AND pc.document->'pool'->>'profile_id'=NEW.profile_id::text AND pc.document->'pool'->>'preparation_digest'=t.new_profile_digest;
 IF admitted IS NOT TRUE THEN RAISE EXCEPTION 'pool profile transition lacks exact admitted history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guarded_profile_transition BEFORE UPDATE ON hyperfide.provider_pools FOR EACH ROW EXECUTE FUNCTION hyperfide.guard_pool_profile_transition();
