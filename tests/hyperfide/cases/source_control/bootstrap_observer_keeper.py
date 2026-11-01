#!/usr/bin/env python3
"""Actual signed keeper admission and SDK/Unix process boundary; original READY inputs are controlled prerequisites."""
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from source_archive_http_fixture import BlaxelHttpFixture
from fleet_archive_worker_fixture import NativeArchiveWorkerHandlers


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provider = load('daemon_provider_fixture', 'tests/hyperfide/cases/tasks/8_3.py')


def uid():
    return str(uuid.uuid4())


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def write(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    file.write_bytes(canonical(value))
    file.chmod(0o600)


def stable(seed):
    raw = bytearray(hashlib.sha256(seed.encode()).digest()[:16])
    raw[6] = (raw[6] & 15) | 64
    raw[8] = (raw[8] & 63) | 128
    return str(uuid.UUID(bytes=bytes(raw)))


def main():
    holder = {}
    entered, release_reply = threading.Event(), threading.Event()
    submissions = []

    def remote(value):
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts:
            raise PermissionError('Absolute owned guest path required')
        if holder.get('guest') and (path == holder['guest'] or holder['guest'] in path.parents):
            return path
        return holder['guest'] / str(path).lstrip('/')

    def processes(method, ident, body):
        result = holder['handlers'].process_handler(method, ident, body)
        if method == 'POST' and ident is None:
            submissions.append({'name': body['name'], 'command': body['command'], 'actual_status': result[0], 'keepAlive': body.get('keepAlive'), 'timeout': body.get('timeout')})
            entered.set()
            release_reply.wait(10)
            return 503, {'message': 'Controlled lost submit response after actual Unix keeper execution'}
        return result

    backend = BlaxelHttpFixture({'metadata': {'name': 'not-configured'}}, remote, processes)
    original_route = backend.server.RequestHandlerClass.route

    def route(handler):
        path = unquote(urlsplit(handler.path).path)
        if handler.command == 'PUT' and '/filesystem/' in path:
            value = json.loads(handler.rfile.read(int(handler.headers.get('content-length', '0'))))
            if value.get('isDirectory') is not True:
                return handler.send(405, {'message': 'Only owned directory creation admitted'})
            destination = remote('/' + path.split('/filesystem/', 1)[1].lstrip('/'))
            destination.mkdir(parents=True, exist_ok=True, mode=int(value.get('permissions', '0700'), 8))
            return handler.send(200, {'path': str(destination), 'isDirectory': True})
        return original_route(handler)

    backend.server.RequestHandlerClass.route = route
    sleeper = subprocess.Popen(['/usr/bin/sleep', '300'], start_new_session=True)
    node_source = Path(shutil.which('node')).resolve()
    node_bytes = node_source.read_bytes()
    node_pin = sha(node_bytes)

    def setup(f):
        holder['guest'] = f.path / 'guest'
        holder['guest'].mkdir(mode=0o700)
        f.node_path = holder['guest'] / 'node'
        f.node_path.write_bytes(node_bytes)
        f.node_path.chmod(0o500)
        holder['handlers'] = NativeArchiveWorkerHandlers([holder['guest']], [f.node_path], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, f.path / 'helper-output', path_resolver=remote)
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credential_file = f.path / 'credentials.json'
        write(credential_file, {'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []})
        f.profile, f.pool, f.intent, f.sandbox, f.boot = uid(), uid(), uid(), uid(), uid()
        manifest = provider.prepared.Fixture(f.path / 'declared-profile').create()
        manifest['profile']['image']['provider'] = 'blaxel'
        manifest.pop('digest')
        manifest['digest'] = sha(canonical(manifest))
        f.preparation = manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'blaxel','linux-amd64',$4)", [f.ids['organisation'], f.profile, f.preparation, manifest])
        limits = {'SANDBOX': '10', 'PROVISIONING': '10', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'DECLARED_OBSERVER_RECOVERY_COMPONENT', 'accounts': [{'provider': 'blaxel', 'account_key': 'daemon-component-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': f.pool, 'provider': 'blaxel', 'account_key': 'daemon-component-account', 'environment_key': 'daemon-component-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': 'DECLARED_NOT_PROVISIONED', 'network': 'ISOLATED', 'stdin_required': False}}], 'maximum_operation_ms': 60000}
        adapter_policy = {'schema_version': 1, 'lifecycle': {'schema_version': 1, 'run_seconds': 3600, 'checkpoint_lead_seconds': 60, 'termination_grace_seconds': 10, 'api_wait_seconds': 5, 'process': {'keep_alive': True, 'timeout_seconds': 0}, 'expiration_policies': [], 'runtime_ttl': None, 'runtime_expires_at': None}, 'network_mode': 'ISOLATED', 'network': {}, 'volumes': [], 'runtime_extra_args': {}, 'runtime_env_refs': {}, 'preparation_seed_reference': 'DECLARED_NOT_PROVISIONED'}
        adapter_file = f.path / 'blaxel-adapter.json'
        write(adapter_file, {'schema_version': 1, 'profiles': [{'routing': {'organisation_id': f.ids['organisation'], 'pool_id': f.pool, 'provider_account_id': 'daemon-component-account', 'environment_id': 'daemon-component-workspace', 'region': 'us-pdx-1'}, 'body': adapter_policy}]})
        f.env['HF_BLAXEL_ADAPTER_CONFIG'] = str(adapter_file)
        f.config['pools'][0]['create_policy']['adapter_policy_digest'] = sha(canonical(adapter_policy))
        pools_file = f.path / 'pools.json'
        write(pools_file, f.config)
        f.bootstrap_file = f.path / 'bootstrap.json'
        write(f.bootstrap_file, {})
        f.bootstrap_state = f.path / 'bootstrap-private'
        f.bootstrap_state.mkdir(mode=0o700)
        f.env.update(HYPERFIDE_POOL_CONFIG=str(pools_file), HF_CREDENTIAL_CONFIG_FILE=str(credential_file), HF_PROVIDER_BOOTSTRAP_CONFIG_FILE=str(f.bootstrap_file), NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='isolated-daemon-transport-no-live-authority', HF_BLAXEL_WORKSPACE='daemon-component-workspace', HF_BLAXEL_ACCOUNT_ID='daemon-component-account')

    f = None
    try:
        f = provider.pools.ProvisionerFixture(extra_components=component_closure(['8.3', '10.3']), extra_setup=setup)
        i = f.ids
        common = [i['organisation'], i['run']]
        stopped = f.invoke('provider.worker.stop', {}, component='8.3', key='provisioner')[1]
        assert stopped.get('ok'), stopped
        pool, account = f.config['pools'][0], f.config['accounts'][0]
        configuration = sha(canonical({'revision': f.config['revision'], 'pool': pool, 'account': account}))
        scope = {'organisation_id': i['organisation'], 'pool_id': f.pool, 'provider': 'blaxel', 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': configuration}
        operation = {'schema_version': 1, 'kind': 'create', 'scope': scope, 'deadline_at': '2099-01-01T00:00:00.000Z', 'identity': {'operation_id': f.intent, 'idempotency_key': f.intent, 'correlation_id': f.intent, 'causation_id': f.intent, 'payload_digest': sha(b'pending')}, 'resource': None, 'preparation_digest': f.preparation, 'parameters': {'preparation_reference': 'DECLARED_NOT_PROVISIONED', 'resources': {'cpu_millis': 2000, 'memory_bytes': '4294967296', 'disk_bytes': '4294967296', 'persistent_volume_bytes': '0'}, 'network': 'ISOLATED', 'stdin_required': False}}
        normalize = "import fs from'node:fs';import{operationPayloadDigest}from'./core/control-plane/dist/providers/contract.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);console.log(JSON.stringify(op));"
        result = subprocess.run(['node', '--input-type=module', '-e', normalize], cwd=ROOT, env=f.env, text=True, input=json.dumps(operation), capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        operation = json.loads(result.stdout)
        native = 'hf-' + sha(canonical({'scope': scope, 'operation_id': f.intent, 'generation': '1'}))[7:47]
        f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'blaxel',$3,$4,$5,$6)", [i['organisation'], f.pool, pool['account_key'], pool['environment_key'], pool['region'], f.profile])
        f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], f.pool, configuration, json.dumps({'scope': scope, 'pool': pool, 'account': account})])
        f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)", [i['organisation'], f.sandbox, f.pool, native, f.preparation])
        f.boot = f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2', [i['organisation'], f.sandbox])[0]['boot_id']
        f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$10,$11,'ACKNOWLEDGED',$12,1)", common + [f.intent, f.pool, f.sandbox, configuration, f.profile, f.intent, sha(b'controlled prior create'), operation['identity']['payload_digest'], json.dumps(operation), native])
        binding = {'organisation_id': i['organisation'], 'run_id': i['run'], 'provisioning_intent_id': f.intent, 'sandbox_id': f.sandbox, 'native_sandbox_id': native, 'boot_id': f.boot, 'boot_generation': '1', 'configuration_digest': configuration, 'profile_id': f.profile, 'preparation_digest': f.preparation}
        remote_manifest = str(holder['guest'] / 'manifest.json')
        state_root = str(holder['guest'] / 'state')
        boot_root = state_root + '/' + f.sandbox + '/' + f.boot
        manifest = {'schema_version': 1, 'kind': 'FLEET_NATIVE_BOOTSTRAP_V1', 'bootstrap_id': f.intent, 'binding': binding, 'template': {'state_root': state_root, 'origin': f.origin, 'ca_file': str(f.ca), 'runner_binary': '/usr/bin/sleep', 'runner_binary_digest': sha(Path('/usr/bin/sleep').read_bytes()), 'controller': {'node_path': str(f.node_path), 'node_digest': node_pin}, 'files': [{'path': str(f.node_path), 'digest': node_pin}]}}
        write(remote(remote_manifest), manifest)
        manifest_pin = sha(remote(remote_manifest).read_bytes())
        stat = Path('/proc/' + str(sleeper.pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        previous = {'pid': sleeper.pid, 'pgid': int(stat[2]), 'start_time': stat[19], 'os_boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        credential = uid()
        expires = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time()+300))
        f.sql("INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,allowed_actions,expires_at,sandbox_id,boot_id,boot_generation) VALUES($1,$2,$3,$1,'RUNNER',$4,$5,$6,$7,$8,$9,1)", [credential,i['organisation'],i['run'],f.keys['runner']['public_key_b64'],i['epoch'],f.actions,expires,f.sandbox,f.boot])
        receipt = {'schema_version': 1, 'kind': 'FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1', 'bootstrap_id': f.intent, 'manifest_digest': manifest_pin, 'credential_id': credential, 'binding': binding, 'daemon': previous, 'component_prerequisite_only': True}
        write(remote(boot_root + '/bootstrap-receipt.json'), receipt)
        write(remote(boot_root + '/daemon.json'), {'state_dir': boot_root + '/daemon', 'transport_config': boot_root + '/transport.json', 'organisation_id': i['organisation'], 'preparation_digest': f.preparation})
        write(remote(boot_root + '/transport.json'), {'origin': f.origin, 'ca_file': str(f.ca), 'key_path': str(f.keys['runner']['path']), 'timeout_ms': 2000, 'credential_id': credential})
        pending = {'run_id': i['run'], 'component': '14.1', 'action': 'identity.runner.heartbeat', 'input': {'expected_version': '1'}}
        write(remote(boot_root + '/daemon/daemon-state.json'), {'registered': True, 'state_version': '1', 'pending': {'kind': 'heartbeat', 'operation_id': uid(), 'idempotency_key': uid(), 'correlation_id': uid(), 'payload': canonical(pending).decode()}})
        recipe = {'pool_id': f.pool, 'configuration_digest': configuration, 'profile_id': f.profile, 'preparation_digest': f.preparation, 'native_path': '/controlled-prior-native', 'native_digest': sha(b'controlled prior native metadata'), 'manifest_path': remote_manifest, 'secret_path': str(holder['guest'] / 'prior-enrollment.json'), 'files': [{'artifact_id': uid(), 'storage_kind': 'object', 'digest': sha(b'controlled prior artifact metadata'), 'size_bytes': '0', 'target': '/controlled-prior-input', 'mode': '0444'}], 'allowed_actions': ['identity.principal.delegate'], 'grant_ttl_seconds': 300, 'native_template': {'slots': [{'kind': 'PREPARATION'}, {'kind': 'AGENT'}]}, 'install_template': {}}
        write(f.bootstrap_file, {'schema_version': 1, 'origin': f.origin, 'ca_file': str(f.ca), 'state_root': str(f.bootstrap_state), 'pools': [recipe]})
        descriptor = {**recipe, 'origin': f.origin, 'ca_file': str(f.ca)}
        token = os.urandom(32)
        grant = stable('grant:' + f.intent)
        secret_ref = f.bootstrap_state / (f.intent + '.enrollment.json')
        write(secret_ref, {'grant_id': grant, 'secret_b64': base64.urlsafe_b64encode(token).rstrip(b'=').decode()})
        verifier = sha(token)
        f.sql("INSERT INTO hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id,id,pool_id,sandbox_id,boot_id,boot_generation,native_sandbox_id,configuration_digest,profile_id,preparation_digest,descriptor_digest,descriptor,grant_id,binding_operation_id,grant_operation_id,enrollment_operation_id,secret_ref,verifier,process_id,state,manifest,manifest_digest,receipt,receipt_digest) VALUES($1,$2,$3,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$22,$17,'CONTROLLED_ORIGINAL_BOOTSTRAP','READY',$18,$19,$20,$21)", common + [f.intent, f.pool, f.sandbox, f.boot, native, configuration, f.profile, f.preparation, sha(canonical(descriptor)), json.dumps(descriptor), grant, uid(), uid(), uid(), verifier, json.dumps(manifest), manifest_pin, json.dumps(receipt), sha(canonical(receipt)), str(secret_ref)])
        backend.metadata = {'metadata': {'name': native, 'workspace': scope['environment_id'], 'labels': {'hyperfide-operation': f.intent, 'hyperfide-payload': operation['identity']['payload_digest'], 'hyperfide-scope': sha(canonical(scope)), 'hyperfide-boot': '1', 'hyperfide-preparation': f.preparation}}, 'spec': {'region': scope['region'], 'runtime': {'expires': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time()+120))}}, 'status': 'DEPLOYED'}
        prior_actor = uid()
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id) VALUES($1,$2,$3,'LEADER','fixture','fixture','controlled-prior-manager')", common + [prior_actor])
        observation, reasoning, decision, selection = [uid() for _ in range(4)]
        controlled = {'controlled_component_prerequisite': True}
        f.sql('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,$6)', common + [observation, prior_actor, sha(b'controlled prior selection'), controlled])
        f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7)", common + [reasoning, prior_actor, sha(b'controlled prior selection'), observation, controlled])
        f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,'PROVISION_SANDBOX',$6,$6,$7,$8)", common + [decision, selection, prior_actor, sha(b'controlled prior selection'), reasoning, controlled])
        f.sql('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)', common + [selection, decision, sha(b'controlled prior selection'), {'kind': 'PROVISION_SANDBOX', 'provider_intent_id': f.intent, 'sandbox_id': f.sandbox, **controlled}])

        def api(operation=None):
            if operation:
                return f.request(operation, key='provisioner', timeout_seconds=45)[1]
            return f.invoke('provider.intents.reconcile', {'intent_id': f.intent}, component='8.3', key='provisioner', timeout_seconds=45)[1]

        def journals():
            return f.sql("SELECT id::text,state,state_version::text,result,request_digest FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='provider.bootstrap.keepalive' ORDER BY id", common)

        original = f.sql('SELECT to_jsonb(b) AS row FROM hyperfide.provider_native_bootstraps b WHERE intent_id=$1', [f.intent])
        original_receipt = remote(boot_root + '/bootstrap-receipt.json').read_bytes()
        errors = []
        vm_expiry = backend.metadata['spec']['runtime']['expires']
        backend.metadata['spec']['runtime']['expires'] = '2000-01-01T00:00:00.000Z'
        expired = api()
        assert expired.get('error', {}).get('code') == 'BOOTSTRAP_KEEPALIVE_LIFETIME' and journals() == [] and submissions == [], expired
        errors.append(expired['error'])
        backend.metadata['spec']['runtime']['expires'] = vm_expiry
        f.node_path.write_bytes(b'actual controlled mismatching Node bytes')
        wrong = api()
        assert wrong.get('error', {}).get('code') == 'BOOTSTRAP_KEEPALIVE_NODE' and journals() == [] and submissions == [], wrong
        errors.append(wrong['error'])
        f.node_path.unlink()
        absent = api()
        assert absent.get('ok') is False and journals() == [] and submissions == [], absent
        errors.append(absent['error'])
        f.node_path.write_bytes(node_bytes)
        f.node_path.chmod(0o500)
        calls = [f.operation('8.3', 'provider.intents.reconcile', {'intent_id': f.intent}) for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(api, calls[0])
            try:
                if not entered.wait(25):
                    raise AssertionError({'first': first.result(timeout=45), 'journals': journals(), 'sdk_requests': backend.requests[-12:], 'process_observations': holder['handlers'].observations})
                second = executor.submit(api, calls[1]).result(timeout=30)
            finally:
                release_reply.set()
            lost = first.result(timeout=30)
        retained = journals()
        assert len(retained) == 1 and retained[0]['state'] == 'PENDING' and retained[0]['result']['phase'] == 'SUBMITTED', (lost, second, retained)
        assert len(submissions) == 1 and submissions[0]['actual_status'] == 200 and submissions[0]['keepAlive'] is True and 0 < submissions[0]['timeout'] <= 120, submissions
        request = retained[0]['result']['request']
        process_id = retained[0]['result']['process_id']
        assert request['binding'] == binding and request['daemon'] == previous and request['node_digest'] == node_pin
        assert request['deadline_at'] == min(vm_expiry, expires)
        time.sleep(0.2)
        waking = api()
        assert waking.get('ok') and waking['result']['observer']['keeper'] == 'WAKING' and len(journals()) == 1 and len(submissions) == 1, waking
        assert f.sql('SELECT 1 FROM hyperfide.identity_runner_status WHERE credential_id=$1', [credential]) == [], 'No fixture heartbeat may certify ACTIVE'
        assert sleeper.poll() is None
        saved = holder['handlers'].processes.pop(process_id)
        missing = api()
        assert missing.get('ok') and missing['result']['observer']['keeper'] == 'UNKNOWN' and journals() == retained and len(submissions) == 1, missing
        holder['handlers'].processes[process_id] = saved
        # Execute the emitted fixed probe with a mismatched real process start time.
        probe = subprocess.run(['node', '--input-type=module', '-e', "import{BOOTSTRAP_KEEPALIVE_PROBE as p}from'./core/control-plane/dist/providers/bootstrap_keepalive_probe.js';process.stdout.write(p)"], cwd=ROOT, env=f.env, text=True, capture_output=True, timeout=15)
        assert probe.returncode == 0, probe.stderr
        wrong_tuple = {**previous, 'start_time': str(int(previous['start_time']) + 1)}
        payload = {'manifest_path': remote_manifest, 'manifest_digest': manifest_pin, 'binding': binding, 'daemon': wrong_tuple, 'deadline_ms': int(time.time()*1000)+5000, 'request_digest': retained[0]['request_digest']}
        identity_probe = subprocess.run([str(f.node_path), '-e', probe.stdout, canonical(payload).decode()], text=True, capture_output=True, timeout=5)
        assert identity_probe.returncode != 0 and 'BOOTSTRAP_KEEPALIVE_IDENTITY' in identity_probe.stderr and identity_probe.stdout == '', identity_probe
        keeper_child = saved['child']
        keeper_child.terminate()
        keeper_child.wait(timeout=5)
        stopped_keeper = api()
        assert stopped_keeper.get('ok') and stopped_keeper['result']['observer']['keeper'] == 'STOPPED' and len(submissions) == 1, stopped_keeper
        assert journals()[0]['state'] == 'COMPLETED' and sleeper.poll() is None
        terminal_journal = journals()
        terminal_replay = api()
        assert terminal_replay.get('ok') and terminal_replay['result']['observer']['keeper'] == 'STOPPED' and journals() == terminal_journal and len(submissions) == 1, terminal_replay
        assert f.sql('SELECT to_jsonb(b) AS row FROM hyperfide.provider_native_bootstraps b WHERE intent_id=$1', [f.intent]) == original
        assert remote(boot_root + '/bootstrap-receipt.json').read_bytes() == original_receipt
        print(json.dumps({'status': 'PASS', 'scope': 'signed PG keeper coordinator, actual pinned SDK filesystem/process boundary and real Node/proc identity; original selection/READY are controlled prerequisites', 'bootstrap_and_ACTIVE_qualification': 'NOT_CLAIMED; no fresh RUNNER heartbeat produced', 'checks': ['expired actual VM deadline refuses before journal/effects', 'wrong and missing actual pinned Node refuse before journal/effects', 'concurrent reconcile and lost exec reply retain one SUBMITTED keeper and one actual Unix process', 'actual fixed probe proves exact existing daemon tuple; keeper stays WAKING without signed heartbeat', 'missing same named SDK process stays UNKNOWN without resubmit', 'wrong physical process start time produces no startup proof', 'actual dead keeper remains terminal across repeated reconciliation while original daemon stays alive', 'original READY metadata and root receipt bytes unchanged'], 'journal': retained, 'negative_errors': errors, 'lost_reply_response': lost, 'concurrent_response': second, 'submissions': submissions}))
    finally:
        release_reply.set()
        if f:
            try:
                holder['handlers'].close()
            finally:
                f.close()
        if sleeper.poll() is None:
            sleeper.terminate()
            sleeper.wait(timeout=5)
        backend.close()


if __name__ == '__main__':
    main()
