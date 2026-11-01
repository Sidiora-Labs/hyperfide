#!/usr/bin/env python3
"""Signed reconciliation and real pinned Blaxel SDK GETs preserve abandoned CREATE identity and exact holds."""
import copy
import concurrent.futures
import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
spec = importlib.util.spec_from_file_location('absence_provider_fixture', ROOT / 'tests/hyperfide/cases/tasks/8_3.py')
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def uid():
    return str(uuid.uuid4())


def digest(value):
    return provider.sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


class ReadOnlyHTTP:
    def __init__(self):
        self.models = {}
        self.events = []
        self.lock = threading.RLock()
        self.post_entered = threading.Event()
        self.post_resume = threading.Event()
        self.paused_name = None
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_args):
                pass

            def route(self):
                path = unquote(urlsplit(self.path).path)
                raw = self.rfile.read(int(self.headers.get('content-length', '0')))
                model = json.loads(raw) if raw else None
                with owner.lock:
                    owner.events.append({'method': self.command, 'path': path, 'original_origin': self.headers.get('x-hf-original-origin')})
                    status, body = owner.models.get(path.rsplit('/', 1)[-1], (400, {'error': 'Unconfigured SDK path'}))
                if self.command == 'POST' and model and model.get('metadata', {}).get('name') == owner.paused_name:
                    owner.post_entered.set()
                    if not owner.post_resume.wait(20):
                        status, body = 503, {'error': 'Paused original POST was not resumed'}
                    else:
                        status, body = 200, {**model, 'status': 'RUNNING'}
                elif self.command != 'GET' or '/sandboxes/' not in path:
                    status, body = 405, {'error': 'Only read-only GET or explicit paused original fixture POST permitted'}
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(data)))
                self.send_header('Connection', 'close')
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PUT = do_DELETE = do_PATCH = route

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.endpoint = 'http://127.0.0.1:' + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main():
    http = ReadOnlyHTTP()
    names = ['absent', 'unavailable', 'present', 'wrong-account', 'wrong-boot', 'historical-unproven', 'inflight']

    def setup(f):
        declared = provider.prepared.Fixture(f.path / 'declared-blaxel-profile').create()
        declared['profile']['image']['provider'] = 'blaxel'
        declared['profile']['resources']['disk_bytes'] = '4294967296'
        declared.pop('digest')
        declared['digest'] = digest(declared)
        f.preparation, f.profile = declared['digest'], uid()
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'blaxel','linux-amd64',$4)", [f.ids['organisation'], f.profile, f.preparation, declared])
        f.pools = {name: uid() for name in names}
        f.seed_reference = 'sandbox/component:' + 'a' * 64
        f.adapter_policy = {'schema_version': 1, 'lifecycle': {'schema_version': 1, 'run_seconds': 3600, 'checkpoint_lead_seconds': 60, 'termination_grace_seconds': 10, 'api_wait_seconds': 5, 'process': {'keep_alive': True, 'timeout_seconds': 0}, 'expiration_policies': [], 'runtime_ttl': None, 'runtime_expires_at': None}, 'network_mode': 'ISOLATED', 'network': {}, 'volumes': [], 'runtime_extra_args': {}, 'runtime_env_refs': {}, 'preparation_seed_reference': f.seed_reference}
        adapter_file = f.path / 'blaxel-adapter.json'
        adapter_file.write_text(json.dumps({'schema_version': 1, 'profiles': [{'routing': {'organisation_id': f.ids['organisation'], 'pool_id': pool, 'provider_account_id': 'absence-fixture-account', 'environment_id': 'absence-fixture-workspace', 'region': 'us-pdx-1'}, 'body': f.adapter_policy} for pool in f.pools.values()]}))
        adapter_file.chmod(0o600)
        f.env['HF_BLAXEL_ADAPTER_CONFIG'] = str(adapter_file)
        limits = {'SANDBOX': '100', 'PROVISIONING': '10', 'CPU_MILLIS': '200000', 'MEMORY_BYTES': '429496729600', 'DISK_BYTES': '3221225472000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'READ_ONLY_ORIGINAL_CREATE_COMPONENT', 'accounts': [{'provider': 'blaxel', 'account_key': 'absence-fixture-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': pool, 'provider': 'blaxel', 'account_key': 'absence-fixture-account', 'environment_key': 'absence-fixture-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': f.seed_reference, 'adapter_policy_digest': digest(f.adapter_policy), 'network': 'ISOLATED', 'stdin_required': False}} for pool in f.pools.values()], 'maximum_operation_ms': 5000}
        file = f.path / 'absence-pools.json'
        file.write_text(json.dumps(f.config))
        file.chmod(0o600)
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        f.env.update(HYPERFIDE_POOL_CONFIG=str(file), HF_CREDENTIAL_CONFIG_FILE=str(credentials), NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=http.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='read-only-http-fixture-no-live-authority', HF_BLAXEL_WORKSPACE='absence-fixture-workspace', HF_BLAXEL_ACCOUNT_ID='absence-fixture-account')

    try:
        f = provider.pools.ProvisionerFixture(extra_components=component_closure(['8.3', '10.3']), extra_setup=setup)
    except BaseException:
        http.close()
        raise
    try:
        i = f.ids
        common = [i['organisation'], i['run']]
        stopped = f.invoke('provider.worker.stop', {}, component='8.3', key='provisioner')[1]
        assert stopped.get('ok'), stopped
        cases = {}
        quantities = {'SANDBOX': '1', 'CPU_MILLIS': '2000', 'MEMORY_BYTES': '4294967296', 'DISK_BYTES': '4294967296'}
        for name in names:
            pool = next(pool for pool in f.config['pools'] if pool['id'] == f.pools[name])
            configuration = digest({'revision': f.config['revision'], 'pool': pool, 'account': f.config['accounts'][0]})
            scope = {'organisation_id': i['organisation'], 'pool_id': pool['id'], 'provider': 'blaxel', 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': configuration}
            f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'blaxel',$3,$4,$5,$6)", [i['organisation'], pool['id'], pool['account_key'], pool['environment_key'], pool['region'], f.profile])
            f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], pool['id'], configuration, json.dumps({'scope': scope, 'pool': pool, 'account': f.config['accounts'][0]})])
            sandbox, intent = uid(), uid()
            f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,desired_state,observed_state,boot_generation) VALUES($1,$2,$3,'RUNNING','UNKNOWN',$4)", [i['organisation'], sandbox, pool['id'], 1])
            operation_scope = copy.deepcopy(scope)
            if name == 'wrong-account':
                operation_scope['provider_account_id'] = 'different-private-account'
            original = {'schema_version': 1, 'kind': 'create', 'scope': operation_scope, 'deadline_at': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'identity': {'operation_id': intent, 'idempotency_key': intent, 'correlation_id': intent, 'causation_id': intent, 'payload_digest': provider.sha(b'pending')}, 'resource': None, 'preparation_digest': f.preparation, 'parameters': {'preparation_reference': f.seed_reference, 'resources': {'cpu_millis': 2000, 'memory_bytes': '4294967296', 'disk_bytes': '4294967296', 'persistent_volume_bytes': '0'}, 'network': 'ISOLATED', 'stdin_required': False}}
            normalize = "import fs from'node:fs';import{operationPayloadDigest,validateProviderOperation}from'./core/control-plane/dist/providers/contract.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);validateProviderOperation(op);console.log(JSON.stringify(op));"
            normalized = subprocess.run(['node', '--input-type=module', '-e', normalize], input=json.dumps(original), text=True, capture_output=True, cwd=ROOT, env=f.env, timeout=15)
            assert normalized.returncode == 0, normalized.stderr
            original = json.loads(normalized.stdout)
            request_digest = digest({'controlled_original_request': intent})
            f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,failure_code,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$10,$11,'RECORDED',NULL,1)", common + [intent, pool['id'], sandbox, configuration, f.profile, intent, request_digest, original['identity']['payload_digest'], json.dumps(original)])
            reservations = []
            for dimension, quantity in quantities.items():
                account, reservation = uid(), uid()
                reserved = int(quantity) + (2 if name == 'absent' and dimension == 'SANDBOX' else 0)
                f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,reserved,provenance_digest,qualification_state) VALUES($1,$2,$3,$4,'PHYSICAL',$5,$6,$7,'QUALIFIED')", [i['organisation'], account, pool['id'], dimension, str(reserved * 10), str(reserved), provider.sha(b'controlled held-vector prerequisite')])
                f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour','PROVISIONING')", common + [reservation, uid(), account, quantity])
                f.sql('INSERT INTO hyperfide.provisioning_intent_reservations(organisation_id,run_id,intent_id,reservation_id) VALUES($1,$2,$3,$4)', common + [intent, reservation])
                reservations.append(reservation)
                if name == 'absent' and dimension == 'SANDBOX':
                    unrelated = uid()
                    f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,2,clock_timestamp()+interval '1 hour','RELEASE_PENDING')", common + [unrelated, uid(), account])
            native = 'hf-' + digest({'scope': original['scope'], 'operation_id': intent, 'generation': '1'})[7:47]
            http.models[native] = (503, {'error': 'Controlled provider unavailable'}) if name == 'unavailable' else (200, {'metadata': {'name': native}, 'status': 'RUNNING'}) if name == 'present' else (404, {'error': 'Controlled actual HTTP absence'})
            cases[name] = {'intent': intent, 'sandbox': sandbox, 'pool': pool['id'], 'reservations': reservations, 'original': original, 'native': native, 'resolution': None}

        def identity(case):
            return f.sql('SELECT to_jsonb(i) AS row FROM hyperfide.provisioning_intents i WHERE id=$1', [case['intent']])

        def holds(case):
            return f.sql('SELECT r.id::text,r.state,r.quantity::text,r.state_version::text,a.dimension,a.reserved::text,a.allocated::text FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.id=ANY($1::uuid[]) ORDER BY r.id', [case['reservations']])

        def audit(case):
            return f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.provider_resolutions r WHERE id=$1', [case['resolution']])

        def reconcile(case):
            return f.invoke('provider.intents.reconcile', {'intent_id': case['intent']}, component='8.3', key='provisioner', timeout_seconds=30)[1]

        def classify(case):
            f.sql("UPDATE hyperfide.provisioning_intents SET state='QUARANTINED',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [i['organisation'], case['intent']])
            response = f.invoke('provider.intents.resolve-quarantine', {'intent_id': case['intent'], 'resolution': 'RELEASE', 'reason': 'Controlled actual operator abandonment; capacity must await independent proof', 'evidence_digest': None}, component='8.3', key='operator')[1]
            assert response.get('ok'), response
            case['resolution'] = response['result']['resolution_id']

        for name in ['absent', 'unavailable', 'present', 'wrong-boot']:
            case = cases[name]
            final_model = http.models[case['native']]
            http.models[case['native']] = (503, {'error': 'Actual SDK create pre-POST lookup unavailable'})
            executed = f.invoke('provider.intents.execute', {'intent_id': case['intent']}, component='8.3', key='provisioner', timeout_seconds=30)[1]
            assert executed.get('ok') and executed['result']['executed'] is True, executed
            observed = f.sql("SELECT observation FROM hyperfide.provider_observations WHERE organisation_id=$1 AND intent_id=$2 AND observation->'operation'->>'kind'='create' ORDER BY observed_at", [i['organisation'], case['intent']])
            assert observed and observed[-1]['observation']['outcome']['status'] == 'UNKNOWN' and observed[-1]['observation']['outcome']['resource'] is None and observed[-1]['observation']['outcome']['error']['provider_code'] == 'BLAXEL_LOOKUP_HTTP_503', observed
            classify(case)
            http.models[case['native']] = final_model
        for name in ['wrong-account', 'historical-unproven']:
            classify(cases[name])
        f.sql('UPDATE hyperfide.sandboxes SET boot_generation=2,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], cases['wrong-boot']['sandbox']])
        inflight = cases['inflight']
        http.models[inflight['native']] = (404, {'error': 'Original lookup absence before explicitly paused POST'})
        http.paused_name = inflight['native']
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(f.invoke, 'provider.intents.execute', {'intent_id': inflight['intent']}, component='8.3', key='provisioner', timeout_seconds=30)
            try:
                assert http.post_entered.wait(10), 'Original SDK POST did not reach owned pause boundary'
                classify(inflight)
                before_holds, before_audit, event_count = holds(inflight), audit(inflight), len(http.events)
                refused = reconcile(inflight)
                assert refused.get('error', {}).get('code') == 'PROVIDER_CREATE_QUIESCENCE_UNPROVEN', refused
                assert len(http.events) == event_count and holds(inflight) == before_holds and audit(inflight) == before_audit
            finally:
                http.post_resume.set()
            late = pending.result(timeout=15)
            assert late[1].get('ok'), late
        event_count = len(http.events)
        refused = reconcile(inflight)
        assert refused.get('error', {}).get('code') == 'PROVIDER_CREATE_QUIESCENCE_UNPROVEN' and len(http.events) == event_count and holds(inflight) == before_holds, refused
        checks = []
        for name in ['unavailable', 'present', 'wrong-account', 'wrong-boot', 'historical-unproven']:
            case = cases[name]
            before, before_audit, before_holds, event_count = identity(case), audit(case), holds(case), len(http.events)
            response = reconcile(case)
            if name in ['wrong-account', 'wrong-boot', 'historical-unproven']:
                assert response.get('error', {}).get('code') == ('PROVIDER_ABSENCE_SCOPE_CHANGED' if name == 'wrong-boot' else 'PROVIDER_CREATE_QUIESCENCE_UNPROVEN'), (name, response)
                assert len(http.events) == event_count, (name, http.events[event_count:])
            else:
                assert response.get('ok') and response['result']['reconciled'] is False and response['result']['absence_authorized'] is False, (name, response)
                assert http.events[event_count:] and all(event['method'] == 'GET' and event['path'].endswith('/sandboxes/' + case['native']) for event in http.events[event_count:])
            assert identity(case) == before and audit(case) == before_audit and holds(case) == before_holds, name
            checks.append(name + ' preserves original intent, administrative audit and four physical holds')
        case = cases['absent']
        before, before_audit, before_holds = identity(case), audit(case), holds(case)
        unrelated_before = f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE id=$1', [unrelated])
        event_count = len(http.events)
        response = reconcile(case)
        assert response.get('ok') and response['result']['confirmed_absence_released'] is True and response['result']['reconciled'] is True, response
        assert identity(case) == before and audit(case) == before_audit
        released = holds(case)
        assert len(released) == 4 and all(row['state'] == 'RELEASED' and row['allocated'] == '0' and row['reserved'] == ('2' if row['dimension'] == 'SANDBOX' else '0') for row in released), released
        assert f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE id=$1', [unrelated]) == unrelated_before
        proof = f.sql('SELECT observation,evidence_digest FROM hyperfide.provider_observations WHERE organisation_id=$1 AND intent_id=$2 ORDER BY observed_at', [i['organisation'], case['intent']])
        proof = [row for row in proof if row['observation'].get('recovery', {}).get('kind') == 'REJECTED_CREATE_ABSENCE_V1']
        assert len(proof) == 1, proof
        body = proof[0]['observation']
        assert body['recovery']['quiescence']['id'] and body['recovery']['quiescence']['digest'], body
        assert body['recovery']['kind'] == 'REJECTED_CREATE_ABSENCE_V1' and body['recovery']['intent_id'] == case['intent']
        assert body['operation']['scope'] == case['original']['scope'] and body['operation']['identity']['correlation_id'] == case['intent'] and body['operation']['resource'] == {'native_sandbox_id': case['native'], 'sandbox_boot_generation': '1'}, body
        assert body['outcome']['status'] == 'SUCCEEDED' and body['outcome']['acceptance'] == 'CONFIRMED_ACCEPTED' and body['outcome']['result'] == {'provider_state': 'DESTROYED', 'health': 'ABSENT'}, body
        assert digest(body) == proof[0]['evidence_digest']
        releases = f.sql("SELECT idempotency_key,result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='scheduler.reservation.release' AND idempotency_key=ANY($3::text[]) ORDER BY idempotency_key", common + [case['reservations']])
        assert len(releases) == 4 and all(row['result']['released'] is True and row['result']['proof_source'] == 'provider.absence' for row in releases), releases
        assert http.events[event_count:] and all(event['method'] == 'GET' and event['path'].endswith('/sandboxes/' + case['native']) for event in http.events[event_count:])
        events_after = len(http.events)
        proofs_after = f.sql('SELECT observation,evidence_digest FROM hyperfide.provider_observations WHERE organisation_id=$1 AND intent_id=$2 ORDER BY observed_at', [i['organisation'], case['intent']])
        replay = reconcile(case)
        assert replay.get('ok') and holds(case) == released and identity(case) == before and audit(case) == before_audit, replay
        assert len(http.events) == events_after and f.sql('SELECT observation,evidence_digest FROM hyperfide.provider_observations WHERE organisation_id=$1 AND intent_id=$2 ORDER BY observed_at', [i['organisation'], case['intent']]) == proofs_after
        assert sum(event['method'] == 'POST' for event in http.events) == 1 and all(event['method'] in ['GET', 'POST'] and event['original_origin'] == 'https://api.blaxel.ai' for event in http.events), http.events
        checks.extend(['actual original CREATE SDK lookup503 supplies trusted pre-POST completion evidence', 'paused original POST and late presence never permit a concurrent absence release', 'actual pinned SDK HTTP404 retains immutable original-scope absence proof and releases exactly four linked holds', 'REJECTED/OPERATOR_RELEASED/null native identity and administrative resolution remain unchanged', 'unrelated reservation and its accounting remain held', 'reconciliation replay reuses proof without network or duplicate release'])
        print(json.dumps({'status': 'PASS', 'scope': 'signed provider reconciliation and actual PostgreSQL with real pinned SDK routed to independent read-only HTTP fixture', 'recovery_provider_mutations': 0, 'controlled_original_fixture_posts': 1, 'live_qualification': 'NOT_CLAIMED', 'checks': checks, 'http_events': http.events, 'absence_proof': proof[0], 'released_vector': released}))
    finally:
        try:
            f.close()
        finally:
            http.close()


if __name__ == '__main__':
    main()
