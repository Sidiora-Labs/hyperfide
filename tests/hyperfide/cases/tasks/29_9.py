#!/usr/bin/env python3
"""V-066 component probe: real useradd/groupadd --root into a temporary host tree, offline preflight, no providers."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = 'deploy/hyperfide/bootstrap-host.mjs'
DEPLOY = ROOT / 'deploy/hyperfide'
ROLES = {'control': ('hyperfide', 1900), 'provisioner': ('hyperfide-provisioner', 1901), 'dispatch': ('hyperfide-dispatch', 1902)}
IDENTITY = {'control': ['control-identity'], 'provisioner': ['provisioner-identity', 'provisioner-worker'], 'dispatch': ['dispatch-identity']}
GID = 1900
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


def invoke(args, env=None, code=None):
    p = subprocess.run(['node', SCRIPT, *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=45)
    result = json.loads(p.stdout)
    expect(result['services_started'] is False, result)
    expect(p.returncode == (78 if code else 0), (p.returncode, result, p.stderr))
    expect(result['outcome'] == ('REFUSED' if code else 'SUCCEEDED'), result)
    if code:
        expect(result['error']['code'] == code, result)
    return result


def owner_mode(path):
    stat = path.lstat()
    return stat.st_uid, stat.st_gid, stat.st_mode & 0o7777


def tree(host):
    return {str(p.relative_to(host)): (p.read_bytes(), owner_mode(p)) for p in sorted(host.rglob('*')) if p.is_file() and not p.is_symlink()}


def main():
    scratch = Path(tempfile.mkdtemp(prefix='hf-29-9-'))
    try:
        host = scratch / 'host'
        first = {}
        def accounts():
            first.update(invoke(['--root', str(host)]))
            group = {r.split(':')[0]: r.split(':') for r in (host/'etc/group').read_text().splitlines()}
            expect(int(group['hyperfide'][2]) == GID, group)
            passwd = {r.split(':')[0]: r.split(':') for r in (host/'etc/passwd').read_text().splitlines()}
            for user, uid in ROLES.values():
                expect(passwd[user][2:4] == [str(uid), str(GID)] and passwd[user][5:] == ['/nonexistent', '/usr/sbin/nologin'], passwd[user])
            shadow = {r.split(':')[0] for r in (host/'etc/shadow').read_text().splitlines()}
            expect({u for u, _ in ROLES.values()} <= shadow, 'useradd did not record shadow entries')
        check('host.bootstrap.accounts', accounts)
        def trees():
            etc = host/'etc/hyperfide'
            expect(owner_mode(etc) == (0, GID, 0o750) and owner_mode(host/'var/lib/hyperfide') == (0, GID, 0o750), 'shared trees')
            for role, (user, uid) in ROLES.items():
                for suffix in [role, role+'/authority-journal'] + ([role+'/preparation'] if role == 'provisioner' else []):
                    expect(owner_mode(host/'var/lib/hyperfide'/suffix) == (uid, GID, 0o700), suffix)
                env = etc/f'{role}.env'
                expect(env.read_bytes() == (DEPLOY/'env'/f'{role}.env.example').read_bytes() and owner_mode(env) == (0, 0, 0o600), env)
                expect('HYPERFIDE_MIGRATION_' not in env.read_text(), 'migration variable installed')
                policy = etc/f'{role}-policy.json'
                expect(policy.read_bytes() == (DEPLOY/'policies'/f'{role}.example.json').read_bytes() and owner_mode(policy) == (uid, GID, 0o600), policy)
                for name in IDENTITY[role]:
                    identity = etc/f'{name}.json'
                    expect(identity.read_bytes() == (DEPLOY/'identity'/f'{name}.example.json').read_bytes() and owner_mode(identity) == (uid, GID, 0o600), identity)
                unit = host/'etc/systemd/system'/f'hyperfide-{role}.service'
                expect(unit.read_bytes() == (DEPLOY/f'{role}.service').read_bytes() and owner_mode(unit) == (0, 0, 0o644), unit)
                expect(f'User={user}\n' in unit.read_text() and 'Group=hyperfide\n' in unit.read_text(), unit)
                dropins = Path(str(unit)+'.d')
                expect((dropins/'db-env.conf').read_text() == f'[Service]\nEnvironmentFile=/etc/hyperfide/{role}.db.env\n', 'db.env drop-in')
                expect((dropins/'preflight.conf').read_text() == f'[Service]\nExecStartPre=/opt/hyperfide/current/runtime/node /opt/hyperfide/current/deploy/hyperfide/bootstrap-host.mjs --preflight {role}\n', 'preflight drop-in')
                for name in [f'{role}.db.env', f'{role}.crt', f'{role}.key']:
                    expect(not (etc/name).exists() and '/etc/hyperfide/'+name in first['operator_pending'], name)
            for name in ['external-fence.json', 'pools.json', 'railway.json', 'provisioner-worker.key', 'dispatch-worker.json']:
                expect(not (etc/name).exists() and '/etc/hyperfide/'+name in first['operator_pending'], name)
            expect((etc/'grants.sql').read_bytes() == (DEPLOY/'grants.sql').read_bytes() and owner_mode(etc/'grants.sql') == (0, 0, 0o644), 'grants')
            expect(not list(host.rglob('.*.bootstrap-*')), 'temporary files left behind')
        check('host.bootstrap.trees-units-policies-grants', trees)
        def rerun():
            etc = host/'etc/hyperfide'
            (etc/'control.env').write_text('OPERATOR_SECRET=retain-exactly\n')
            secret = etc/'control.db.env'
            secret.write_text('HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL=postgresql://fixture:retain-exactly@localhost/fixture\n')
            secret.chmod(0o600)
            key = etc/'provisioner-worker.key'
            key.write_text('fixture key bytes, retained exactly\n')
            os.chown(key, 1901, GID)
            key.chmod(0o600)
            before = tree(host)
            result = invoke(['--root', str(host)])
            expect(result['created'] == [] and result['differs'] == [], result)
            expect('/etc/hyperfide/control.env' in result['kept'] and '/etc/hyperfide/control.db.env' not in result['operator_pending'], result)
            expect(tree(host) == before, 'rerun changed existing configuration, secrets or accounts')
        check('host.bootstrap.rerun-preserves-secrets', rerun)
        def symlink():
            target = host/'etc/hyperfide/dispatch.env'
            target.unlink()
            target.symlink_to('/etc/passwd')
            invoke(['--root', str(host)], code='BOOTSTRAP_CONFIG_UNSAFE')
        check('host.bootstrap.symlink-refused', symlink)
        def conflict():
            other = scratch/'conflict'
            (other/'etc').mkdir(parents=True)
            (other/'etc/passwd').write_text('root:x:0:0:root:/root:/usr/sbin/nologin\nhyperfide:x:1000:1000::/home/hyperfide:/bin/sh\n')
            (other/'etc/group').write_text('root:x:0:\nhyperfide:x:1900:\n')
            invoke(['--root', str(other)], code='BOOTSTRAP_IDENTITY_CONFLICT')
            expect(not (other/'etc/hyperfide').exists(), 'trees created for a conflicting account')
        check('host.bootstrap.identity-conflict', conflict)
        journal = scratch/'journal'
        journal.mkdir(mode=0o700)
        # Preflight requires the identity configuration file itself, not only its variable (hyperfide-v21 1.6).
        (scratch/'identity.json').write_text('{}')
        loose = scratch/'loose-journal'
        loose.mkdir()
        loose.chmod(0o755)
        env = {k: v for k, v in os.environ.items() if not k.startswith(('HYPERFIDE_', 'HF_'))}
        env.update(HYPERFIDE_REQUIRE_SYNC_REPLICA='0', HYPERFIDE_DEPLOYMENT_ID='11111111-1111-4111-8111-111111111111', HYPERFIDE_AUTHORITY_JOURNAL_DIR=str(journal),
                   HYPERFIDE_CAUSAL_BARRIER_KEY='a'*64, HYPERFIDE_SPEC_REVISION='fixture', HF_IDENTITY_CONFIG_FILE=str(scratch/'identity.json'),
                   HF_EVENT_DISPATCH_CONFIG=str(scratch/'dispatch-worker.json'), HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(scratch/'provisioner-worker.json'))
        for role in ROLES:
            prefix = '' if role == 'control' else role.upper()+'_'
            env['HYPERFIDE_'+prefix+'LISTEN_HOST'] = '127.0.0.1'
            env['HYPERFIDE_'+prefix+'LISTEN_PORT'] = '8443'
            env['HYPERFIDE_'+role.upper()+'_PRIMARY_DATABASE_URL'] = 'postgresql://fixture@localhost/fixture'
        def refusal(name, role, changes, code):
            altered = dict(env)
            for key, value in changes.items():
                if value is None:
                    altered.pop(key, None)
                else:
                    altered[key] = value
            check(name, lambda: invoke(['--preflight', role], altered, code))
        for role in ['control', 'dispatch']:
            check('preflight.'+role+'.positive', lambda role=role: invoke(['--preflight', role], env))
        for role in ROLES:
            for value, label in [(None, 'missing'), ('yes', 'unsafe')]:
                refusal(f'preflight.{role}.durability-{label}', role, {'HYPERFIDE_REQUIRE_SYNC_REPLICA': value}, 'DURABILITY_POLICY_REQUIRED')
            for key in ['HYPERFIDE_MIGRATION_DATABASE_URL', 'HYPERFIDE_MIGRATION_JOB']:
                refusal(f'preflight.{role}.{key}', role, {key: '1'}, 'MIGRATION_CREDENTIAL_EXPOSED')
            for key in ['HYPERFIDE_DEPLOYMENT_ID', 'HYPERFIDE_AUTHORITY_JOURNAL_DIR']:
                refusal(f'preflight.{role}.{key}', role, {key: None}, 'EXTERNAL_JOURNAL_REQUIRED')
            refusal(f'preflight.{role}.journal-unsafe', role, {'HYPERFIDE_AUTHORITY_JOURNAL_DIR': str(loose)}, 'EXTERNAL_JOURNAL_REQUIRED')
            refusal(f'preflight.{role}.identity', role, {'HF_IDENTITY_CONFIG_FILE': None}, 'IDENTITY_CONFIG_REQUIRED')
        refusal('preflight.control.barrier', 'control', {'HYPERFIDE_CAUSAL_BARRIER_KEY': None}, 'BARRIER_CONFIG_INVALID')
        refusal('preflight.dispatch.worker-config', 'dispatch', {'HF_EVENT_DISPATCH_CONFIG': None}, 'DISPATCH_CONFIG_REQUIRED')
        refusal('preflight.provisioner.executor-config', 'provisioner', {'HF_PROVISIONER_EXECUTOR_CONFIG_FILE': None}, 'PROVISIONER_EXECUTOR_CONFIG_INVALID')
        refusal('preflight.provisioner.fence-required', 'provisioner', {}, 'EXTERNAL_FENCE_CONFIG_REQUIRED')
        fence = scratch/'fence.json'
        fence.write_text('{}')
        fence.chmod(0o644)
        env['HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE'] = str(fence)
        refusal('preflight.provisioner.fence-unsafe', 'provisioner', {}, 'EXTERNAL_FENCE_CONFIG_UNSAFE')
        fence.chmod(0o600)
        refusal('preflight.provisioner.fence-invalid', 'provisioner', {}, 'EXTERNAL_FENCE_CONFIG_INVALID')
        topology = dict(schema_version=1, deployment_id=env['HYPERFIDE_DEPLOYMENT_ID'], organisation_id=env['HYPERFIDE_DEPLOYMENT_ID'], run_id=env['HYPERFIDE_DEPLOYMENT_ID'], source_epoch=None, evidence_scope='LIVE_PROVIDER', legacy_topology_digest='sha256:'+'a'*64, legacy_pid_namespace='pid:[1]', legacy_mount_namespace='mnt:[1]', required_writer_ids=['writer', 'uncovered'], resources=[dict(reference_key='fixture', topology_digest='sha256:'+'a'*64, writer_ids=['writer'], backend='PROVIDER')])
        config = dict(schema_version=1, topology=topology, journal_directory=str(journal), verifier_file=str(scratch/'verifier'), transport=dict(origin='https://localhost', host='127.0.0.1', port=8443, certificate='/fixture.crt', private_key='/fixture.key'))
        fence.write_text(json.dumps(config))
        refusal('preflight.provisioner.fence-incomplete', 'provisioner', {}, 'EXTERNAL_FENCE_CONFIG_INCOMPLETE')
        topology['required_writer_ids'] = ['writer']
        fence.write_text(json.dumps(config))
        refusal('preflight.provisioner.pool-required', 'provisioner', {}, 'POOL_CONFIG_REQUIRED')
        pool = scratch/'pools.json'
        limits = {'SANDBOX': '1', 'PROVISIONING': '1'}
        pool.write_text(json.dumps(dict(schema_version=1, organisation_id=env['HYPERFIDE_DEPLOYMENT_ID'], revision='fixture', maximum_operation_ms=1000, accounts=[dict(provider='railway', account_key='fixture', approved_limits=limits, planning_limits=limits)], pools=[dict(id=env['HYPERFIDE_DEPLOYMENT_ID'], provider='railway', account_key='fixture', environment_key='fixture', region='fixture', profile_id=None, preparation_digest='sha256:'+'a'*64, approved_limits=limits, planning_limits=limits, create_policy=dict(seed_reference='fixture', network='PRIVATE', stdin_required=False))])))
        pool.chmod(0o600)
        env['HYPERFIDE_POOL_CONFIG'] = str(pool)
        refusal('preflight.provisioner.railway-required', 'provisioner', {}, 'Railway trusted configuration missing')
        railway = scratch/'railway.json'
        railway.write_text(json.dumps(dict(schema_version=1, mode='component-fixture', endpoint='http://127.0.0.1:1', environment_id='fixture', region='fixture', account_id='fixture', token_env='HF_RAILWAY_TOKEN', auth_type='bearer', preparation_root=str(scratch), request_timeout_ms=1000, exec_ws_endpoint=None)))
        railway.chmod(0o600)
        env.update(HF_RAILWAY_CONFIG=str(railway), HF_RAILWAY_TOKEN='fixture-only')
        check('preflight.provisioner.positive', lambda: invoke(['--preflight', 'provisioner'], env))
        def examples():
            # Every variable a role's startup path reads must be named by its template; database URLs only as db.env lines.
            reads = {}
            for source in ['storage/durability', 'storage/replicas', 'recovery/fencing_service', 'providers/railway/preparation', 'identity/enrollment', 'events/dispatcher', 'providers/worker']:
                reads[source] = set(re.findall(r'env\.(HYPERFIDE_[A-Z_]+|HF_[A-Z_]+)', (ROOT/'core/control-plane/src'/f'{source}.ts').read_text()))
            common = {key for key in reads['storage/durability'] if not key.startswith('HYPERFIDE_MIGRATION_')} | reads['identity/enrollment'] | {'HYPERFIDE_SPEC_REVISION'}
            for role in ROLES:
                text = (DEPLOY/'env'/f'{role}.env.example').read_text()
                keys = set(re.findall(r'^([A-Z][A-Z0-9_]*)=', text, re.M))
                database = f'HYPERFIDE_{role.upper()}_PRIMARY_DATABASE_URL'
                expect(re.search(r'^# '+database+'=postgresql://', text, re.M) and database not in keys, (role, 'database URL must be a db.env line'))
                prefix = '' if role == 'control' else role.upper()+'_'
                required = common | {'HYPERFIDE_'+prefix+'LISTEN_'+suffix for suffix in ['HOST', 'PORT']}
                if role == 'control':
                    required |= reads['storage/replicas']
                if role == 'provisioner':
                    required |= reads['recovery/fencing_service'] | reads['providers/railway/preparation'] | reads['providers/worker'] | {'HYPERFIDE_POOL_CONFIG', 'HF_RAILWAY_TOKEN'}
                if role == 'dispatch':
                    required |= reads['events/dispatcher']
                expect(required <= keys, (role, sorted(required - keys)))
                expect('HYPERFIDE_MIGRATION_' not in text, 'migration variable in template')
        check('host.examples.runtime-required-reads', examples)
    finally:
        shutil.rmtree(scratch)
        print(json.dumps(dict(type='cleanup', resources=[], complete=not scratch.exists())), flush=True)
    return int(bool(FAILED))


if __name__ == '__main__':
    sys.exit(main())
