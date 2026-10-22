#!/usr/bin/env python3
"""hyperfide-v21 1.6: a clean host bootstraps from tracked inputs only; a missing input refuses before any write and is named."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
DEPLOY = ROOT / 'deploy/hyperfide'
ROLES = {'control': ('hyperfide', 1900), 'provisioner': ('hyperfide-provisioner', 1901), 'dispatch': ('hyperfide-dispatch', 1902)}
EXAMPLES = ['control-identity', 'provisioner-identity', 'provisioner-worker', 'dispatch-identity']
INPUTS = ['grants.sql'] + [p for role in ROLES for p in (f'env/{role}.env.example', f'policies/{role}.example.json', f'{role}.service')] + [f'identity/{n}.example.json' for n in EXAMPLES]
FAILED = []


def expect(value, message):
    if not value:
        raise AssertionError(message)


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = str(error)
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


def invoke(script, args, env=None, code=None):
    p = subprocess.run(['node', str(script), *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=60)
    result = json.loads(p.stdout)
    expect(result['services_started'] is False, result)
    expect(p.returncode == (78 if code else 0), (p.returncode, result, p.stderr))
    expect(result['outcome'] == ('REFUSED' if code else 'SUCCEEDED'), result)
    if code:
        expect(result['error']['code'] == code, result)
    return result


def release(scratch, name, drop=()):
    """A release tree holding only tracked bootstrap inputs, minus the ones dropped."""
    base = scratch / name / 'deploy/hyperfide'
    for rel in ['bootstrap-host.mjs', *INPUTS]:
        if rel in drop:
            continue
        (base / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(DEPLOY / rel, base / rel)
    return base / 'bootstrap-host.mjs'


def ignored(rel):
    return subprocess.run(['git', 'check-ignore', '-q', '--no-index', rel], cwd=ROOT).returncode == 0


def main():
    scratch = Path(tempfile.mkdtemp(prefix='hf-v21-1-6-'))
    try:
        def tracked_examples():
            for name in EXAMPLES:
                rel = f'deploy/hyperfide/identity/{name}.example.json'
                expect((ROOT / rel).is_file(), rel + ' absent from the tree')
                expect(not ignored(rel), rel + ' is ignored')
                json.loads((ROOT / rel).read_text())
            for rel in ['deploy/hyperfide/identity/control-identity.json', 'deploy/hyperfide/identity/provisioner-worker.key']:
                expect(ignored(rel), rel + ' (a real identity) is not ignored')
        check('identity.examples-tracked-real-ignored', tracked_examples)

        def clean_host():
            host = scratch / 'host'
            result = invoke(release(scratch, 'full'), ['--root', str(host)])
            for role in ROLES:
                expect((host / f'etc/hyperfide/{role}.env').is_file(), role + ' env not placed')
            for name in EXAMPLES:
                expect((host / f'etc/hyperfide/{name}.json').read_bytes() == (DEPLOY / f'identity/{name}.example.json').read_bytes(), name)
            for name in ['dispatch-worker.json', 'dispatch-worker.key', 'provisioner-worker.key']:
                expect('/etc/hyperfide/' + name in result['operator_pending'], (name, result['operator_pending']))
        check('bootstrap.clean-host-from-tracked-inputs', clean_host)

        for index, rel in enumerate(INPUTS):
            def missing_one(rel=rel, index=index):
                host = scratch / f'host-missing-{index}'
                result = invoke(release(scratch, f'missing-{index}', drop={rel}), ['--root', str(host)], code='BOOTSTRAP_INPUT_MISSING')
                expect(result['error']['missing'] == ['deploy/hyperfide/' + rel], result)
                expect(not host.exists(), 'bootstrap wrote under the root before refusing: ' + rel)
            check('bootstrap.missing.' + rel, missing_one)

        def missing_all_named():
            host = scratch / 'host-missing-all'
            dropped = {'grants.sql', 'identity/dispatch-identity.example.json', 'policies/control.example.json'}
            result = invoke(release(scratch, 'missing-all', drop=dropped), ['--root', str(host)], code='BOOTSTRAP_INPUT_MISSING')
            expect(set(result['error']['missing']) == {'deploy/hyperfide/' + d for d in dropped}, result)
            expect(not host.exists(), 'bootstrap wrote under the root before refusing')
        check('bootstrap.missing.every-name-at-once', missing_all_named)

        journal = scratch / 'journal'
        journal.mkdir(mode=0o700)
        identity = scratch / 'identity.json'
        identity.write_text('{}')
        base = {k: v for k, v in os.environ.items() if not k.startswith(('HYPERFIDE_', 'HF_'))}
        base.update(HYPERFIDE_REQUIRE_SYNC_REPLICA='0', HYPERFIDE_DEPLOYMENT_ID='11111111-1111-4111-8111-111111111111', HYPERFIDE_AUTHORITY_JOURNAL_DIR=str(journal),
                    HYPERFIDE_SPEC_REVISION='fixture', HF_IDENTITY_CONFIG_FILE=str(identity))
        required = {}
        for role in ROLES:
            prefix = '' if role == 'control' else role.upper() + '_'
            env = dict(base)
            env['HYPERFIDE_' + prefix + 'LISTEN_HOST'] = '127.0.0.1'
            env['HYPERFIDE_' + prefix + 'LISTEN_PORT'] = '8443'
            env['HYPERFIDE_' + role.upper() + '_PRIMARY_DATABASE_URL'] = 'postgresql://fixture@localhost/fixture'
            if role == 'control':
                env['HYPERFIDE_CAUSAL_BARRIER_KEY'] = 'a' * 64
            if role == 'dispatch':
                env['HF_EVENT_DISPATCH_CONFIG'] = str(scratch / 'dispatch-worker.json')
            required[role] = env
        script = DEPLOY / 'bootstrap-host.mjs'
        for role in ['control', 'dispatch']:
            check(f'preflight.{role}.positive', lambda role=role: invoke(script, ['--preflight', role], required[role]))
            for name in sorted(k for k in required[role] if k.startswith(('HYPERFIDE_', 'HF_'))):
                def missing_var(role=role, name=name):
                    env = dict(required[role])
                    env.pop(name)
                    result = invoke(script, ['--preflight', role], env, code=code_for(name))
                    expect(result['error']['missing'] == [name], (name, result))
                check(f'preflight.{role}.missing.{name}', missing_var)

            def missing_everything(role=role):
                env = {k: v for k, v in base.items() if not k.startswith(('HYPERFIDE_', 'HF_'))}
                result = invoke(script, ['--preflight', role], env, code='DURABILITY_POLICY_REQUIRED')
                want = {k for k in required[role] if k.startswith(('HYPERFIDE_', 'HF_'))}
                expect(want <= set(result['error']['missing']), (sorted(want - set(result['error']['missing'])), result))
            check(f'preflight.{role}.missing.every-name-at-once', missing_everything)

        def identity_file_absent():
            env = dict(required['control'], HF_IDENTITY_CONFIG_FILE=str(scratch / 'absent-identity.json'))
            result = invoke(script, ['--preflight', 'control'], env, code='IDENTITY_CONFIG_REQUIRED')
            expect(result['error']['missing'] == [str(scratch / 'absent-identity.json')], result)
        check('preflight.identity-file-absent', identity_file_absent)

        def railway_live_names():
            railway = scratch / 'railway.json'
            railway.write_text(json.dumps(dict(schema_version=1, mode='live')))
            env = dict(required['provisioner'], HF_RAILWAY_CONFIG=str(railway))
            env.pop('HYPERFIDE_REQUIRE_SYNC_REPLICA')
            result = invoke(script, ['--preflight', 'provisioner'], env, code='DURABILITY_POLICY_REQUIRED')
            want = {'HYPERFIDE_REQUIRE_SYNC_REPLICA', 'HF_PROVISIONER_EXECUTOR_CONFIG_FILE', 'HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE', 'HYPERFIDE_POOL_CONFIG',
                    'HF_RAILWAY_RUNTIME_POLICY', 'HF_RAILWAY_RUNTIME_POLICY_DIGEST', 'HF_RAILWAY_PROCESS_ROOT', 'HF_CREDENTIAL_CONFIG_FILE'}
            expect(set(result['error']['missing']) == want, (sorted(want ^ set(result['error']['missing'])), result))
            railway.write_text(json.dumps(dict(schema_version=1, mode='component-fixture')))
            result = invoke(script, ['--preflight', 'provisioner'], env, code='DURABILITY_POLICY_REQUIRED')
            expect(not {'HF_RAILWAY_PROCESS_ROOT', 'HF_CREDENTIAL_CONFIG_FILE'} & set(result['error']['missing']), ('fixture mode needs no live names', result))
        check('preflight.provisioner.railway-live-names', railway_live_names)
    finally:
        shutil.rmtree(scratch)
        print(json.dumps(dict(type='cleanup', resources=[], complete=not scratch.exists())), flush=True)
    return int(bool(FAILED))


def code_for(name):
    """The specific refusal code each absent variable keeps (docs/hyperfide/operations.md preflight table)."""
    if name == 'HYPERFIDE_REQUIRE_SYNC_REPLICA':
        return 'DURABILITY_POLICY_REQUIRED'
    if name in ('HYPERFIDE_DEPLOYMENT_ID', 'HYPERFIDE_AUTHORITY_JOURNAL_DIR'):
        return 'EXTERNAL_JOURNAL_REQUIRED'
    if name.endswith('_PRIMARY_DATABASE_URL'):
        return 'DATABASE_CONFIG_INVALID'
    return {'HYPERFIDE_CAUSAL_BARRIER_KEY': 'BARRIER_CONFIG_INVALID', 'HF_IDENTITY_CONFIG_FILE': 'IDENTITY_CONFIG_REQUIRED',
            'HF_EVENT_DISPATCH_CONFIG': 'DISPATCH_CONFIG_REQUIRED'}.get(name, 'TRANSPORT_CONFIG')


if __name__ == '__main__':
    sys.exit(main())
