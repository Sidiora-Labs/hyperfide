#!/usr/bin/env python3
"""Real signed coordinator/SDK admission with declared original bootstrap prerequisites; no recovery success receipt."""
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
objects = load('daemon_artifact_fixture', 'tests/hyperfide/cases/tasks/15_2.py')


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


def main():
    object_backend = objects.ObjectFixture()
    holder = {}
    entered, release_reply = threading.Event(), threading.Event()
    submissions = []

    def remote(value):
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts:
            raise PermissionError('Absolute owned guest path required')
        return holder['guest'] / str(path).lstrip('/')

    def processes(method, ident, body):
        result = holder['handlers'].process_handler(method, ident, body)
        if method == 'POST' and ident is None:
            submissions.append({'name': body['name'], 'command': body['command'], 'actual_status': result[0]})
            entered.set()
            release_reply.wait(10)
            return 503, {'message': 'Controlled lost submit response after actual Unix helper execution'}
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
    native_bytes = (ROOT / 'build/hyperfide-native').read_bytes()
    native_pin = sha(native_bytes)
    helper_path = '/opt/hyperfide/observer-recovery/' + native_pin[7:] + '/hyperfide-native'

    def setup(f):
        holder['guest'] = f.path / 'guest'
        holder['guest'].mkdir(mode=0o700)
        holder['handlers'] = NativeArchiveWorkerHandlers([holder['guest']], [remote(helper_path)], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, f.path / 'helper-output', path_resolver=remote)
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
        pools_file = f.path / 'pools.json'
        write(pools_file, f.config)
        f.recovery_file = f.path / 'daemon-recovery.json'
        write(f.recovery_file, {'schema_version': 1, 'pools': []})
        f.env.update(HYPERFIDE_POOL_CONFIG=str(pools_file), HF_CREDENTIAL_CONFIG_FILE=str(credential_file), HF_PROVIDER_DAEMON_RECOVERY_CONFIG_FILE=str(f.recovery_file), NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='isolated-daemon-transport-no-live-authority', HF_BLAXEL_WORKSPACE='daemon-component-workspace', HF_BLAXEL_ACCOUNT_ID='daemon-component-account', HF_ARTIFACT_S3_ENDPOINT=object_backend.endpoint, HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1', HF_ARTIFACT_S3_REGION=objects.REGION, HF_ARTIFACT_S3_BUCKET=objects.BUCKET, HF_ARTIFACT_S3_ACCESS_KEY_ID=objects.KEY, HF_ARTIFACT_S3_SECRET_ACCESS_KEY=objects.SECRET, HF_ARTIFACT_S3_SESSION_TOKEN=objects.TOKEN, HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'], HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]))

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
        remote_manifest = '/component/manifest.json'
        state_root = '/component/state'
        boot_root = state_root + '/' + f.sandbox + '/' + f.boot
        manifest = {'schema_version': 1, 'kind': 'FLEET_NATIVE_BOOTSTRAP_V1', 'bootstrap_id': f.intent, 'binding': binding, 'template': {'state_root': state_root, 'origin': f.origin, 'ca_file': str(f.ca), 'runner_binary': '/usr/bin/sleep', 'runner_binary_digest': sha(Path('/usr/bin/sleep').read_bytes())}}
        write(remote(remote_manifest), manifest)
        manifest_pin = sha(remote(remote_manifest).read_bytes())
        stat = Path('/proc/' + str(sleeper.pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        previous = {'pid': sleeper.pid, 'pgid': int(stat[2]), 'start_time': stat[19], 'os_boot_id': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        credential = uid()
        receipt = {'schema_version': 1, 'kind': 'FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1', 'bootstrap_id': f.intent, 'manifest_digest': manifest_pin, 'credential_id': credential, 'binding': binding, 'daemon': previous, 'component_prerequisite_only': True}
        write(remote(boot_root + '/bootstrap-receipt.json'), receipt)
        write(remote(boot_root + '/daemon.json'), {'state_dir': boot_root + '/daemon', 'transport_config': boot_root + '/transport.json', 'organisation_id': i['organisation'], 'preparation_digest': f.preparation})
        write(remote(boot_root + '/transport.json'), {'origin': f.origin, 'ca_file': str(f.ca), 'key_path': str(f.keys['runner']['path']), 'timeout_ms': 2000, 'credential_id': credential})
        pending = {'run_id': i['run'], 'component': '14.1', 'action': 'identity.runner.heartbeat', 'input': {'expected_version': '1'}}
        write(remote(boot_root + '/daemon/daemon-state.json'), {'registered': True, 'state_version': '1', 'pending': {'kind': 'heartbeat', 'operation_id': uid(), 'idempotency_key': uid(), 'correlation_id': uid(), 'payload': canonical(pending).decode()}})
        descriptor = {'manifest_path': remote_manifest}
        f.sql("INSERT INTO hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id,id,pool_id,sandbox_id,boot_id,boot_generation,native_sandbox_id,configuration_digest,profile_id,preparation_digest,descriptor_digest,descriptor,grant_id,binding_operation_id,grant_operation_id,enrollment_operation_id,secret_ref,verifier,process_id,state,manifest,manifest_digest,receipt,receipt_digest) VALUES($1,$2,$3,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CONTROLLED_NO_ENROLLMENT_SECRET',$17,'CONTROLLED_ORIGINAL_BOOTSTRAP','READY',$18,$19,$20,$21)", common + [f.intent, f.pool, f.sandbox, f.boot, native, configuration, f.profile, f.preparation, sha(canonical(descriptor)), json.dumps(descriptor), uid(), uid(), uid(), uid(), sha(b'controlled verifier metadata'), json.dumps(manifest), manifest_pin, json.dumps(receipt), sha(canonical(receipt))])
        backend.metadata = {'metadata': {'name': native, 'workspace': scope['environment_id'], 'labels': {'hyperfide-operation': f.intent, 'hyperfide-payload': operation['identity']['payload_digest'], 'hyperfide-scope': sha(canonical(scope)), 'hyperfide-boot': '1', 'hyperfide-preparation': f.preparation}}, 'spec': {'region': scope['region']}, 'status': 'RUNNING'}
        chunks = []
        for offset in range(0, len(native_bytes), 196608):
            part = native_bytes[offset:offset + 196608]
            stored = f.invoke('artifact.object.put', {'organisation_id': i['organisation'], 'run_id': i['run'], 'digest': sha(part), 'size_bytes': str(len(part)), 'data_base64': base64.b64encode(part).decode(), 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2', key='operator')[1]
            assert stored.get('ok'), stored
            objects.verified(stored['result'], part)
            chunks.append({'sequence': len(chunks), 'artifact_id': stored['result']['artifact']['artifact_id'], 'digest': sha(part), 'size_bytes': str(len(part)), 'offset_bytes': str(offset)})
        committed = f.invoke('artifact.manifest.commit', {'organisation_id': i['organisation'], 'run_id': i['run'], 'expected_chunks': len(chunks), 'total_size_bytes': str(len(native_bytes)), 'content_digest': native_pin, 'complete': True, 'truncated': False, 'missing_ranges': [], 'chunks': chunks, 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2', key='operator')[1]
        assert committed.get('ok'), committed
        objects.verified(committed['result'])
        artifact = committed['result']['artifact']
        recovery_config = {'schema_version': 1, 'pools': [{'pool_id': f.pool, 'configuration_digest': configuration, 'profile_id': f.profile, 'preparation_digest': f.preparation, 'helper_path': helper_path, 'helper_digest': native_pin, 'helper_file': {'artifact_id': artifact['artifact_id'], 'storage_kind': 'manifest', 'digest': native_pin, 'manifest_digest': artifact['digest'], 'size_bytes': str(len(native_bytes)), 'target': helper_path, 'mode': '0500'}}]}
        write(f.recovery_file, recovery_config)

        def api(operation=None):
            payload = {'intent_id': f.intent, 'recover_observer': True}
            if operation:
                return f.request(operation, key='provisioner', timeout_seconds=30)[1]
            return f.invoke('provider.intents.reconcile', payload, component='8.3', key='provisioner', timeout_seconds=30)[1]

        def journals():
            return f.sql("SELECT id::text,state,state_version::text,result,request_digest FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='provider.bootstrap.daemon-recovery' ORDER BY id", common)

        original = f.sql('SELECT to_jsonb(b) AS row FROM hyperfide.provider_native_bootstraps b WHERE intent_id=$1', [f.intent])
        original_receipt = remote(boot_root + '/bootstrap-receipt.json').read_bytes()
        bad = copy.deepcopy(manifest)
        bad['component_changed'] = True
        write(remote(remote_manifest), bad)
        refused = api()
        assert refused.get('error', {}).get('code') == 'DAEMON_RECOVERY_MANIFEST' and journals() == [] and submissions == [], refused
        write(remote(remote_manifest), manifest)
        physical = copy.deepcopy(receipt)
        physical['component_changed'] = True
        write(remote(boot_root + '/bootstrap-receipt.json'), physical)
        refused = api()
        assert refused.get('error', {}).get('code') == 'DAEMON_RECOVERY_IDENTITY' and journals() == [] and submissions == [], refused
        remote(boot_root + '/bootstrap-receipt.json').write_bytes(original_receipt)
        slot, task, package, attempt = uid(), uid(), uid(), uid()
        f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'daemon-component-active-work',1)", common + [package])
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,'daemon-component-active-work',$4,$5,$6,'{}',1)", common + [task, package, i['spec'], sha(b'controlled active-work prerequisite')])
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,'daemon-active-work',1,'AGENT','READY')", [i['organisation'], slot, f.sandbox])
        f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '1 hour')", common + [attempt, task, i['epoch'], sha(b'controlled active attempt metadata'), f.sandbox, slot])
        count = len(backend.requests)
        refused = api()
        assert refused.get('error', {}).get('code') == 'DAEMON_RECOVERY_ACTIVE_WORK' and len(backend.requests) == count and journals() == [], refused
        f.sql("UPDATE hyperfide.attempts SET compute_authority='REVOKED',execution_state='CANCELLED',state_version=state_version+1 WHERE id=$1", [attempt])
        calls = [f.operation('8.3', 'provider.intents.reconcile', {'intent_id': f.intent, 'recover_observer': True}) for _ in range(2)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            first = executor.submit(api, calls[0])
            try:
                if not entered.wait(15):
                    diagnostic = first.result(timeout=20)
                    raise AssertionError(json.dumps({'first_response': diagnostic, 'journals': journals(), 'sdk_requests': backend.requests[-12:], 'process_observations': holder['handlers'].observations}))
                second = executor.submit(api, calls[1]).result(timeout=20)
            finally:
                release_reply.set()
            lost = first.result(timeout=20)
        retained = journals()
        assert len(retained) == 1 and retained[0]['state'] == 'PENDING' and retained[0]['result']['phase'] == 'SUBMITTED', (lost, second, retained)
        assert len(submissions) == 1 and submissions[0]['actual_status'] == 200, submissions
        assert second.get('ok') and second['result']['recovery'] == 'UNKNOWN', second
        process_id = retained[0]['result']['request']['process_id']
        assert submissions[0]['name'] == process_id and retained[0]['result']['request']['binding'] == binding
        holder['handlers'].processes[process_id]['child'].wait(timeout=10)
        assert holder['handlers'].processes[process_id]['child'].returncode != 0
        assert not list(holder['guest'].rglob('daemon-recoveries/*/receipt.json'))
        replay = api(calls[0])
        assert replay.get('ok') and replay['result']['recovery'] == 'UNKNOWN' and journals() == retained and len(submissions) == 1, replay
        saved = holder['handlers'].processes.pop(process_id)
        missing = api()
        assert missing.get('ok') and missing['result']['recovery'] == 'UNKNOWN' and journals() == retained and len(submissions) == 1, missing
        holder['handlers'].processes[process_id] = saved
        assert f.sql('SELECT to_jsonb(b) AS row FROM hyperfide.provider_native_bootstraps b WHERE intent_id=$1', [f.intent]) == original
        assert remote(boot_root + '/bootstrap-receipt.json').read_bytes() == original_receipt
        print(json.dumps({'status': 'PASS', 'scope': 'signed coordinator and actual SDK HTTP/Unix helper delivery with explicitly declared original READY prerequisite metadata', 'bootstrap_qualification': 'NOT_CLAIMED', 'recovery_completion_and_fresh_RUNNER_ack': 'NOT_EXERCISED; owned by separate actual native TLS lifecycle gate', 'checks': ['wrong original manifest and root receipt refuse before admission', 'CURRENT compute refuses before transport/helper effects', 'concurrent calls and lost submit reply retain one PENDING SUBMITTED journal and one actual Unix helper', 'failed native helper without receipt remains UNKNOWN with admission fence retained', 'exact replay and missing provider process lookup never resubmit', 'original bootstrap metadata and receipt bytes preserved'], 'journal': retained, 'submissions': submissions, 'lost_reply_response': lost, 'concurrent_response': second}))
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
        object_backend.stop()


if __name__ == '__main__':
    main()
