#!/usr/bin/env python3
"""Exercise native fleet source custody through actual runtime boundaries."""
import importlib.util
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


def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_prerequisite_fixture import component_closure
    adoption_spec = importlib.util.spec_from_file_location('native_fleet_adoption', ROOT / 'tests/hyperfide/cases/tasks/3_4.py')
    adoption = importlib.util.module_from_spec(adoption_spec)
    adoption_spec.loader.exec_module(adoption)
    source_actions = ['source.fleet.bind-run', 'source.fleet.assign', 'source.fleet.qualify', 'source.fleet.read', 'source.fleet.manifest', 'source.fleet.select', 'source.fleet.selection']

    def setup(instance):
        adoption.native_profiles(instance)
        identity = json.loads(instance.identity_config.read_text())
        for principal in identity['principals']:
            principal['allowed_actions'] += [action for action in source_actions if action not in principal['allowed_actions']]
            if principal['role'] == 'OPERATOR' and 'runner.dispatch.consume' not in principal['allowed_actions']:
                principal['allowed_actions'].append('runner.dispatch.consume')
            instance.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1', [principal['credential_id'], principal['allowed_actions']])
        instance.identity_config.write_text(json.dumps(identity))
        instance.actions += [action for action in source_actions if action not in instance.actions]
        policy = json.loads(instance.policy.read_text())
        policy['allowed_actions'] += [action for action in source_actions if action not in policy['allowed_actions']]
        instance.policy.write_text(json.dumps(policy))

    fleet = adoption.sched.SchedulerFixture(extra_components=component_closure(['fleet-orchestration', 'fleet-manager-effects']), extra_setup=setup,
        provider_config={'provider':'fixture','account':'fixture','workspace':'native-source-fleet','region':'fixture','runtime_platform':'linux-amd64',
                         'image_digest':'sha256:'+hashlib.sha256(b'declared local native preparation').hexdigest()})
    try:
        inputs = fleet.path / 'native-source-fleet-inputs.json'
        inputs.write_text(json.dumps({'ids': fleet.ids, 'origin': fleet.origin, 'ca': str(fleet.ca),
                                     'keys': {name: str(value['path']) for name, value in fleet.keys.items()},
                                     'definition': fleet.definitions['a'], 'capacity': fleet.capacity(),
                                     'actions': fleet.actions}))
        inputs.chmod(0o600)
        return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_fleet_actor.mjs', timeout=360,
                                        actor_env={**fleet.env, 'NATIVE_SOURCE_FLEET_INPUT': str(inputs)}, extra_files=[
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


if __name__ == '__main__':
    raise SystemExit(main())
