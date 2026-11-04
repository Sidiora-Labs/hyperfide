#!/usr/bin/env python3
"""Real signed profile registration against admitted native source; no provider calls."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], cwd=ROOT).returncode
    adoption = load('native_profile_adoption', 'tests/hyperfide/cases/tasks/3_4.py')
    provider = load('native_profile_provider', 'tests/hyperfide/cases/tasks/8_3.py')
    runtime = load('native_profile_source_fixture', 'tests/hyperfide/support/native_source_fixture.py')
    actions = ['source.fleet.bind-run', 'source.fleet.read']

    def setup(instance):
        adoption.native_profiles(instance)
        provider.prepare_provider_intent_fixture(instance)
        identities = json.loads(instance.identity_config.read_text())
        for principal in identities['principals']:
            principal['allowed_actions'] += [action for action in actions if action not in principal['allowed_actions']]
            instance.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1', [principal['credential_id'], principal['allowed_actions']])
        instance.identity_config.write_text(json.dumps(identities))
        instance.actions += actions
        policy = json.loads(instance.policy.read_text())
        policy['allowed_actions'] += actions
        instance.policy.write_text(json.dumps(policy))

    fixture = adoption.sched.SchedulerFixture(extra_components=component_closure(['8.2']), extra_setup=setup)
    try:
        manifest = fixture.sql('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2', [fixture.ids['organisation'], fixture.profile])[0]['manifest']
        inputs = fixture.path / 'native-profile-inputs.json'
        inputs.write_text(json.dumps({'ids': fixture.ids, 'origin': fixture.origin, 'ca': str(fixture.ca), 'config_file': str(fixture.configfile), 'manifest': manifest,
                                      'keys': {name: str(value['path']) for name, value in fixture.keys.items()}, 'expect_old': '--expect-old' in sys.argv[1:]}))
        inputs.chmod(0o600)
        return runtime.run_source_actor(ROOT / 'tests/hyperfide/support/native_profile_registration.mjs', timeout=180,
                                        actor_env={**fixture.env, 'NATIVE_PROFILE_INPUT': str(inputs)}, extra_files=['core/control-plane/src/providers/pools.ts', 'core/control-plane/src/identity/enrollment.ts'])
    finally:
        fixture.close()


if __name__ == '__main__':
    raise SystemExit(main())
