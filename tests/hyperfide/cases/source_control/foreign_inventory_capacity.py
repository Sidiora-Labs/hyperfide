#!/usr/bin/env python3
"""Actual signed inventory attribution and capacity accounting over pinned SDK HTTP metadata."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
spec = importlib.util.spec_from_file_location('foreign_sdk_http_fixture', ROOT / 'tests/hyperfide/cases/source_control/blaxel_rejected_create_absence.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
provider = fixture.provider


def uid():
    return str(uuid.uuid4())


def digest(value):
    return fixture.digest(value)


def separate_accounting(f, http, api, refresh, capacity, sandbox, scopes):
    org, run = f.ids['organisation'], f.ids['run']
    scope = scopes[f.other_pool]
    configured = api('provider.pools.configure', {}, key='operator', component='8.2')
    assert configured.get('ok'), configured
    normal = api('provider.intents.reconcile', {'intent_id': f.intent})
    assert normal.get('ok') and normal['result']['candidate_count'] == 0, normal
    assert refresh()['inventory_attribution']['FOREIGN'] == 15
    before = capacity(f.other_pool)
    dimension = sandbox(before)
    assert before['accounting_mode'] == 'SEPARATE_FLEET_BUDGET_PROVIDER_QUOTA' and before['unknown_resource_capacity'] is False, before
    assert dimension['used_account'] == '16' and dimension['budget_used_account'] == '1' and dimension['used_pool'] == '0', dimension
    assert dimension['provider_quota']['configured'] is True and dimension['provider_quota']['limit'] is None, dimension

    def retained_provenance(label):
        body = ('Controlled component capacity declaration: ' + label + '; accounting policy ' + f.env['HF_PROVIDER_ACCOUNTING_POLICY_DIGEST'] + '; no live quota authority.').encode()
        artifact, sha = uid(), provider.sha(body)
        path = f.path / (artifact + '.txt')
        path.write_bytes(body)
        f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,$5,'COMPONENT_FIXTURE',$6,'COMPLETE',clock_timestamp())", [org, run, artifact, sha, str(len(body)), str(path)])
        return {'run_id': run, 'artifact_id': artifact, 'digest': sha}

    def attest(rows, proof, ttl=3600):
        stamp = lambda delta: time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + delta))
        declarations = []
        for pool, kind, key, name, limit, domain in rows:
            declarations.append({'id': uid(), 'pool_id': pool, 'configuration_digest': scopes[pool]['configuration_digest'], 'scope_kind': kind, 'scope_key': key, 'dimension': name, 'limit': limit, 'declared_at': stamp(-1), 'expires_at': stamp(ttl), 'provenance': proof, **({'capacity_domain': domain} if domain else {})})
        f.declarations.write_text(json.dumps({'schema_version': 1, 'organisation_id': org, 'attestations': declarations}))
        f.declarations.chmod(0o600)
        answer = api('provider.pools.attest-capacity', {}, key='operator', component='8.2')
        assert answer.get('ok') and answer['result']['recorded'] == len(rows) and answer['result']['free_inventory_granted'] is False, answer
        return [row['id'] for row in declarations]

    old = retained_provenance('untyped managed fleet account2 and pool1')
    vector = {'SANDBOX': '1', 'CPU_MILLIS': '2000', 'MEMORY_BYTES': '4294967296', 'DISK_BYTES': '32212254720'}
    limits = f.config['accounts'][0]['approved_limits']
    managed_rows = []
    for name in [*vector, 'PROVISIONING']:
        managed_rows.append((f.other_pool, 'ACCOUNT', scope['provider_account_id'], name, limits[name], None))
        managed_rows.append((f.other_pool, 'POOL', f.other_pool, name, '1' if name == 'SANDBOX' else limits[name], None))
    old_ids = attest(managed_rows, old)
    qualified = capacity(f.other_pool)
    assert sandbox(qualified)['qualified'] is True and sandbox(qualified)['provider_quota']['limit'] is None, qualified
    assert sandbox(qualified)['budgets'][0]['capacity_limit'] == '2', qualified
    physical = []
    for name, quantity in vector.items():
        account = f.sql("SELECT id FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension=$3 AND capacity_class='PHYSICAL' AND resource_key=''", [org, f.other_pool, name])
        assert len(account) == 1, account
        aid = account[0]['id']
        f.sql("UPDATE hyperfide.capacity_accounts SET configured_limit=$3,reserved=$4,qualification_state='QUALIFIED',provenance_digest=$5,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [org, aid, str(int(quantity) * 100), quantity, old['digest']])
        reservation = uid()
        f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')", [org, run, reservation, uid(), aid, quantity])
        physical.append(reservation)

    def request(reservations):
        return {'run_id': run, 'pool_id': f.other_pool, 'sandbox_id': uid(), 'request_key': uid(), 'deadline_at': provider.utc(), 'reservation_ids': reservations, 'profile_id': f.profile, 'preparation_digest': f.preparation, 'purpose': 'PREPARATION'}

    def refused(value, code):
        before_count = f.sql('SELECT count(*)::text AS n FROM hyperfide.provisioning_intents WHERE organisation_id=$1', [org])
        answer = api('provider.intents.prepare-create', value)
        assert answer.get('error', {}).get('code') == code, answer
        assert f.sql('SELECT count(*)::text AS n FROM hyperfide.provisioning_intents WHERE organisation_id=$1', [org]) == before_count

    value = request(physical)
    refused(value, 'QUOTA_UNQUALIFIED')
    small_proof = retained_provenance('explicit insufficient provider quota16')
    small_ids = attest([(f.other_pool, 'ACCOUNT', scope['provider_account_id'], 'SANDBOX', '16', 'PROVIDER_QUOTA')], small_proof, ttl=5)
    refused(value, 'PROVIDER_QUOTA_EXCEEDED')
    time.sleep(6)
    expired_quota = sandbox(capacity(f.other_pool))
    assert expired_quota['provider_quota']['limit'] is None, expired_quota
    quota_proof = retained_provenance('explicit generic provider quota1000')
    quota_ids = attest([(f.other_pool, 'ACCOUNT', scope['provider_account_id'], 'SANDBOX', '1000', 'PROVIDER_QUOTA')], quota_proof)
    ready = capacity(f.other_pool)
    assert ready['unknown_resource_capacity'] is False, ready
    d = sandbox(ready)
    assert d['budget_used_account'] == '2' and d['used_account'] == '17' and d['provider_quota']['limit'] == '1000' and d['provider_quota']['used'] == '17' and d['provider_quota']['vector_complete'] is True and d['provider_quota']['remaining_inventory_authority'] is False, d
    assert d['budgets'][0]['approved_limit'] == '2' and d['budgets'][0]['used'] == '2' and next(b for b in d['budgets'] if b['scope'] == 'POOL')['approved_limit'] == '1', d
    admitted = api('provider.intents.prepare-create', value)
    assert admitted.get('ok') and admitted['result']['created'] is True and admitted['result']['external_call_performed'] is False, {'admitted': admitted, 'capacity_before': ready}
    second = []
    for name, quantity in vector.items():
        aid = f.sql("SELECT id FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension=$3 AND capacity_class='PHYSICAL' AND resource_key=''", [org, f.other_pool, name])[0]['id']
        f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$3::numeric,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [org, aid, quantity])
        rid = uid()
        f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')", [org, run, rid, uid(), aid, quantity])
        second.append(rid)
    refused(request(second), 'OPERATING_BUDGET_EXCEEDED')
    retained = f.sql("SELECT id,declaration->>'capacity_domain' AS domain,declaration->>'limit' AS limit FROM hyperfide.provider_capacity_attestations WHERE organisation_id=$1 ORDER BY id", [org])
    assert all(next(row for row in retained if row['id'] == aid)['domain'] is None for aid in old_ids)
    assert all(next(row for row in retained if row['id'] == aid)['domain'] == 'PROVIDER_QUOTA' for aid in quota_ids + small_ids)
    assert all(event['method'] == 'GET' for event in http.events), http.events
    print(json.dumps({'status': 'PASS', 'scope': 'separate managed fleet budget and retained provider quota, actual signed CREATE preparation; controlled declarations only', 'provider_mutations': 0, 'live_quota_qualification': 'NOT_CLAIMED', 'checks': ['untyped retained ACCOUNT2 is managed budget and never provider quota', 'missing explicit quota refuses before intent insertion', 'explicit provider quota16 refuses shared usage17', 'retained typed quota1000 permits owned1 plus new1 under managed ACCOUNT2 and pool1 despite foreign15', 'unknown foreign CPU and disk do not block configured SANDBOX-only quota', 'third internal sandbox refuses without increasing ACCOUNT2/pool1', 'typed provider quota provenance retained separately from untyped ledger'], 'admitted_capacity': d, 'admitted_intent': admitted['result']['intent']['id']}))


def main(separate=False):
    http = fixture.ReadOnlyHTTP()
    catalog = []
    original_route = http.server.RequestHandlerClass.route

    def route(handler):
        path = urlsplit(handler.path).path.rstrip('/')
        if handler.command == 'GET' and path.endswith('/sandboxes'):
            with http.lock:
                http.events.append({'method': 'GET', 'path': path, 'original_origin': handler.headers.get('x-hf-original-origin')})
            data = json.dumps(catalog).encode()
            handler.send_response(200)
            handler.send_header('Content-Type', 'application/json')
            handler.send_header('Content-Length', str(len(data)))
            handler.end_headers()
            handler.wfile.write(data)
            return
        return original_route(handler)

    http.server.RequestHandlerClass.route = route
    http.server.RequestHandlerClass.do_GET = route
    marker = 'component-owner-' + uuid.uuid4().hex
    owner_id, identity_label = 'component-foreign', 'component-owner-id'
    foreign_names = ['resource-' + uuid.uuid4().hex[:24] for _ in range(15)]
    unknown_names = {kind: 'resource-' + uuid.uuid4().hex[:24] for kind in ['unmarked', 'unknown-owner', 'conflicting-hf', 'failed-get']}
    known_name = 'hf-' + uuid.uuid4().hex

    def setup(f):
        manifest = provider.prepared.Fixture(f.path / 'declared-inventory-profile').create()
        manifest['profile']['image']['provider'] = 'blaxel'
        manifest.pop('digest')
        manifest['digest'] = digest(manifest)
        f.profile, f.pool, f.other_pool, f.intent, f.sandbox = [uid() for _ in range(5)]
        f.preparation = manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'blaxel','linux-amd64',$4)", [f.ids['organisation'], f.profile, f.preparation, manifest])
        limits = {'SANDBOX': '2', 'PROVISIONING': '2', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'SHARED_ACCOUNT_INVENTORY_COMPONENT', 'accounts': [{'provider': 'blaxel', 'account_key': 'inventory-component-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': pool, 'provider': 'blaxel', 'account_key': 'inventory-component-account', 'environment_key': 'inventory-component-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': 'DECLARED_NOT_PROVISIONED', 'network': 'ISOLATED', 'stdin_required': False, 'inventory_namespace': {'schema_version': 1, 'kind': 'HYPERFIDE_SCOPE_LABEL', 'name_prefix': 'hf-'}}} for pool in [f.pool, f.other_pool]], 'maximum_operation_ms': 60000}
        adapter_policy = {'schema_version': 1, 'lifecycle': {'schema_version': 1, 'run_seconds': 3600, 'checkpoint_lead_seconds': 60, 'termination_grace_seconds': 10, 'api_wait_seconds': 5, 'process': {'keep_alive': True, 'timeout_seconds': 0}, 'expiration_policies': [], 'runtime_ttl': None, 'runtime_expires_at': None}, 'network_mode': 'ISOLATED', 'network': {}, 'volumes': [], 'runtime_extra_args': {}, 'runtime_env_refs': {}, 'preparation_seed_reference': 'DECLARED_NOT_PROVISIONED'}
        adapter_file = f.path / 'blaxel-adapter.json'
        adapter_file.write_text(json.dumps({'schema_version': 1, 'profiles': [{'routing': {'organisation_id': f.ids['organisation'], 'pool_id': pool, 'provider_account_id': 'inventory-component-account', 'environment_id': 'inventory-component-workspace', 'region': 'us-pdx-1'}, 'body': adapter_policy} for pool in [f.pool, f.other_pool]]}))
        adapter_file.chmod(0o600)
        f.env['HF_BLAXEL_ADAPTER_CONFIG'] = str(adapter_file)
        for pool in f.config['pools']:
            pool['create_policy']['adapter_policy_digest'] = digest(adapter_policy)
        if separate:
            f.config['pools'][1]['environment_key'] = 'inventory-component-second-workspace'
            for pool in f.config['pools']:
                pool['approved_limits'] = {**limits, 'SANDBOX': '1'}
                pool['planning_limits'] = dict(pool['approved_limits'])
            accounting = {'schema_version': 1, 'provider': 'blaxel', 'provider_account_id': 'inventory-component-account', 'mode': 'SEPARATE_FLEET_BUDGET_PROVIDER_QUOTA', 'provider_quota_dimensions': ['SANDBOX']}
            accounting_file = f.path / 'accounting-policy.json'
            accounting_bytes = json.dumps(accounting, sort_keys=True, separators=(',', ':')).encode()
            accounting_file.write_bytes(accounting_bytes)
            accounting_file.chmod(0o600)
            f.env['HF_PROVIDER_ACCOUNTING_POLICY_FILE'] = str(accounting_file)
            f.env['HF_PROVIDER_ACCOUNTING_POLICY_DIGEST'] = provider.sha(accounting_bytes)
            f.declarations = f.path / 'capacity-declarations.json'
            f.env['HYPERFIDE_CAPACITY_ATTESTATIONS'] = str(f.declarations)
        file = f.path / 'pools.json'
        file.write_text(json.dumps(f.config))
        file.chmod(0o600)
        policy = {'schema_version': 1, 'provider': 'blaxel', 'provider_account_id': 'inventory-component-account', 'environment_id': 'inventory-component-workspace', 'max_age_seconds': 3600 if separate else 20, 'owners': [{'owner_id': owner_id, 'labels': {'managed-by': marker}, 'identity_label': identity_label}]}
        f.policy_file = f.path / 'foreign-ownership.json'
        f.policy_bytes = json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()
        f.policy_file.write_bytes(f.policy_bytes)
        f.policy_file.chmod(0o600)
        f.policy_digest = provider.sha(f.policy_bytes)
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        f.env.update(HYPERFIDE_POOL_CONFIG=str(file), HF_CREDENTIAL_CONFIG_FILE=str(credentials), HF_BLAXEL_FOREIGN_OWNERSHIP_CONFIG_FILE=str(f.policy_file), HF_BLAXEL_FOREIGN_OWNERSHIP_CONFIG_DIGEST=f.policy_digest, NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=http.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='controlled-inventory-no-live-authority', HF_BLAXEL_WORKSPACE='inventory-component-workspace', HF_BLAXEL_ACCOUNT_ID='inventory-component-account')

    f = None
    try:
        f = provider.pools.ProvisionerFixture(extra_components=component_closure(['8.3', '10.3']), extra_setup=setup)
        i = f.ids
        common = [i['organisation'], i['run']]
        assert f.invoke('provider.worker.stop', {}, component='8.3', key='provisioner')[1].get('ok')
        scopes = {}
        for pool in f.config['pools']:
            configuration = digest({'revision': f.config['revision'], 'pool': pool, 'account': f.config['accounts'][0]})
            scope = {'organisation_id': i['organisation'], 'pool_id': pool['id'], 'provider': 'blaxel', 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': configuration}
            scopes[pool['id']] = scope
            f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'blaxel',$3,$4,$5,$6)", [i['organisation'], pool['id'], pool['account_key'], pool['environment_key'], pool['region'], f.profile])
            f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], pool['id'], configuration, json.dumps({'scope': scope, 'pool': pool, 'account': f.config['accounts'][0]})])
        scope = scopes[f.pool]
        f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES($1,$2,$3,'UNKNOWN')", [i['organisation'], f.sandbox, f.pool])
        if not separate:
            f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state) VALUES($1,$2,$3,$4,'RUNNING')", [i['organisation'], uid(), f.other_pool, known_name])
        operation = {'schema_version': 1, 'kind': 'create', 'scope': scope, 'deadline_at': '2099-01-01T00:00:00.000Z', 'identity': {'operation_id': f.intent, 'idempotency_key': f.intent, 'correlation_id': f.intent, 'causation_id': f.intent, 'payload_digest': provider.sha(b'pending')}, 'resource': None, 'preparation_digest': f.preparation, 'parameters': {'preparation_reference': 'DECLARED_NOT_PROVISIONED', 'resources': {'cpu_millis': 2000, 'memory_bytes': '4294967296', 'disk_bytes': '4294967296', 'persistent_volume_bytes': '0'}, 'network': 'ISOLATED', 'stdin_required': False}}
        normalize = "import fs from'node:fs';import{operationPayloadDigest}from'./core/control-plane/dist/providers/contract.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);console.log(JSON.stringify(op));"
        normalized = subprocess.run(['node', '--input-type=module', '-e', normalize], input=json.dumps(operation), text=True, capture_output=True, cwd=ROOT, env=f.env, timeout=15)
        assert normalized.returncode == 0, normalized.stderr
        operation = json.loads(normalized.stdout)
        f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$10,$11,'UNKNOWN',1)", common + [f.intent, f.pool, f.sandbox, scope['configuration_digest'], f.profile, f.intent, provider.sha(b'controlled shared inventory intent'), operation['identity']['payload_digest'], json.dumps(operation)])

        def model(name, labels):
            return {'metadata': {'name': name, 'workspace': scope['environment_id'], 'labels': labels}, 'spec': {'region': scope['region'], 'runtime': {'memory': 4096}}, 'status': 'DEPLOYED'}

        for name in foreign_names:
            value = model(name, {'managed-by': marker, identity_label: uid()})
            catalog.append(value)
            http.models[name] = (200, value)
            for pool in ([f.pool] if separate else [f.pool, f.other_pool]):
                f.sql("INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id,suspected_intent_id) VALUES($1,$2,$3,$4)", [i['organisation'], pool, name, f.intent])
        for kind, name in ({} if separate else unknown_names).items():
            labels = {} if kind == 'unmarked' else {'managed-by': 'another-' + marker, identity_label: uid()} if kind == 'unknown-owner' else {'managed-by': marker, identity_label: uid(), 'hyperfide-operation': ''} if kind == 'conflicting-hf' else {'managed-by': marker, identity_label: uid()}
            value = model(name, labels)
            catalog.append(value)
            http.models[name] = (503, {'error': 'Controlled actual GET unavailable'}) if kind == 'failed-get' else (200, value)
        known_model = model(known_name, {'hyperfide-operation': uid(), 'hyperfide-scope': digest(scopes[f.other_pool]), 'hyperfide-boot': '1'})
        if not separate:
            catalog.append(known_model)
            http.models[known_name] = (200, known_model)

        def orphans(names=None):
            return f.sql('SELECT to_jsonb(o) AS row FROM hyperfide.provider_orphans o WHERE organisation_id=$1' + (' AND native_sandbox_id=ANY($2::text[])' if names else '') + ' ORDER BY pool_id,native_sandbox_id', [i['organisation']] + ([names] if names else []))

        def api(action, value, key='provisioner', component='8.3'):
            return f.invoke(action, value, key=key, component=component, timeout_seconds=90)[1]

        def refresh():
            response = api('provider.intents.reconcile', {'intent_id': f.intent, 'reconcile_inventory': True})
            assert response.get('ok') and response['result']['orphan_rows_rewritten'] is False and response['result']['capacity_released'] is False, response
            return response['result']

        def capacity(pool):
            response = api('provider.pools.capacity', {'pool_id': pool}, key='operator', component='8.2')
            assert response.get('ok'), response
            return response['result']

        def sandbox(report):
            return next(row for row in report['dimensions'] if row['name'] == 'SANDBOX')

        if separate:
            separate_accounting(f, http, api, refresh, capacity, sandbox, scopes)
            return
        legacy = orphans(foreign_names)
        response = api('provider.intents.reconcile', {'intent_id': f.intent})
        assert response.get('error', {}).get('code') == 'OWNERSHIP_PROBE_UNVERIFIED', {'response': response, 'actual_sdk_http_events': http.events, 'adapter_config_file': f.env.get('HF_BLAXEL_ADAPTER_CONFIG')}
        assert orphans(foreign_names) == legacy
        assert {row['row']['native_sandbox_id'] for row in orphans(list(unknown_names.values()))} == set(unknown_names.values())
        assert orphans([known_name]) == []
        assert not any(event['path'].endswith('/sandboxes/' + known_name) for event in http.events), http.events
        original_orphans = orphans()
        counted = refresh()['inventory_attribution']
        assert counted['FOREIGN'] == 15 and counted['UNKNOWN'] == 4, counted
        assert orphans() == original_orphans
        own, other = capacity(f.pool), capacity(f.other_pool)
        assert own['external_usage']['resources'] == 19 and own['external_usage']['classified_foreign'] == 15 and own['external_usage']['policy_digest'] == f.policy_digest
        assert {'CPU_MILLIS', 'DISK_BYTES'}.issubset(set(own['external_usage']['unknown_dimensions'])) and own['unknown_resource_capacity'] is True, own
        assert sandbox(own)['used_pool'] == '5' and sandbox(other)['used_pool'] == '1', (sandbox(own), sandbox(other))
        assert sandbox(own)['used_account'] == '21' and sandbox(own)['used_environment'] == '21', sandbox(own)
        assert next(b for b in sandbox(own)['budgets'] if b['scope'] == 'ACCOUNT')['approved_limit'] == '2'
        proofs = f.sql("SELECT observation,evidence_digest FROM hyperfide.provider_observations WHERE organisation_id=$1 AND observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1'", [i['organisation']])
        assert proofs and all(digest(row['observation']) == row['evidence_digest'] and row['observation']['policy_digest'] == f.policy_digest for row in proofs)
        assert all(row['observation']['foreign'] is None for row in proofs if row['observation']['classification'] == 'UNKNOWN')
        assert all(row['observation']['presence'] == 'PRESENT' and row['observation']['foreign']['resources'] == {'SANDBOX': '1', 'CPU_MILLIS': None, 'MEMORY_BYTES': '4294967296', 'DISK_BYTES': None} for row in proofs if row['observation']['classification'] == 'FOREIGN')
        checks = ['15 positively marked foreign resources are excluded from own pool legacy-orphan charges but shared account/environment charged once', 'unmarked, unknown-owner, conflicting hyperfide label and failed actual GET remain quarantined', 'known managed resource in another pool is never probed or duplicated as an orphan', 'legacy orphan rows remain byte-for-byte unchanged during typed attribution refresh', 'approved ACCOUNT sandbox limit2 unchanged while observed usage21 remains blocked/unknown for unmeasured CPU and disk']
        selected = foreign_names[0]
        original_model = copy.deepcopy(http.models[selected])
        changed = copy.deepcopy(original_model[1])
        changed['metadata']['labels'].pop('managed-by')
        http.models[selected] = (200, changed)
        assert refresh()['inventory_attribution']['FOREIGN'] == 14
        contradicted = capacity(f.pool)
        assert contradicted['external_usage']['resources'] == 19 and contradicted['external_usage']['classified_foreign'] == 14 and sandbox(contradicted)['used_pool'] == '6'
        http.models[selected] = (503, {'error': 'Controlled later metadata probe unavailable'})
        refresh()
        latest = f.sql("SELECT observation FROM hyperfide.provider_observations WHERE organisation_id=$1 AND observation->>'kind'='PROVIDER_INVENTORY_ATTRIBUTION_V1' AND observation->>'native_sandbox_id'=$2 ORDER BY observed_at DESC LIMIT 1", [i['organisation'], selected])[0]['observation']
        assert latest['classification'] == 'UNKNOWN' and latest['foreign'] is None and latest['probe_evidence_digest'] is None, latest
        assert capacity(f.pool)['external_usage']['classified_foreign'] == 14
        http.models[selected] = original_model
        refresh()
        assert capacity(f.pool)['external_usage']['classified_foreign'] == 15
        checks.append('new UNKNOWN or failed GET supersedes older FOREIGN proof; marked actual metadata can re-establish attribution')
        novel = 'resource-' + uuid.uuid4().hex[:24]
        novel_model = model(novel, {'managed-by': marker, identity_label: uid()})
        catalog.append(novel_model)
        http.models[novel] = (200, novel_model)
        discovered = api('provider.intents.reconcile', {'intent_id': f.intent})
        assert discovered.get('error', {}).get('code') == 'OWNERSHIP_PROBE_UNVERIFIED', discovered
        assert orphans([novel]) == [], 'Fresh foreign discovery must retain attribution without creating an orphan'
        assert orphans(foreign_names) == legacy
        original_orphans = orphans()
        assert refresh()['inventory_attribution']['FOREIGN'] == 16
        discovered_capacity = capacity(f.pool)
        assert discovered_capacity['external_usage']['classified_foreign'] == 16 and sandbox(discovered_capacity)['used_account'] == '22', discovered_capacity
        f.policy_file.write_bytes(f.policy_bytes + b' ')
        bad_policy = api('provider.pools.capacity', {'pool_id': f.pool}, key='operator', component='8.2')
        assert bad_policy.get('error', {}).get('code') == 'FOREIGN_INVENTORY_POLICY_INVALID', bad_policy
        f.policy_file.write_bytes(f.policy_bytes)
        assert orphans() == original_orphans
        time.sleep(21)
        expired = capacity(f.pool)
        assert expired['external_usage']['resources'] == 20 and expired['external_usage']['classified_foreign'] == 0 and sandbox(expired)['used_account'] == '22' and sandbox(expired)['used_pool'] == '20' and expired['unknown_resource_capacity'] is True, expired
        assert orphans() == original_orphans
        assert all(event['method'] == 'GET' for event in http.events), http.events
        checks.append('wrong current policy pin refuses; actual expiry restores pool quarantine while retaining deduplicated shared physical charges including a foreign resource with no orphan row')
        print(json.dumps({'status': 'PASS', 'scope': 'signed PostgreSQL inventory/capacity APIs and actual pinned SDK metadata GETs through independent HTTP boundary', 'provider_mutations': 0, 'placement_or_live_capacity_qualification': 'NOT_CLAIMED', 'checks': checks, 'positive_capacity': {'own': sandbox(own), 'other': sandbox(other), 'external_usage': own['external_usage']}, 'expired_capacity': {'sandbox': sandbox(expired), 'external_usage': expired['external_usage']}, 'http_gets': len(http.events)}))
    finally:
        if f:
            f.close()
        http.close()


if __name__ == '__main__':
    if sys.argv[1:] != ['--separate-only']:
        main()
    main(separate=True)
