"""Real PG/S3/SDK bootstrap input fixture; prior CREATE authorization is declared metadata."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
from urllib.parse import unquote, urlsplit

from fleet_prerequisite_fixture import component_closure

ROOT = Path(__file__).resolve().parents[3]
SUPPORT = ROOT / 'tests/hyperfide/support'


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


provider = load('deadline_provider_fixture', 'tests/hyperfide/cases/tasks/8_3.py')
objects = load('deadline_object_fixture', 'tests/hyperfide/cases/tasks/15_2.py')
cloud = load('deadline_sdk_boundary', 'tests/hyperfide/support/source_archive_http_fixture.py')
worker = load('deadline_unix_boundary', 'tests/hyperfide/support/fleet_archive_worker_fixture.py')


def uid():
    return str(uuid.uuid4())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def sha(value):
    return 'sha256:' + hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


def write(path, value):
    path.write_bytes(canonical(value))
    path.chmod(0o600)


def prepare(native_path, native_digest, process_boundary=None, http_delay=None):
    native_source = Path(native_path).resolve()
    native_bytes = native_source.read_bytes()
    if not native_source.is_file() or sha(native_bytes) != native_digest:
        raise ValueError('Explicit native artifact differs from its immutable digest')
    parent = Path('/var/lib/hyperfide/component-fixtures')
    parent.mkdir(parents=True, exist_ok=True, mode=0o755)
    if parent.is_symlink() or parent.stat().st_uid != 0 or parent.stat().st_mode & 0o022:
        raise ValueError('Protected owned fixture parent required')
    owned = Path(tempfile.mkdtemp(prefix='bootstrap-deadline-', dir=parent))
    owned.chmod(0o755)
    guest = owned / 'guest'
    guest.mkdir(mode=0o755)
    runtime = guest / 'runtime'
    runtime.mkdir(mode=0o755)
    native = runtime / 'hyperfide-native'
    native.write_bytes(native_bytes)
    native.chmod(0o555)
    node = runtime / 'node'
    shutil.copyfile(Path(shutil.which('node')).resolve(), node)
    node.chmod(0o555)
    recipe = runtime / 'fleet_install.js'
    shutil.copyfile(ROOT / 'core/control-plane/dist/preparation/fleet_install.js', recipe)
    recipe.chmod(0o444)
    handlers = worker.NativeArchiveWorkerHandlers([owned], [native], {'PATH': '/usr/bin:/bin', 'LANG': 'C'}, owned / 'process-output')

    def process_handler(method, identifier, body):
        if process_boundary:
            return process_boundary(method, identifier, body, handlers.process_handler)
        return handlers.process_handler(method, identifier, body)

    backend = cloud.BlaxelHttpFixture({'metadata': {'name': 'pending-controlled-bootstrap-input'}}, handlers.resolve_path, process_handler)
    original_route = backend.server.RequestHandlerClass.route

    def controlled_route(handler):
        if http_delay:
            seconds = http_delay(handler.command, handler.path)
            if seconds is not None:
                if not isinstance(seconds, (int, float)) or not 0 <= seconds <= 90:
                    raise ValueError('Owned HTTP delay must be bounded')
                time.sleep(seconds)
        path = unquote(urlsplit(handler.path).path)
        marker = '/sandboxes/' + backend.metadata['metadata']['name'] + '/filesystem/'
        if handler.command == 'PUT' and marker in path:
            size = int(handler.headers.get('content-length', '0'))
            if size > 256:
                raise ValueError('Bounded owned mkdir request required')
            data = json.loads(handler.rfile.read(size))
            if data != {'isDirectory': True, 'permissions': '0700'}:
                raise ValueError('Exact owned SDK mkdir request required')
            destination = handlers.resolve_path('/' + path.split(marker, 1)[1].lstrip('/'))
            destination.mkdir(mode=0o700, parents=True, exist_ok=True)
            destination.chmod(0o700)
            with backend.lock:
                backend.requests.append({'method': handler.command, 'path': path, 'body_size': size})
            return handler.send(200, {'path': str(destination), 'isDirectory': True, 'permissions': '0700'})
        return original_route(handler)

    backend.server.RequestHandlerClass.route = controlled_route

    object_backend = objects.ObjectFixture()
    f = None
    closed = False

    def close():
        nonlocal closed
        if closed:
            return
        closed = True
        try:
            handlers.close()
        finally:
            try:
                backend.close()
            finally:
                try:
                    if f:
                        f.close()
                finally:
                    object_backend.stop()
                    shutil.rmtree(owned)

    def setup(f):
        manifest = provider.prepared.Fixture(f.path / 'declared-profile').create()
        manifest['profile']['image']['provider'] = 'blaxel'
        manifest.pop('digest')
        manifest['digest'] = sha(manifest)
        f.profile, f.pool, f.preparation = uid(), uid(), manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,provider,runtime_platform,content_digest,manifest) VALUES($1,$2,'blaxel','linux-amd64',$3,$4)", [f.ids['organisation'], f.profile, f.preparation, manifest])
        limits = {'SANDBOX': '100', 'PROVISIONING': '10', 'CPU_MILLIS': '200000', 'MEMORY_BYTES': '429496729600', 'DISK_BYTES': '3221225472000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'CONTROLLED_BOOTSTRAP_DEADLINE_INPUT', 'accounts': [{'provider': 'blaxel', 'account_key': 'deadline-fixture-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': f.pool, 'provider': 'blaxel', 'account_key': 'deadline-fixture-account', 'environment_key': 'deadline-fixture-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': 'CONTROLLED_PRIOR_CREATE', 'network': 'ISOLATED', 'stdin_required': False}}], 'maximum_operation_ms': 120000}
        f.configfile = f.path / 'pools.json'
        write(f.configfile, f.config)
        executor = f.path / 'executor.json'
        write(executor, {'schema_version': 1, 'principals': [{'credential_id': f.ids['provisioner'], 'key_path': str(f.keys['provisioner']['path'])}], 'concurrency': 1})
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'credentials.json'
        write(credentials, {'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []})
        f.env.update(HYPERFIDE_POOL_CONFIG=str(f.configfile), HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(executor), HF_CREDENTIAL_CONFIG_FILE=str(credentials), HF_ARTIFACT_S3_ENDPOINT=object_backend.endpoint, HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1', HF_ARTIFACT_S3_REGION=objects.REGION, HF_ARTIFACT_S3_BUCKET=objects.BUCKET, HF_ARTIFACT_S3_ACCESS_KEY_ID=objects.KEY, HF_ARTIFACT_S3_SECRET_ACCESS_KEY=objects.SECRET, HF_ARTIFACT_S3_SESSION_TOKEN=objects.TOKEN, HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'], HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]), NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(SUPPORT / 'source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='isolated-fixture-no-live-authority', HF_BLAXEL_WORKSPACE='deadline-fixture-workspace', HF_BLAXEL_ACCOUNT_ID='deadline-fixture-account')

    try:
        f = provider.pools.ProvisionerFixture(extra_components=component_closure(['8.3', '10.3', '15.2']), extra_actions=['instructions.consumer.register'], extra_setup=setup)
        ids = f.ids

        def ok(action, value=None, key='operator', component='8.3'):
            response = f.invoke(action, value or {}, component=component, key=key, timeout_seconds=60)[1]
            assert response.get('ok'), response
            return response['result']

        ok('provider.worker.stop', key='provisioner')
        ok('provider.pools.configure', component='8.2')
        configuration = f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active', [ids['organisation'], f.pool])[0]['configuration_digest']
        chunks = []
        for offset in range(0, len(native_bytes), 196608):
            content = native_bytes[offset:offset + 196608]
            uploaded = ok('artifact.object.put', {'organisation_id': ids['organisation'], 'run_id': ids['run'], 'digest': sha(content), 'size_bytes': str(len(content)), 'data_base64': base64.b64encode(content).decode(), 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2')
            objects.verified(uploaded, content)
            chunks.append({'sequence': len(chunks), 'artifact_id': uploaded['artifact']['artifact_id'], 'digest': sha(content), 'size_bytes': str(len(content)), 'offset_bytes': str(offset)})
        artifact = ok('artifact.manifest.commit', {'organisation_id': ids['organisation'], 'run_id': ids['run'], 'expected_chunks': len(chunks), 'total_size_bytes': str(len(native_bytes)), 'content_digest': native_digest, 'complete': True, 'truncated': False, 'missing_ranges': [], 'chunks': chunks, 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2')
        objects.verified(artifact)
        org, run, intent, sandbox = ids['organisation'], ids['run'], uid(), uid()
        scope = {'organisation_id': org, 'pool_id': f.pool, 'provider': 'blaxel', 'provider_account_id': 'deadline-fixture-account', 'environment_id': 'deadline-fixture-workspace', 'region': 'us-pdx-1', 'configuration_digest': configuration}
        operation = {'schema_version': 1, 'kind': 'create', 'scope': scope, 'deadline_at': provider.utc(120000), 'identity': {key: intent for key in ['operation_id', 'idempotency_key', 'correlation_id', 'causation_id']}, 'resource': None, 'preparation_digest': f.preparation, 'parameters': {'preparation_reference': 'CONTROLLED_PRIOR_CREATE', 'resources': {'cpu_millis': 2000, 'memory_bytes': '4294967296', 'disk_bytes': '32212254720', 'persistent_volume_bytes': '0'}, 'network': 'ISOLATED', 'stdin_required': False}}
        script = "import fs from 'node:fs';import{operationPayloadDigest,validateProviderOperation}from'./core/control-plane/dist/providers/contract.js';import{blaxelCreateName}from'./core/control-plane/dist/providers/blaxel/processes.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);validateProviderOperation(op);console.log(JSON.stringify({operation:op,native:blaxelCreateName(op,'1')}));"
        normalized = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, input=json.dumps(operation), text=True, capture_output=True, env=f.env, timeout=20)
        assert normalized.returncode == 0, normalized.stderr
        normalized = json.loads(normalized.stdout)
        operation, native_id = normalized['operation'], normalized['native']
        f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)", [org, sandbox, f.pool, native_id, f.preparation])
        boot = f.sql('SELECT boot_id::text FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2', [org, sandbox])[0]['boot_id']
        f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$10,$11,'ACKNOWLEDGED',$12,1)", [org, run, intent, f.pool, sandbox, configuration, f.profile, uid(), sha({'controlled_prior_create': intent}), operation['identity']['payload_digest'], operation, native_id])
        observation = {'controlled_historical_provider_input': True, 'outcome': {'status': 'SUCCEEDED', 'resource': {'native_sandbox_id': native_id}}}
        f.sql('INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$3::uuid::text,$4,$5,clock_timestamp(),$6)', [org, uid(), intent, operation['identity']['payload_digest'], observation, sha(observation)])
        manager, observed, reason, decision, effect = [uid() for _ in range(5)]
        pin = sha({'controlled_prior_selection': intent})
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id) VALUES($1,$2,$3,'FEATURE_MANAGER','fixture','fixture',$3::uuid::text)", [org, run, manager])
        f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{}')", [org, run, observed, manager, pin])
        f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED')", [org, run, reason, manager, pin, observed])
        f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,'PROVISION_SANDBOX',$6,$6,$7,'{}')", [org, run, decision, effect, manager, pin, reason])
        f.sql('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)', [org, run, effect, decision, pin, {'kind': 'PROVISION_SANDBOX', 'provider_intent_id': intent, 'sandbox_id': sandbox, 'controlled_historical_selection': True}])
        backend.metadata = {'metadata': {'name': native_id, 'workspace': scope['environment_id'], 'labels': {'hyperfide-operation': intent, 'hyperfide-payload': operation['identity']['payload_digest'], 'hyperfide-scope': sha(scope), 'hyperfide-boot': '1', 'hyperfide-preparation': f.preparation}}, 'spec': {'region': scope['region']}, 'status': 'DEPLOYED'}
        ca = owned / 'bootstrap-ca.pem'
        shutil.copyfile(f.ca, ca)
        ca.chmod(0o600)
        state_root, slots_root, workspace_root = guest / 'state', guest / 'slots', guest / 'workspaces'
        manifest_path = guest / 'bootstrap-manifest.json'
        secret_path = str(state_root / '{sandbox_id}' / '{boot_id}' / 'enrollment-grant.json')
        files = [{'path': str(path), 'digest': sha(path.read_bytes())} for path in [native, node, recipe]]
        template = {'origin': f.origin, 'ca_file': str(ca), 'state_root': str(state_root), 'slot_root': str(slots_root), 'workspace_root': str(workspace_root), 'environment_root': str(workspace_root / 'project/workspace'), 'runner_binary': str(native), 'runner_binary_digest': native_digest, 'repository_id': ids.get('repository', ids.get('project')), 'runner_config': {'schema_version': 1}, 'files': files, 'preparation_recipes': {'environment.prepare.v1': {'node_path': str(node), 'node_digest': sha(node.read_bytes()), 'recipe_path': str(recipe), 'recipe_digest': sha(recipe.read_bytes()), 'native_path': str(native), 'native_digest': native_digest, 'readiness_verifier': {'module_closure': []}}}, 'slots': [{'name': 'preparer', 'kind': 'PREPARATION', 'uid': 65534, 'gid': 65534, 'isolation_profile': 'distinct_uid', 'credential_sensitive': False, 'storage_bytes': 1048576}, {'name': 'worker', 'kind': 'AGENT', 'uid': 1, 'gid': 1, 'isolation_profile': 'distinct_uid', 'credential_sensitive': False, 'storage_bytes': 1048576, 'ordinal': 0, 'worker_paths': {name: str(workspace_root / 'project/workspace/workers/0' / name) for name in ['source', 'home', 'build', 'temporary', 'dirty']}}]}
        controller_state = owned / 'coordinator-state'
        controller_state.mkdir(mode=0o700)
        recipe_config = {'pool_id': f.pool, 'configuration_digest': configuration, 'profile_id': f.profile, 'preparation_digest': f.preparation, 'native_path': str(native), 'native_digest': native_digest, 'manifest_path': str(manifest_path), 'secret_path': secret_path, 'files': [{'artifact_id': artifact['artifact']['artifact_id'], 'storage_kind': 'manifest', 'digest': native_digest, 'manifest_digest': artifact['artifact']['digest'], 'size_bytes': str(len(native_bytes)), 'target': str(native), 'mode': '0500'}], 'allowed_actions': ['identity.describe', 'instructions.consumer.register'], 'grant_ttl_seconds': 300, 'native_template': template, 'install_template': {}}
        descriptor = owned / 'bootstrap.json'
        write(descriptor, {'schema_version': 1, 'origin': f.origin, 'ca_file': str(ca), 'state_root': str(controller_state), 'pools': [recipe_config]})
        f.env['HF_PROVIDER_BOOTSTRAP_CONFIG_FILE'] = str(descriptor)
        principal = next(item for item in json.loads(f.identity_config.read_text())['principals'] if item['credential_id'] == ids['provisioner'])
        payload = {'org': org, 'run': run, 'epoch': ids['epoch'], 'intent': intent, 'sandbox': sandbox, 'pool': f.pool, 'profile': f.profile, 'native': native_id, 'native_path': str(native), 'native_digest': native_digest, 'manifest_path': str(manifest_path), 'secret_path': secret_path, 'descriptor_file': str(descriptor), 'state_root': str(state_root), 'controller_state_root': str(controller_state), 'boot': boot, 'configuration_digest': configuration, 'preparation_digest': f.preparation, 'credential': ids['provisioner'], 'principal': principal, 'runtime_role': f.runtime_role, 'policy_file': str(f.policy), 'origin': f.origin, 'ca_file': str(ca), 'native_artifact': artifact['artifact'], 'template': template}
        return {'f': f, 'payload': payload, 'backend': backend, 'handlers': handlers, 'owned': owned, 'objects': object_backend, 'ok': ok, 'close': close}
    except BaseException:
        close()
        raise
