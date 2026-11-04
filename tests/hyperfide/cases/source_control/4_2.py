#!/usr/bin/env python3
"""Exercise native fleet source custody through actual runtime boundaries."""
import importlib.util
import contextlib
import fcntl
import stat
import atexit
import select
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def _run():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_prerequisite_fixture import component_closure
    adoption_spec = importlib.util.spec_from_file_location('native_fleet_adoption', ROOT / 'tests/hyperfide/cases/tasks/3_4.py')
    adoption = importlib.util.module_from_spec(adoption_spec)
    adoption_spec.loader.exec_module(adoption)
    source_actions = ['source.fleet.bind-run', 'source.fleet.assign', 'source.fleet.qualify', 'source.fleet.read', 'source.fleet.manifest', 'source.fleet.select', 'source.fleet.selection']

    if os.environ.get('HF_SOURCE_FULL_CASE') == 'SCM-023':
        source_actions += ['source.revisions.read', 'source.queries.history', 'source.publications.read']

    def setup(instance):
        adoption.native_profiles(instance)
        identity = json.loads(instance.identity_config.read_text())
        for principal in identity['principals']:
            principal['allowed_actions'] += [action for action in source_actions if action not in principal['allowed_actions']]
            if principal['role'] == 'OPERATOR' and 'runner.dispatch.consume' not in principal['allowed_actions']:
                principal['allowed_actions'].append('runner.dispatch.consume')
            instance.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1', [principal['credential_id'], principal['allowed_actions']])
        instance.identity_config.write_text(json.dumps(identity))
        if os.environ.get('HF_SOURCE_FULL_CASE') == 'SCM-023':
            rules = []
            for role in sorted({principal['role'] for principal in identity['principals']}):
                allowed = list(dict.fromkeys(action for principal in identity['principals'] if principal['role'] == role for action in principal['allowed_actions']))
                rules.append({'role':role,'actions':allowed,'repositories':[instance.ids['repository']],'artifact_prefixes':[],'git_refs':[],'model_destinations':[],'model_profiles':[]})
            authorization = instance.path/'source-authorization.json'
            authorization.write_text(json.dumps({'schema_version':1,'rules':rules}));authorization.chmod(0o600)
            instance.env['HF_AUTHORIZATION_CONFIG_FILE'] = str(authorization)
        instance.actions += [action for action in source_actions if action not in instance.actions]
        policy = json.loads(instance.policy.read_text())
        policy['allowed_actions'] += [action for action in source_actions if action not in policy['allowed_actions']]
        instance.policy.write_text(json.dumps(policy))

    source_env = {}
    source_components = []
    backend = None
    if os.environ.get('HF_SOURCE_FULL_CASE') == 'SCM-023':
        backend = subprocess.Popen(['node', '--input-type=module', '-e', "import {createSourceS3Fixture} from './tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const backend=await createSourceS3Fixture();console.log(JSON.stringify(backend.config));process.once('SIGTERM',async()=>{await backend.close();process.exit(0);});"], cwd=ROOT, stdout=subprocess.PIPE, text=True)
        def close_backend():
            backend.terminate()
            try: backend.wait(timeout=10)
            except subprocess.TimeoutExpired:
                backend.kill(); backend.wait()
        atexit.register(close_backend)
        if not select.select([backend.stdout], [], [], 15)[0]:
            raise RuntimeError('Full source case storage did not start')
        storage = json.loads(backend.stdout.readline())
        source_env = {'HF_SOURCE_S3_ENDPOINT':storage['endpoint'],'HF_SOURCE_S3_REGION':storage['region'],'HF_SOURCE_S3_BUCKET':storage['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':storage['accessKey'],'HF_SOURCE_S3_SECRET_ACCESS_KEY':storage['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1','HF_SOURCE_CURSOR_KEY':'c291cmNlLWZ1bGwtY2FzZS1maXh0dXJlLWN1cnNvci1rZXk','HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608','HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
        source_components = ['source-control','14.4']
    components = component_closure(['fleet-orchestration', 'fleet-manager-effects', *source_components])
    credential_actions = None
    if source_components:
        granted = ['programme.activate', 'programme.provision', 'programme.dispatch']
        for name in component_closure(['1.4','4.1','4.2','4.4','14.1','3.1','3.2','5.1','5.2','5.3','5.4',*components]):
            granted += [action for action in json.loads((ROOT/'core/control-plane/components'/f'{name}.json').read_text())['actions'] if not action.startswith('source.') or action in source_actions]
        credential_actions = list(dict.fromkeys(granted))
    fleet = adoption.sched.SchedulerFixture(extra_components=components, extra_setup=setup, extra_env=source_env, credential_actions=credential_actions,
        provider_config={'provider':'fixture','account':'fixture','workspace':'native-source-fleet','region':'fixture','runtime_platform':'linux-amd64',
                         'image_digest':'sha256:'+hashlib.sha256(b'declared local native preparation').hexdigest()})
    try:
        inputs = fleet.path / 'native-source-fleet-inputs.json'
        inputs.write_text(json.dumps({'ids': fleet.ids, 'origin': fleet.origin, 'ca': str(fleet.ca),
                                     'keys': {name: str(value['path']) for name, value in fleet.keys.items()},
                                     'definition': fleet.definitions['a'], 'capacity': fleet.capacity(),
                                     'actions': fleet.actions, 'source_backend_endpoint': source_env.get('HF_SOURCE_S3_ENDPOINT')}))
        inputs.chmod(0o600)
        return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_fleet_actor.mjs', timeout=600 if os.environ.get('HF_SOURCE_FULL_CASE') == 'SCM-023' else 360,
                                        actor_env={**fleet.env, 'NATIVE_SOURCE_FLEET_INPUT': str(inputs), **({'NODE_OPTIONS':'--import='+str(ROOT/'node_modules/tsx/dist/loader.mjs')+' --conditions=source'} if os.environ.get('HF_SOURCE_FULL_CASE') == 'SCM-023' else {})}, extra_files=[
            'core/control-plane/src/agents/fleet_orchestration.ts',
            'core/control-plane/src/agents/fleet_source_actions.ts',
            'core/control-plane/src/agents/fleet_source_registration.ts',
            'core/control-plane/src/preparation/fleet_install.ts',
            'core/control-plane/src/preparation/fleet_readiness_probe.ts',
            'core/control-plane/src/preparation/fleet_isolation.ts',
            'core/control-plane/src/preparation/fleet_completion.ts',
            'core/control-plane/src/preparation/fleet_source.ts',
            'core/control-plane/src/storage/durability.ts',
            'core/control-plane/src/identity/enrollment.ts',
            'core/control-plane/src/identity/authorization.ts',
        ])
    finally:
        fleet.close()


@contextlib.contextmanager
def native_worker_uid_lock():
    """Fixed fixture worker UIDs belong to one live case at a time."""
    filename = '/tmp/hyperfide-native-worker-uids-' + str(os.getuid()) + '.lock'
    descriptor = os.open(filename, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC | os.O_NOFOLLOW, 0o600)
    try:
        current = os.fstat(descriptor)
        if not stat.S_ISREG(current.st_mode) or current.st_uid != os.getuid() or current.st_nlink != 1 or current.st_mode & 0o077:
            raise RuntimeError('Native worker fixture lock must be an owned private regular file')
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        os.close(descriptor)


def main():
    # Acquire only in the owned-database child; the outer withpg parent waits for it.
    if not os.environ.get('DATABASE_URL'):
        return _run()
    with native_worker_uid_lock():
        return _run()


if __name__ == '__main__':
    raise SystemExit(main())
