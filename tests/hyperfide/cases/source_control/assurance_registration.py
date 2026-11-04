#!/usr/bin/env python3
"""Register and use native assurance authority through real signed identities."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT/'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode
    fixture = load('native_assurance_fixture', ROOT/'tests/hyperfide/support/native_source_fixture.py')
    scheduler = load('native_assurance_scheduler', ROOT/'tests/hyperfide/cases/tasks/5_1.py')
    actions = ['source.capabilities','source.capabilities.manage','source.objects.put','source.objects.read','source.revisions.create','source.revisions.read','source.assurance.policy.register','source.assurance.checker.register','source.assurance.custody.create','source.assurance.publish','source.assurance.revoke','source.domains.create','source.candidates.create','source.candidates.qualify','source.acceptance.accept','source.fleet.bind-run']
    def setup(instance):
        config = json.loads(instance.identity_config.read_text())
        for principal in config['principals']:
            principal['allowed_actions'] = list(dict.fromkeys(principal['allowed_actions'] + actions + ['identity.service.issue','identity.principal.renew','identity.principal.revoke','spec.proof.register']))
            instance.sql('UPDATE hyperfide.identity_principals SET allowed_actions=$2 WHERE credential_id=$1', [principal['credential_id'], principal['allowed_actions']])
        instance.identity_config.write_text(json.dumps(config))
        instance.actions = list(dict.fromkeys(instance.actions + actions))
        policy = json.loads(instance.policy.read_text())
        policy['allowed_actions'] = list(dict.fromkeys(policy['allowed_actions'] + actions))
        instance.policy.write_text(json.dumps(policy))
    active = scheduler.SchedulerFixture(extra_components=['2.4'], extra_setup=setup)
    try:
        descriptor = active.path/'native-assurance-registration.json'
        descriptor.write_text(json.dumps({'ids':active.ids,'origin':active.origin,'keys':{name:str(value['path']) for name,value in active.keys.items()},'definition':active.definitions['a'],'actions':actions}))
        descriptor.chmod(0o600)
        return fixture.run_source_actor(ROOT/'tests/hyperfide/support/native_source_assurance_registration.mjs', timeout=180, actor_env={**active.env,'NATIVE_ASSURANCE_REGISTRATION_INPUT':str(descriptor)}, extra_files=['core/control-plane/src/identity/enrollment.ts','core/control-plane/src/storage/durability.ts'])
    finally:
        active.close()

if __name__ == '__main__':
    raise SystemExit(main())
