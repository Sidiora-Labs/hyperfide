#!/usr/bin/env python3
"""Review shipped policies against fragments and test operator grants on owned PostgreSQL."""
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
from urllib.parse import quote, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[4]
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


def run(argv, env=None, data=None):
    p = subprocess.run(argv, cwd=ROOT, env=env, input=data, text=True,
                       capture_output=True, timeout=90)
    if p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return p.stdout


def node(script, env=None):
    return run(['node', '--input-type=module', '-e', script], env)


POLICY = r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {validatePolicy,assertAdmission} from './services/hyperfide/dist/policy/programme.js';
const role=process.env.HF_POLICY_ROLE, mode=process.env.HF_POLICY_MODE;
const policy=JSON.parse(fs.readFileSync(`deploy/hyperfide/policies/${role}.example.json`));
const fragments=fs.readdirSync('services/hyperfide/components').filter(n=>n.endsWith('.json')&&n!=='schema.json')
 .map(n=>JSON.parse(fs.readFileSync('services/hyperfide/components/'+n)));
// Routes are operator-configured, with no fixed shipped route list. Cover every
// registered route candidate, including remote control/provisioner actions.
const required=new Set(fragments.filter(f=>role==='dispatch'||f.roles.includes(role)).flatMap(f=>f.actions));
required.add({control:'programme.activate',provisioner:'programme.provision',dispatch:'programme.dispatch'}[role]);
if(role==='dispatch'){
 const source=fs.readFileSync('services/hyperfide/src/events/dispatcher.ts','utf8');
 const list=source.match(/const required=\[(.*?)\.\.\.config\.routes\.map\(r=>r\.action\)\];/s);
 assert(list,'dispatcher action declaration changed; review coverage derivation');
 for(const match of list[1].matchAll(/'([^']+)'/g))required.add(match[1]);
}
const missing=p=>[...required].filter(a=>!p.allowed_actions.includes(a)).sort();
if(mode==='validate'){
 const p=validatePolicy(policy,policy.spec_revision,role);
 assert.deepEqual(p.allowed_roles,[role]);
}else if(mode==='coverage'){
 assert.deepEqual(missing(policy),[],role+' missing actions: '+missing(policy).join(', '));
}else if(mode==='admission'){
 const p=validatePolicy(policy,policy.spec_revision,role);
 for(const action of required)assertAdmission(p,role,action);
}else if(mode==='missing-named'){
 // Remove every required action independently; the coverage diagnostic must name it.
 for(const action of required){
  const p={...policy,allowed_actions:policy.allowed_actions.filter(a=>a!==action)};
  assert(missing(p).includes(action),'missing action not named: '+action);
  assert.throws(()=>assertAdmission(p,role,action),e=>e.code==='ACTION_DENIED',action);
 }
}else if(mode==='negative'){
 assert.throws(()=>validatePolicy({...policy,extra:true},policy.spec_revision,role),e=>e.code==='POLICY_INVALID');
 assert.throws(()=>validatePolicy(policy,'foreign-revision',role),e=>e.code==='REVISION_MISMATCH');
 const other=role==='control'?'dispatch':'control';
 assert.throws(()=>validatePolicy(policy,policy.spec_revision,other),e=>e.code==='ROLE_DENIED');
 const boot={control:'programme.activate',provisioner:'programme.provision',dispatch:'programme.dispatch'}[role];
 assert.throws(()=>validatePolicy({...policy,allowed_actions:policy.allowed_actions.filter(a=>a!==boot)},policy.spec_revision,role),e=>e.code==='ACTION_DENIED');
}else throw Error('unknown probe mode');
console.log(JSON.stringify({role,mode,required:[...required].sort()}));
"""

MIGRATE = """
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {MigrationCoordinator} from './services/hyperfide/dist/storage/durability.js';
const signal=new AbortController().signal;
const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}
"""
RUNTIME = r"""
import assert from 'node:assert/strict';
import pg from './services/hyperfide/node_modules/pg/lib/index.js';
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {assertRuntimePrivileges} from './services/hyperfide/dist/storage/durability.js';
const role=process.env.HF_RUNTIME_ROLE,mode=process.env.HF_RUNTIME_MODE;
const r=createResourceContainer({role,env:process.env,signal:new AbortController().signal});
try{
 if(mode==='safe')await assertRuntimePrivileges(r);
 else if(mode==='unsafe')await assert.rejects(()=>assertRuntimePrivileges(r),e=>e.code==='RUNTIME_DDL_PRIVILEGE');
 else {
 const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{
  if(mode==='topology'){
   const s=(await c.query('SELECT system_identifier FROM pg_catalog.pg_control_system()')).rows[0];
   const t=(await c.query('SELECT timeline_id FROM pg_catalog.pg_control_checkpoint()')).rows[0];
   assert(s.system_identifier&&t.timeline_id);
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


def main():
    base = os.environ.copy()
    for role in ('control', 'provisioner', 'dispatch'):
        for mode in ('validate', 'coverage', 'admission', 'missing-named', 'negative'):
            check('policy.' + role + '.' + mode,
                  lambda role=role, mode=mode: node(POLICY, {**base, 'HF_POLICY_ROLE': role, 'HF_POLICY_MODE': mode}))
    database = 'hf_policy_' + uuid.uuid4().hex
    roles = []
    created = False
    clean = False
    url = base['DATABASE_URL']
    parts = urlsplit(url)
    scratch = urlunsplit((parts.scheme, parts.netloc, '/' + database, parts.query, parts.fragment))

    def sql(statement, target=url):
        return run(['psql', target, '-X', '-v', 'ON_ERROR_STOP=1', '-Atc', statement])

    def grants(target_role, expected=True):
        p = subprocess.run(['psql', scratch, '-X', '-v', 'runtime_role=' + target_role,
                            '-f', 'deploy/hyperfide/grants.sql'], cwd=ROOT, text=True,
                           capture_output=True, timeout=30)
        if (p.returncode == 0) != expected:
            raise AssertionError(p.stderr or 'unsafe operator grant was accepted')

    try:
        sql('CREATE DATABASE "' + database + '"')
        created = True
        node(MIGRATE, {**base, 'DATABASE_URL': scratch})
        for role in ('control', 'provisioner', 'dispatch'):
            login = 'hf_policy_' + uuid.uuid4().hex
            password = uuid.uuid4().hex
            sql('CREATE ROLE "' + login + '" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ' + "'" + password + "'")
            roles.append(login)
            check('grants.' + role + '.apply', lambda: grants(login))
            host = parts.netloc.rsplit('@', 1)[-1] or 'localhost'
            runtime = urlunsplit((parts.scheme, quote(login) + ':' + password + '@' + host,
                                  '/' + database, parts.query, parts.fragment))
            env = {**base, 'DATABASE_URL': runtime, 'HF_RUNTIME_ROLE': role}
            # Do not let an inherited fixture role-specific URL override the tested login.
            for key in list(env):
                if key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
                    del env[key]
            for mode in ('safe', 'topology', 'dml', 'no-migration'):
                check('grants.' + role + '.' + mode,
                      lambda mode=mode: node(RUNTIME, {**env, 'HF_RUNTIME_MODE': mode}))
            sql('GRANT CREATE ON SCHEMA hyperfide TO "' + login + '"', scratch)
            check('grants.' + role + '.unsafe-refused', lambda: node(RUNTIME, {**env, 'HF_RUNTIME_MODE': 'unsafe'}))
            sql('REVOKE CREATE ON SCHEMA hyperfide FROM "' + login + '"', scratch)
        # Even NOINHERIT membership allows SET ROLE, so the operator script refuses it.
        migration = 'hf_migration_' + uuid.uuid4().hex
        sql('CREATE ROLE "' + migration + '" NOLOGIN')
        roles.append(migration)
        sql('GRANT "' + migration + '" TO "' + roles[0] + '"')
        check('grants.membership-refused', lambda: grants(roles[0], False))
        sql('REVOKE "' + migration + '" FROM "' + roles[0] + '"')
        sql('ALTER ROLE "' + roles[0] + '" CREATEDB')
        check('grants.elevated-role-refused', lambda: grants(roles[0], False))
        sql('ALTER ROLE "' + roles[0] + '" NOCREATEDB')
        sql('CREATE TABLE public.owned_by_runtime(id int); ALTER TABLE public.owned_by_runtime OWNER TO "' + roles[0] + '"', scratch)
        check('grants.owner-refused', lambda: grants(roles[0], False))
    except Exception as error:
        FAILED.append('fixture')
        print(str(error), file=sys.stderr)
    finally:
        try:
            if created:
                sql('DROP DATABASE "' + database + '" WITH (FORCE)')
            for login in reversed(roles):
                sql('DROP ROLE "' + login + '"')
            absent_db = sql("SELECT count(*) FROM pg_database WHERE datname='" + database + "'").strip() == '0'
            absent_roles = all(sql("SELECT count(*) FROM pg_roles WHERE rolname='" + login + "'").strip() == '0' for login in roles)
            clean = absent_db and absent_roles
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
        output = Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR', '/tmp/hyperfide/task29-5-direct'))
        output.mkdir(parents=True, exist_ok=True)
        (output / 'policy-grants-observations.json').write_text(json.dumps({'assertions': OBSERVED, 'database_absent': clean, 'roles_absent': clean}, indent=2) + '\n')
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
