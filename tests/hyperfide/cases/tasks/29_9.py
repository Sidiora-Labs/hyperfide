#!/usr/bin/env python3
"""V-066 component probe: real chroot useradd, offline preflight, no providers."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
SCRIPT = 'deploy/hyperfide/bootstrap-host.mjs'
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


def main():
    scratch = Path(tempfile.mkdtemp(prefix='hf-29-9-'))
    try:
        host = scratch / 'host'
        check('host.bootstrap.accounts', lambda: expect(invoke(['--root', str(host)])['users'] == 'useradd', 'real useradd required'))
        accounts = {r.split(':')[0]: r.split(':') for r in (host/'etc/passwd').read_text().splitlines()}
        def trees():
            for role in ['control', 'provisioner', 'dispatch']:
                row = accounts['hyperfide' + ('' if role == 'control' else '-'+role)]
                uid, gid = int(row[2]), int(row[3])
                expect(uid != 0 and row[5:] == ['/nonexistent', '/usr/sbin/nologin'], row)
                for suffix in [role, role+'/authority-journal']:
                    stat = (host/'var/lib/hyperfide'/suffix).stat()
                    expect((stat.st_uid, stat.st_gid, stat.st_mode & 0o777) == (uid, gid, 0o700), suffix)
                policy = host/'etc/hyperfide'/f'{role}-policy.json'
                expect(policy.read_bytes() == (ROOT/'deploy/hyperfide/policies'/f'{role}.example.json').read_bytes(), role)
                expect((policy.stat().st_uid, policy.stat().st_mode & 0o777) == (uid, 0o600), role)
                unit = (host/'etc/systemd/system'/f'hyperfide-{role}.service').read_text()
                expect(f'--preflight {role}' in unit and f'User={row[0]}' in unit, unit)
                expect(unit.index('ExecStartPre=') < unit.index('ExecStart='), 'preflight ordering')
            expect((host/'etc/hyperfide/grants.sql').read_bytes() == (ROOT/'deploy/hyperfide/grants.sql').read_bytes(), 'grants')
        check('host.bootstrap.trees-units-policies-grants', trees)
        def rerun():
            secret = host/'etc/hyperfide/control.env'
            secret.write_text('OPERATOR_SECRET=retain-exactly\n')
            before = {str(p.relative_to(host)): p.read_bytes() for p in host.rglob('*') if p.is_file()}
            invoke(['--root', str(host)])
            after = {str(p.relative_to(host)): p.read_bytes() for p in host.rglob('*') if p.is_file()}
            expect(before == after, 'rerun changed existing configuration or accounts')
        check('host.bootstrap.rerun-preserves-secrets', rerun)
        def symlink():
            target = host/'etc/hyperfide/dispatch.env'
            target.unlink()
            target.symlink_to('/etc/passwd')
            invoke(['--root', str(host)], code='BOOTSTRAP_CONFIG_UNSAFE')
        check('host.bootstrap.symlink-refused', symlink)
        journal = scratch/'journal'
        journal.mkdir(mode=0o700)
        env = {k:v for k,v in os.environ.items() if not k.startswith(('HYPERFIDE_', 'HF_RAILWAY_'))}
        env.update(HYPERFIDE_REQUIRE_SYNC_REPLICA='0', HYPERFIDE_DEPLOYMENT_ID='11111111-1111-4111-8111-111111111111', HYPERFIDE_AUTHORITY_JOURNAL_DIR=str(journal), HYPERFIDE_CAUSAL_BARRIER_KEY='a'*64, HYPERFIDE_SPEC_REVISION='fixture')
        for role in ['control','provisioner','dispatch']:
            prefix = '' if role=='control' else role.upper()+'_'
            env['HYPERFIDE_'+prefix+'LISTEN_HOST']='127.0.0.1'
            env['HYPERFIDE_'+prefix+'LISTEN_PORT']='8443'
            env['HYPERFIDE_'+role.upper()+'_PRIMARY_DATABASE_URL']='postgresql://fixture@localhost/fixture'
        def refusal(name, role, changes, code):
            altered = dict(env)
            for key, value in changes.items():
                if value is None:
                    altered.pop(key, None)
                else:
                    altered[key] = value
            check(name, lambda: invoke(['--preflight',role], altered, code))
        for role in ['control', 'dispatch']:
            check('preflight.'+role+'.positive', lambda role=role: invoke(['--preflight',role], env))
        for role in ['control','provisioner','dispatch']:
            for value, label in [(None,'missing'),('yes','unsafe')]:
                refusal(f'preflight.{role}.durability-{label}',role,{'HYPERFIDE_REQUIRE_SYNC_REPLICA':value},'DURABILITY_POLICY_REQUIRED')
            for key in ['HYPERFIDE_MIGRATION_DATABASE_URL','HYPERFIDE_MIGRATION_JOB']:
                refusal(f'preflight.{role}.{key}',role,{key:'1'},'MIGRATION_CREDENTIAL_EXPOSED')
            for key in ['HYPERFIDE_DEPLOYMENT_ID','HYPERFIDE_AUTHORITY_JOURNAL_DIR']:
                refusal(f'preflight.{role}.{key}',role,{key:None},'EXTERNAL_JOURNAL_REQUIRED')
        refusal('preflight.control.barrier','control',{'HYPERFIDE_CAUSAL_BARRIER_KEY':None},'BARRIER_CONFIG_INVALID')
        refusal('preflight.provisioner.fence-required','provisioner',{},'EXTERNAL_FENCE_CONFIG_REQUIRED')
        fence = scratch/'fence.json'
        fence.write_text('{}')
        fence.chmod(0o644)
        env['HYPERFIDE_EXTERNAL_FENCE_CONFIG_FILE']=str(fence)
        refusal('preflight.provisioner.fence-unsafe','provisioner',{},'EXTERNAL_FENCE_CONFIG_UNSAFE')
        fence.chmod(0o600)
        refusal('preflight.provisioner.fence-invalid','provisioner',{},'EXTERNAL_FENCE_CONFIG_INVALID')
        topology = dict(schema_version=1, deployment_id=env['HYPERFIDE_DEPLOYMENT_ID'], organisation_id=env['HYPERFIDE_DEPLOYMENT_ID'], run_id=env['HYPERFIDE_DEPLOYMENT_ID'], source_epoch=None, evidence_scope='LIVE_PROVIDER', legacy_topology_digest='sha256:'+'a'*64, legacy_pid_namespace='pid:[1]', legacy_mount_namespace='mnt:[1]', required_writer_ids=['writer','uncovered'], resources=[dict(reference_key='fixture',topology_digest='sha256:'+'a'*64,writer_ids=['writer'],backend='PROVIDER')])
        config=dict(schema_version=1, topology=topology,journal_directory=str(journal),verifier_file=str(scratch/'verifier'),transport=dict(origin='https://localhost',host='127.0.0.1',port=8443,certificate='/fixture.crt',private_key='/fixture.key'))
        fence.write_text(json.dumps(config))
        refusal('preflight.provisioner.fence-incomplete','provisioner',{},'EXTERNAL_FENCE_CONFIG_INCOMPLETE')
        topology['required_writer_ids']=['writer']
        fence.write_text(json.dumps(config))
        refusal('preflight.provisioner.pool-required','provisioner',{},'POOL_CONFIG_REQUIRED')
        pool=scratch/'pools.json'
        limits={'SANDBOX':'1','PROVISIONING':'1'}
        pool.write_text(json.dumps(dict(schema_version=1,organisation_id=env['HYPERFIDE_DEPLOYMENT_ID'],revision='fixture',maximum_operation_ms=1000,accounts=[dict(provider='railway',account_key='fixture',approved_limits=limits,planning_limits=limits)],pools=[dict(id=env['HYPERFIDE_DEPLOYMENT_ID'],provider='railway',account_key='fixture',environment_key='fixture',region='fixture',profile_id=None,preparation_digest='sha256:'+'a'*64,approved_limits=limits,planning_limits=limits,create_policy=dict(seed_reference='fixture',network='PRIVATE',stdin_required=False))])))
        pool.chmod(0o600)
        env['HYPERFIDE_POOL_CONFIG']=str(pool)
        refusal('preflight.provisioner.railway-required','provisioner',{},'Railway trusted configuration missing')
        railway=scratch/'railway.json'
        railway.write_text(json.dumps(dict(schema_version=1,mode='component-fixture',endpoint='http://127.0.0.1:1',environment_id='fixture',region='fixture',account_id='fixture',token_env='HF_RAILWAY_TOKEN',auth_type='bearer',preparation_root=str(scratch),request_timeout_ms=1000,exec_ws_endpoint=None)))
        railway.chmod(0o600)
        env.update(HF_RAILWAY_CONFIG=str(railway),HF_RAILWAY_TOKEN='fixture-only')
        check('preflight.provisioner.positive',lambda:invoke(['--preflight','provisioner'],env))
        def examples():
            # Derive shared and role-specific required reads from reviewed runtime sources.
            import re
            reads = {}
            for source in ['storage/durability','storage/replicas','recovery/fencing_service','providers/pools','providers/railway/preparation']:
                reads[source]=set(re.findall(r'env\.(HYPERFIDE_[A-Z_]+|HF_[A-Z_]+)',(ROOT/'services/hyperfide/src'/f'{source}.ts').read_text()))
            common={key for key in reads['storage/durability'] if not key.startswith('HYPERFIDE_MIGRATION_')}
            for role in ['control','provisioner','dispatch']:
                text=(ROOT/'deploy/hyperfide/env'/f'{role}.env.example').read_text()
                keys={line.split('=',1)[0] for line in text.splitlines() if line and not line.startswith('#')}
                required=common|{f'HYPERFIDE_{role.upper()}_PRIMARY_DATABASE_URL','HYPERFIDE_SPEC_REVISION'}
                prefix='' if role=='control' else role.upper()+'_'
                required|={'HYPERFIDE_'+prefix+'LISTEN_'+suffix for suffix in ['HOST','PORT']}
                if role=='control':required|=reads['storage/replicas']
                if role=='provisioner':required|=reads['recovery/fencing_service']|reads['providers/railway/preparation']|{'HYPERFIDE_POOL_CONFIG','HF_RAILWAY_TOKEN'}
                expect(required<=keys,(role,required-keys))
                expect('HYPERFIDE_MIGRATION_' not in text, 'migration secret in template')
        check('host.examples.runtime-required-reads',examples)
    finally:
        shutil.rmtree(scratch)
        print(json.dumps(dict(type='cleanup',resources=[],complete=not scratch.exists())),flush=True)
    return int(bool(FAILED))


if __name__ == '__main__':
    sys.exit(main())
