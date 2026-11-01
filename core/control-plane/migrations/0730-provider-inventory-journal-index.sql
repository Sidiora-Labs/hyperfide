-- Indexed read-only receipt history; full JSON loads only for each selected native proof.

CREATE INDEX command_inventory_latest ON hyperfide.command_inbox(organisation_id,
 ((result->'observation'->'scope'->>'provider')),((result->'observation'->'scope'->>'provider_account_id')),
 ((result->'observation'->'scope'->>'environment_id')),((result->'observation'->>'native_sandbox_id')),((result->'observation'->>'observed_at')) DESC,created_at DESC)
 WHERE principal_scope='PROVISIONER_INVENTORY' AND operation='provider.inventory.observe' AND state='COMPLETED' AND result->'observation'->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1';

CREATE INDEX command_inventory_presence ON hyperfide.command_inbox(organisation_id,
 ((result->'observation'->'scope'->>'provider')),((result->'observation'->'scope'->>'provider_account_id')),
 ((result->'observation'->'scope'->>'environment_id')),((result->'observation'->>'native_sandbox_id')),((result->'observation'->>'observed_at')) DESC,created_at DESC)
 WHERE principal_scope='PROVISIONER_INVENTORY' AND operation='provider.inventory.observe' AND state='COMPLETED' AND result->'observation'->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND result->'observation'->>'presence' IN('PRESENT','ABSENT');

CREATE INDEX command_inventory_foreign ON hyperfide.command_inbox(organisation_id,
 ((result->'observation'->'scope'->>'provider')),((result->'observation'->'scope'->>'provider_account_id')),
 ((result->'observation'->'scope'->>'environment_id')),((result->'observation'->>'native_sandbox_id')),((result->'observation'->>'observed_at')) DESC,created_at DESC)
 WHERE principal_scope='PROVISIONER_INVENTORY' AND operation='provider.inventory.observe' AND state='COMPLETED' AND result->'observation'->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND result->'observation'->>'classification'='FOREIGN';

CREATE INDEX provider_inventory_latest ON hyperfide.provider_observations(organisation_id,
 ((observation->'scope'->>'provider')),((observation->'scope'->>'provider_account_id')),
 ((observation->'scope'->>'environment_id')),((observation->>'native_sandbox_id')),observed_at DESC,created_at DESC)
 WHERE observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1';

CREATE INDEX provider_inventory_presence ON hyperfide.provider_observations(organisation_id,
 ((observation->'scope'->>'provider')),((observation->'scope'->>'provider_account_id')),
 ((observation->'scope'->>'environment_id')),((observation->>'native_sandbox_id')),observed_at DESC,created_at DESC)
 WHERE observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND observation->>'presence' IN('PRESENT','ABSENT');

CREATE INDEX provider_inventory_foreign ON hyperfide.provider_observations(organisation_id,
 ((observation->'scope'->>'provider')),((observation->'scope'->>'provider_account_id')),
 ((observation->'scope'->>'environment_id')),((observation->>'native_sandbox_id')),observed_at DESC,created_at DESC)
 WHERE observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND observation->>'classification'='FOREIGN';

CREATE FUNCTION hyperfide.retain_provider_inventory_observation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,hyperfide AS $$
BEGIN
 RAISE EXCEPTION 'Provider inventory observations are append-only' USING ERRCODE='23000';
END $$;
CREATE TRIGGER retain_provider_inventory_observation
 BEFORE UPDATE OR DELETE ON hyperfide.command_inbox FOR EACH ROW
 WHEN (OLD.principal_scope='PROVISIONER_INVENTORY' AND OLD.operation='provider.inventory.observe')
 EXECUTE FUNCTION hyperfide.retain_provider_inventory_observation();
