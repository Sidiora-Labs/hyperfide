"""Compile native source modules and run an actor on an owned temporary PostgreSQL server."""
import json
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]


def run_source_assignment_actor(actor_path, migrations, timeout=300):
    if not os.environ.get('DATABASE_URL'):
        return run_source_actor(actor_path, migrations=migrations, timeout=timeout)
    host = parse_qs(urlparse(os.environ['DATABASE_URL']).query).get('host', [''])[0]
    if not host.startswith('/tmp/hyperfide/hf-withpg-'):
        raise RuntimeError('Native source tests require an owned withpg socket')
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_prerequisite_fixture import component_closure
    spec = importlib.util.spec_from_file_location(
        'native_source_assignment_adoption', ROOT / 'tests/hyperfide/cases/tasks/3_4.py')
    adoption = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adoption)
    source_actions = ['source.fleet.bind-run', 'source.fleet.assign']

    def setup(instance):
        adoption.native_profiles(instance)
        identity = json.loads(instance.identity_config.read_text())
        for principal in identity['principals']:
            principal['allowed_actions'] += [action for action in source_actions
                                             if action not in principal['allowed_actions']]
            instance.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1',
                         [principal['credential_id'], principal['allowed_actions']])
        instance.identity_config.write_text(json.dumps(identity))
        instance.actions += [action for action in source_actions if action not in instance.actions]
        policy = json.loads(instance.policy.read_text())
        policy['allowed_actions'] += [action for action in source_actions
                                     if action not in policy['allowed_actions']]
        instance.policy.write_text(json.dumps(policy))

    fleet = adoption.sched.SchedulerFixture(
        extra_components=component_closure(['fleet-orchestration', 'fleet-manager-effects']),
        extra_setup=setup,
        provider_config={'provider': 'fixture', 'account': 'fixture',
                         'workspace': 'native-source-assignment', 'region': 'fixture',
                         'runtime_platform': 'linux-amd64',
                         'image_digest': 'sha256:' + hashlib.sha256(b'declared local native preparation').hexdigest()})
    try:
        inputs = fleet.path / 'native-source-assignment-inputs.json'
        inputs.write_text(json.dumps({
            'ids': fleet.ids, 'origin': fleet.origin, 'ca': str(fleet.ca),
            'keys': {name: str(value['path']) for name, value in fleet.keys.items()},
            'definition': fleet.definitions['a'], 'capacity': fleet.capacity(),
            'actions': fleet.actions,
        }))
        inputs.chmod(0o600)
        return run_source_actor(actor_path, migrations=migrations, timeout=timeout,
                                actor_env={**fleet.env, 'NATIVE_SOURCE_FLEET_INPUT': str(inputs)},
                                extra_files=[
                                    'core/control-plane/src/agents/fleet_orchestration.ts',
                                    'core/control-plane/src/agents/fleet_source_actions.ts',
                                    'core/control-plane/src/agents/fleet_source_registration.ts',
                                    'core/control-plane/src/preparation/fleet_install.ts',
                                    'core/control-plane/src/preparation/fleet_readiness_probe.ts',
                                    'core/control-plane/src/preparation/fleet_isolation.ts',
                                    'core/control-plane/src/preparation/fleet_completion.ts',
                                    'core/control-plane/src/storage/durability.ts',
                                    'core/control-plane/src/identity/enrollment.ts',
                                ])
    finally:
        fleet.close()


def default_source_migrations():
    directory = ROOT / 'core/control-plane/migrations'
    series = [path for path in sorted(directory.glob('*source-control*.sql'))
              if re.match(r'^\d+-', path.name) and int(path.name.split('-', 1)[0]) >= 736]
    identifier = r'[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?'
    dependencies = {}
    for path in series:
        sql = path.read_text()
        creates = set(re.findall(r'\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(' + identifier + r')', sql, re.I))
        references = set(re.findall(r'\bREFERENCES\s+(' + identifier + r')', sql, re.I))
        dependencies[path.name] = (creates, references)
    selected = list(dependencies)
    while True:
        tables = set().union(*(dependencies[name][0] for name in selected))
        eligible = [name for name in selected if dependencies[name][1] <= tables]
        if eligible == selected:
            return selected
        selected = eligible


def source_node_binary():
    override = os.environ.get('HYPERFIDE_NODE_BINARY')
    node = shutil.which(override or 'node')
    if not node:
        raise RuntimeError('CAPABILITY_MISSING: set HYPERFIDE_NODE_BINARY to an executable Node binary or install node on PATH')
    return node


def run_source_actor(actor_path, migrations=None, timeout=120, extra_files=(), actor_env=None):
    database = os.environ.get('DATABASE_URL', '')
    if not database:
        env = {k: v for k, v in os.environ.items() if k != 'DATABASE_URL'}
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--',
                               sys.executable, str(Path(sys.argv[0]).resolve()), *sys.argv[1:]],
                              cwd=ROOT, env=env).returncode
    host = parse_qs(urlparse(database).query).get('host', [''])[0]
    if not host.startswith('/tmp/hyperfide/hf-withpg-'):
        raise RuntimeError('Native source tests require an owned withpg socket')
    output = ROOT / 'build/source-control/actors'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-source-', dir=output) as temporary:
        folder = Path(temporary)
        (folder / 'package.json').write_text('{"type":"module"}\n')
        (folder / 'node_modules').symlink_to(ROOT / 'core/control-plane/node_modules', target_is_directory=True)
        (folder / 'migrations').symlink_to(ROOT / 'core/control-plane/migrations', target_is_directory=True)
        modules = ROOT / 'core/control-plane/src/source_control'
        config = {'compilerOptions': {'target': 'ES2023', 'module': 'NodeNext', 'moduleResolution': 'NodeNext',
                  'rootDir': str(ROOT / 'core/control-plane/src'), 'outDir': str(folder / 'control'),
                  'strict': True, 'noUncheckedIndexedAccess': True, 'exactOptionalPropertyTypes': True,
                  'noEmitOnError': True, 'skipLibCheck': True, 'types': ['node'],
                  'typeRoots': [str(ROOT / 'core/control-plane/node_modules/@types')]},
                  'files': [str(path) for path in sorted(modules.rglob('*.ts'))] +
                           [str(ROOT / path) for path in extra_files]}
        config_path = folder / 'tsconfig.json'
        config_path.write_text(json.dumps(config))
        subprocess.run([str(ROOT / 'core/control-plane/node_modules/.bin/tsc'), '-p', str(config_path)],
                       cwd=ROOT, check=True)
        for source in (ROOT / 'core/control-plane/src').rglob('*.mjs'):
            destination = folder / 'control' / source.relative_to(ROOT / 'core/control-plane/src')
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        subprocess.run([str(ROOT / 'core/control-plane/node_modules/.bin/tsc'), '-p',
                        str(ROOT / 'sdk/source-control/tsconfig.json'), '--outDir', str(folder / 'sdk')],
                       cwd=ROOT, check=True)
        selected_migrations = default_source_migrations() if migrations is None else list(migrations)
        if migrations is not None and '0737-source-control-metadata.sql' in selected_migrations and '0758-source-control-event-retention.sql' not in selected_migrations:
            selected_migrations.append('0758-source-control-event-retention.sql')
        if Path(actor_path).name == 'native_source_sparse_fixture.mjs':
            selected_migrations = sorted(set(selected_migrations) | set(default_source_migrations()))
        env = dict(os.environ, **(actor_env or {}), SOURCE_CONTROL_MODULE_ROOT=str(folder / 'control/source_control'),
                   SOURCE_CONTROL_SDK_MODULE_ROOT=str(folder / 'sdk'),
                   SOURCE_CONTROL_MIGRATIONS=json.dumps(selected_migrations))
        return subprocess.run([source_node_binary(), str(Path(actor_path).resolve()), str(folder / 'control/source_control')],
                              cwd=ROOT, env=env, timeout=timeout).returncode
