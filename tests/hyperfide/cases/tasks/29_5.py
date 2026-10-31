#!/usr/bin/env python3
"""Derive role policies from the component registry and test operator grants on an owned PostgreSQL cluster.

Run with --write-policies to regenerate deploy/hyperfide/policies/*.example.json from the same derivation.
"""
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
POLICIES = ROOT / 'deploy/hyperfide/policies'
ROLES = ('control', 'provisioner', 'dispatch')
FAILED = []
OBSERVED = []


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    OBSERVED.append({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual})
    print(json.dumps(OBSERVED[-1]), flush=True)


def declaration(relative, pattern):
    match = re.search(pattern, (SERVICE / relative).read_text(), re.S)
    if not match:
        raise AssertionError(relative + ' declaration changed; review the policy derivation')
    return match.group(1)


def required_actions():
    """Every action a role's registry admits, plus the dispatcher's own worker and route checks."""
    fragments = [json.loads(path.read_text()) for path in sorted((SERVICE / 'components').glob('*.json'))
                 if path.name != 'schema.json']
    boot = dict(re.findall(r"(\w+): '([^']+)'",
                           declaration('src/policy/programme.ts', r'const bootAction = \{([^}]*)\}\[role\]')))
    worker = re.findall(r"'([^']+)'", declaration(
        'src/events/dispatcher.ts', r'const required=\[(.*?)\.\.\.config\.routes\.map\(r=>r\.action\)\];'))
    # The release migration job admits authority activation and adoption against the shipped control policy.
    job = re.search(r"assertAdmission\(approved,'control',action==='--activate-authority'\?'([^']+)':'([^']+)'\)",
                    (ROOT / 'deploy/hyperfide/migrate.mjs').read_text())
    if sorted(boot) != sorted(ROLES) or not worker or not job:
        raise AssertionError('boot, dispatcher worker or migration job actions could not be derived')

    def registered(role):
        return {action for fragment in fragments if role in fragment['roles'] for action in fragment['actions']}
    actions = {role: registered(role) | {boot[role]} for role in ROLES}
    actions['control'] |= set(job.groups())
    # Operator routes invoke their action on control_origin, so every control action is a route candidate.
    actions['dispatch'] |= set(worker) | registered('control')
    return {role: sorted(items) for role, items in actions.items()}


def drift(policy, required):
    listed = set(policy['allowed_actions'])
    return sorted(set(required) - listed), sorted(listed - set(required))


def write_policies():
    for role, actions in required_actions().items():
        path = POLICIES / (role + '.example.json')
        policy = json.loads(path.read_text())
        policy.update({'allowed_roles': [role], 'allowed_actions': actions})
        path.write_text(json.dumps(policy, indent=2) + '\n')


def run(argv, env=None, data=None, timeout=120):
    p = subprocess.run(argv, cwd=ROOT, env=env, input=data, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return p.stdout


def node(script, env=None, data=None):
    return run(['node', '--input-type=module', '-e', script], env, data)


POLICY = r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {validatePolicy,assertAdmission} from './core/control-plane/dist/policy/programme.js';
const {role,mode,required}=JSON.parse(fs.readFileSync(0,'utf8'));
const policy=JSON.parse(fs.readFileSync(`deploy/hyperfide/policies/${role}.example.json`));
const boot={control:'programme.activate',provisioner:'programme.provision',dispatch:'programme.dispatch'}[role];
if(mode==='validate'){
 const p=validatePolicy(policy,policy.spec_revision,role);
 assert.deepEqual(p.allowed_roles,[role]);
}else if(mode==='admission'){
 const p=validatePolicy(policy,policy.spec_revision,role);
 for(const action of required)assertAdmission(p,role,action);
}else if(mode==='missing'){
 for(const action of required){
  const p={...policy,allowed_actions:policy.allowed_actions.filter(a=>a!==action)};
  assert.throws(()=>action===boot?validatePolicy(p,p.spec_revision,role):assertAdmission(validatePolicy(p,p.spec_revision,role),role,action),
   e=>e.code==='ACTION_DENIED','removed action was admitted: '+action);
 }
}else if(mode==='negative'){
 assert.throws(()=>validatePolicy({...policy,extra:true},policy.spec_revision,role),e=>e.code==='POLICY_INVALID');
 assert.throws(()=>validatePolicy(policy,'foreign-revision',role),e=>e.code==='REVISION_MISMATCH');
 assert.throws(()=>validatePolicy({...policy,status:'INACTIVE'},policy.spec_revision,role),e=>e.code==='PROGRAMME_INACTIVE');
 assert.throws(()=>validatePolicy({...policy,allowed_actions:[...policy.allowed_actions,policy.allowed_actions[0]]},policy.spec_revision,role),e=>e.code==='POLICY_INVALID');
 const other=role==='control'?'dispatch':'control';
 assert.throws(()=>validatePolicy(policy,policy.spec_revision,other),e=>e.code==='ROLE_DENIED');
}else throw Error('unknown probe mode');
"""

MIGRATE = """
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {MigrationCoordinator} from './core/control-plane/dist/storage/durability.js';
const signal=new AbortController().signal;
const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}
"""
RUNTIME = r"""
import assert from 'node:assert/strict';
import pg from './core/control-plane/node_modules/pg/lib/index.js';
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {assertRuntimePrivileges} from './core/control-plane/dist/storage/durability.js';
const role=process.env.HF_RUNTIME_ROLE,mode=process.env.HF_RUNTIME_MODE;
const r=createResourceContainer({role,env:process.env,signal:new AbortController().signal});
try{
 if(mode==='safe')await assertRuntimePrivileges(r);
 else if(mode==='unsafe')await assert.rejects(()=>assertRuntimePrivileges(r),e=>e.code==='RUNTIME_DDL_PRIVILEGE');
 else {
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  if(mode==='topology'){
   const p=(await c.query("SELECT has_function_privilege(current_user,'pg_catalog.pg_control_system()','EXECUTE') AS system,has_function_privilege(current_user,'pg_catalog.pg_control_checkpoint()','EXECUTE') AS checkpoint")).rows[0];
   assert(p.system&&p.checkpoint,JSON.stringify(p));
   const s=(await c.query('SELECT system_identifier FROM pg_catalog.pg_control_system()')).rows[0];
   const t=(await c.query('SELECT timeline_id FROM pg_catalog.pg_control_checkpoint()')).rows[0];
   assert(s.system_identifier&&t.timeline_id);
  }else if(mode==='topology-denied'){
   await assert.rejects(()=>c.query('SELECT system_identifier FROM pg_catalog.pg_control_system()'),e=>e.code==='42501');
  }else if(mode==='dml'){
   await c.query('BEGIN');
   const id=(await c.query("INSERT INTO hyperfide.organisations(id,name) VALUES(gen_random_uuid(),'grant-probe') RETURNING id")).rows[0].id;
   await c.query("UPDATE hyperfide.organisations SET name='updated',state_version=state_version+1 WHERE id=$1",[id]);
   await c.query('DELETE FROM hyperfide.organisations WHERE id=$1',[id]);
   await c.query('SELECT * FROM hyperfide.schema_migrations');await c.query('ROLLBACK');
  }else if(mode==='no-migration'){
   const row=(await c.query("SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,has_database_privilege(current_user,current_database(),'CREATE') AS db_create,has_schema_privilege(current_user,'hyperfide','CREATE') AS schema_create,EXISTS(SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(r.oid,p.oid,'MEMBER')) AS member,EXISTS(SELECT 1 FROM pg_namespace WHERE nspowner=r.oid) AS owns_schema,EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid) AS owns_table FROM pg_roles r WHERE rolname=current_user")).rows[0];
   assert(Object.values(row).every(v=>v===false),JSON.stringify(row));
   for(const sql of ['CREATE TABLE hyperfide.forbidden(id int)','CREATE TABLE public.forbidden(id int)',
    'INSERT INTO hyperfide.schema_migrations SELECT * FROM hyperfide.schema_migrations WHERE false',
    'DELETE FROM hyperfide.schema_migrations','UPDATE hyperfide.schema_migrations SET version=version',
    'TRUNCATE hyperfide.schema_migrations']){
    await assert.rejects(()=>c.query(sql),e=>e.code==='42501');
   }
  }else throw Error('unknown runtime mode');
 }finally{await c.end();}
 }
}finally{await r.close();}
"""

SUPERUSER, OPERATOR, DATABASE = 'hf_superuser', 'hf_operator', 'hyperfide'


def server_bins(installs=Path('/usr/lib/postgresql')):
    """Installed server bin/ directories, oldest major first."""
    # A client-only package installs bin/ without the server; only a directory with initdb can own a cluster.
    return sorted((path for path in installs.glob('*/bin')
                   if path.parent.name.isdigit() and (path / 'initdb').is_file()),
                  key=lambda path: int(path.parent.name))


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    installed = server_bins()
    if not installed:
        raise AssertionError('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    return installed[-1]


def cluster_precondition():
    """Why an owned cluster cannot run on this host, or None."""
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured and not (Path(configured) / 'initdb').is_file():
        return 'HYPERFIDE_PG_BIN has no initdb: ' + configured
    if not configured and not server_bins():
        return 'no PostgreSQL server binaries (initdb) under /usr/lib/postgresql; set HYPERFIDE_PG_BIN'
    if not shutil.which('runuser'):
        return 'runuser not on PATH'
    try:
        pwd.getpwnam('postgres')
    except KeyError:
        return 'no postgres OS user to own the cluster'
    return None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory."""

    def __init__(self):
        self.bin = postgres_bin()
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-grants-', dir='/tmp/hyperfide'))
        owner = pwd.getpwnam('postgres')
        os.chown(self.root, owner.pw_uid, owner.pw_gid)
        self.data = self.root / 'data'
        self.process = None
        self.server('initdb', '-D', self.data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (self.data / 'postgresql.conf').open('a') as conf:
            # Discarded after the run, so crash durability buys nothing; fsync stalls on a loaded host only skew deadlines.
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(self.root) + "'\n"
                       "fsync=off\nsynchronous_commit=off\n")
        # Keep the postmaster a direct child so stopping it leaves no reparented descendant behind.
        with (self.root / 'server.log').open('ab') as log:
            self.process = subprocess.Popen(['runuser', '-u', 'postgres', '--', str(self.bin / 'postgres'), '-D', str(self.data)],
                                            stdout=log, stderr=log)
        for _ in range(600):
            if self.process.poll() is not None:
                raise AssertionError('owned PostgreSQL failed to start')
            if subprocess.run([str(self.bin / 'pg_isready'), '-q', '-h', str(self.root), '-p', '5432']).returncode == 0:
                return
            time.sleep(0.05)
        raise AssertionError('owned PostgreSQL readiness deadline expired')

    def server(self, program, *args):
        return run(['runuser', '-u', 'postgres', '--', str(self.bin / program), *map(str, args)])

    def url(self, user):
        return 'postgresql://' + quote(user) + '@localhost:5432/' + DATABASE + '?host=' + quote(str(self.root), safe='')

    def psql(self, user, database, *args):
        return subprocess.run([str(self.bin / 'psql'), '-X', '-h', str(self.root), '-p', '5432', '-U', user,
                               '-d', database, '-v', 'ON_ERROR_STOP=1', *args],
                              cwd=ROOT, text=True, capture_output=True, timeout=60)

    def sql(self, statement, user=SUPERUSER, database=DATABASE):
        p = self.psql(user, database, '-Atc', statement)
        if p.returncode:
            raise AssertionError(p.stderr)
        return p.stdout.strip()

    def grants(self, operator, runtime_role):
        return self.psql(operator, DATABASE, '-v', 'runtime_role=' + runtime_role, '-f', 'deploy/hyperfide/grants.sql')

    def close(self):
        if self.process and self.process.poll() is None:
            self.server('pg_ctl', '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop')
        if self.process:
            self.process.wait(timeout=60)
        shutil.rmtree(self.root)
        return not self.root.exists()


def applied(p):
    # A grant the operator cannot make is only a WARNING; treat it as a failure like an error.
    if p.returncode or 'WARNING' in p.stderr or 'ERROR' in p.stderr:
        raise AssertionError('grant script did not apply cleanly: ' + p.stderr)


def refused(p, *expected):
    if p.returncode == 0:
        raise AssertionError('unsafe operator grant was accepted')
    missing = [text for text in expected if text not in p.stderr]
    if missing:
        raise AssertionError('refusal does not name ' + ', '.join(missing) + ': ' + p.stderr)


def main():
    # tests/run.sh skip contract: the grant checks need an owned cluster, so a host without one skips the whole case.
    absent = cluster_precondition()
    if absent:
        print('SKIP: ' + absent, flush=True)
        return 77
    base = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(base):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del base[key]
    required = {}
    check('policy.derivation', lambda: required.update(required_actions()))
    for role in ROLES:
        actions = required.get(role, [])

        def probe(mode, role=role, actions=actions):
            node(POLICY, base, json.dumps({'role': role, 'mode': mode, 'required': actions}))

        def shipped(role=role):
            return json.loads((POLICIES / (role + '.example.json')).read_text())

        def coverage(role=role, actions=actions):
            missing, extra = drift(shipped(role), actions)
            if not actions or missing or extra:
                raise AssertionError(role + ' policy drifted from the registry; missing actions: ' +
                                     ', '.join(missing) + '; unregistered actions: ' + ', '.join(extra) +
                                     '; regenerate with tests/hyperfide/cases/tasks/29_5.py --write-policies')

        def named(role=role, actions=actions, probe=probe):
            listed = shipped(role)['allowed_actions']
            for action in actions:
                missing, _ = drift({'allowed_actions': [item for item in listed if item != action]}, actions)
                if missing != [action]:
                    raise AssertionError('removed action not named: ' + action + ' -> ' + ', '.join(missing))
            probe('missing')
        check('policy.' + role + '.validate', lambda probe=probe: probe('validate'))
        check('policy.' + role + '.coverage', coverage)
        check('policy.' + role + '.admission', lambda probe=probe: probe('admission'))
        check('policy.' + role + '.missing-named', named)
        check('policy.' + role + '.negative', lambda probe=probe: probe('negative'))

    cluster = None
    clean = False
    try:
        cluster = Cluster()
        cluster.sql('CREATE ROLE ' + OPERATOR + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
                    database='postgres')
        cluster.sql('CREATE DATABASE ' + DATABASE + ' OWNER ' + OPERATOR, database='postgres')
        # Migrations run as the non-superuser database owner, the operator grants.sql expects.
        node(MIGRATE, {**base, 'DATABASE_URL': cluster.url(OPERATOR)})
        logins = {}
        for role in ROLES:
            login = 'hf_runtime_' + role
            logins[role] = login
            cluster.sql('CREATE ROLE ' + login + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT')
            check('grants.' + role + '.apply', lambda login=login: applied(cluster.grants(OPERATOR, login)))
            env = {**base, 'DATABASE_URL': cluster.url(login), 'HF_RUNTIME_ROLE': role}
            for mode in ('safe', 'topology', 'dml', 'no-migration'):
                check('grants.' + role + '.' + mode,
                      lambda mode=mode, env=env: node(RUNTIME, {**env, 'HF_RUNTIME_MODE': mode}))
            cluster.sql('GRANT CREATE ON SCHEMA hyperfide TO ' + login, OPERATOR)
            check('grants.' + role + '.unsafe-refused', lambda env=env: node(RUNTIME, {**env, 'HF_RUNTIME_MODE': 'unsafe'}))
            cluster.sql('REVOKE CREATE ON SCHEMA hyperfide FROM ' + login, OPERATOR)
        control = logins['control']
        control_env = {**base, 'DATABASE_URL': cluster.url(control), 'HF_RUNTIME_ROLE': 'control'}
        cluster.sql('ALTER ROLE ' + control + ' CREATEDB')
        check('grants.privileged-runtime-refused', lambda: node(RUNTIME, {**control_env, 'HF_RUNTIME_MODE': 'unsafe'}))
        check('grants.elevated-role-refused', lambda: refused(cluster.grants(OPERATOR, control), 'must be unprivileged'))
        cluster.sql('ALTER ROLE ' + control + ' NOCREATEDB')
        # Even NOINHERIT membership allows SET ROLE, so the operator script refuses it.
        cluster.sql('CREATE ROLE hf_migration NOLOGIN')
        cluster.sql('GRANT hf_migration TO ' + control)
        check('grants.membership-refused', lambda: refused(cluster.grants(OPERATOR, control), 'no role memberships'))
        cluster.sql('REVOKE hf_migration FROM ' + control)
        cluster.sql('CREATE TABLE public.owned_by_runtime(id int); ALTER TABLE public.owned_by_runtime OWNER TO ' + control)
        check('grants.owner-refused', lambda: refused(cluster.grants(OPERATOR, control), 'own no objects'))
        # Once PUBLIC EXECUTE is revoked only a superuser can grant it; the database owner must fail loudly.
        provisioner = logins['provisioner']
        provisioner_env = {**base, 'DATABASE_URL': cluster.url(provisioner), 'HF_RUNTIME_ROLE': 'provisioner'}
        cluster.sql('REVOKE EXECUTE ON FUNCTION pg_catalog.pg_control_system(), pg_catalog.pg_control_checkpoint() FROM PUBLIC')

        def operator_refused():
            refused(cluster.grants(OPERATOR, provisioner), 'pg_catalog.pg_control_system()', 'superuser')
            node(RUNTIME, {**provisioner_env, 'HF_RUNTIME_MODE': 'topology-denied'})
        check('grants.pg-control-operator-refused', operator_refused)

        def superuser_granted():
            applied(cluster.grants(SUPERUSER, provisioner))
            for mode in ('safe', 'topology', 'no-migration'):
                node(RUNTIME, {**provisioner_env, 'HF_RUNTIME_MODE': mode})
        check('grants.pg-control-superuser-granted', superuser_granted)
    except Exception as error:
        FAILED.append('fixture')
        print(str(error), file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
        output = Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR', '/tmp/hyperfide/task29-5-direct'))
        output.mkdir(parents=True, exist_ok=True)
        (output / 'policy-grants-observations.json').write_text(
            json.dumps({'assertions': OBSERVED, 'cluster_removed': clean}, indent=2) + '\n')
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    if sys.argv[1:] == ['--write-policies']:
        write_policies()
        sys.exit(0)
    sys.exit(main())
