#!/usr/bin/env python3
"""Fleet-wide stop drives itself: 1,500 synthetic supervisor debts across two pools reach RESOLVED
with no recovery.stop.reconcile call, and ORGANISATION and DEPLOYMENT scopes stop whole runs.

Runs against an owned ephemeral PostgreSQL cluster with the real migrations, the real 24.3 component
and its real 5.1 execution-control and 4.2 transaction dependencies. Component scope only: the
operator invocation is constructed in-process (14.1 authentication is not exercised) and the 12.4
supervisor is an in-process double over synthetic sessions, so no OS process is stopped here.
"""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
FAILED = []
SUPERUSER, OPERATOR, RUNTIME, DATABASE = 'hf_superuser', 'hf_operator', 'hf_runtime_control', 'hyperfide'


def uid(n):
    return '00000000-0000-4000-8000-' + format(n, '012x')


ORG1, ORG2, EPOCH, DEPLOYMENT = uid(1), uid(2), uid(3), uid(4)
R1, R2, R3, R4, R5 = uid(0x11), uid(0x12), uid(0x13), uid(0x14), uid(0x15)
POOL_A, POOL_B, POOL_C, POOL_D = uid(0x21), uid(0x22), uid(0x23), uid(0x24)
# (organisation, run, pool, sessions): pool A and B carry exactly 1,500 sessions; one sandbox exceeds a 1,000-row page.
SANDBOXES = [(ORG1, R1, POOL_A, 1100), (ORG1, R2, POOL_A, 50)] + \
    [(ORG1, R2, POOL_B, 50)] * 3 + [(ORG1, R3, POOL_B, 50)] * 4 + \
    [(ORG1, R5, POOL_C, 5), (ORG2, R4, POOL_D, 5)]


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    print(json.dumps({'type': 'assertion', 'id': 'stop.fleet.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def expect(condition, message='unexpected result'):
    if not condition:
        raise AssertionError(message)


def run(argv, env=None, data=None, timeout=300):
    p = subprocess.run(argv, cwd=ROOT, env=env, input=data, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise AssertionError((p.stderr + p.stdout)[-3000:])
    return p.stdout


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    # A client-only package leaves a bin directory without the server; take the newest full server.
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin')
                        if (path / 'initdb').exists() and (path / 'postgres').exists()), key=lambda path: int(path.parent.name))
    return installed[-1] if installed else None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory (pattern of tasks/29_5.py)."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-stop-', dir='/tmp/hyperfide'))
        owner = pwd.getpwnam('postgres')
        os.chown(self.root, owner.pw_uid, owner.pw_gid)
        self.data = self.root / 'data'
        self.process = None
        try:
            self.start()
        except Exception:
            self.close()
            raise

    def start(self):
        self.server('initdb', '-D', self.data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (self.data / 'postgresql.conf').open('a') as conf:
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(self.root) + "'\nmax_connections=50\n"
                       # Disposable data: durability settings only cost time on a loaded host.
                       "fsync=off\nfull_page_writes=off\n")
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

    def sql(self, statement, user=SUPERUSER, database=DATABASE):
        p = subprocess.run([str(self.bin / 'psql'), '-X', '-q', '-h', str(self.root), '-p', '5432', '-U', user, '-d', database,
                            '-v', 'ON_ERROR_STOP=1', '-At'], input=statement, cwd=ROOT, text=True, capture_output=True, timeout=120)
        if p.returncode:
            raise AssertionError(p.stderr[-2000:])
        return p.stdout.strip()

    def grants(self):
        p = subprocess.run([str(self.bin / 'psql'), '-X', '-h', str(self.root), '-p', '5432', '-U', OPERATOR, '-d', DATABASE,
                            '-v', 'ON_ERROR_STOP=1', '-v', 'runtime_role=' + RUNTIME, '-f', 'deploy/hyperfide/grants.sql'],
                           cwd=ROOT, text=True, capture_output=True, timeout=60)
        if p.returncode or 'ERROR' in p.stderr:
            raise AssertionError('grant script did not apply: ' + p.stderr[-2000:])

    def close(self):
        if self.process and self.process.poll() is None:
            self.server('pg_ctl', '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop')
        if self.process:
            self.process.wait(timeout=60)
        shutil.rmtree(self.root)
        return not self.root.exists()


MIGRATE = """
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {MigrationCoordinator} from './services/hyperfide/dist/storage/durability.js';
const signal=new AbortController().signal;
const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}
"""


def seed_sql():
    D = "'sha256:'||repeat('a',64)"
    out = ['BEGIN;']
    runs = {ORG1: [R1, R2, R3, R5], ORG2: [R4]}
    for n, (org, org_runs) in enumerate(runs.items()):
        project, repo, spec = uid(0x100 + n), uid(0x110 + n), uid(0x120 + n)
        out.append(f"INSERT INTO hyperfide.organisations(id,name) VALUES('{org}','stop-fleet-{n}');")
        out.append(f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{org}','{project}','fixture');")
        out.append(f"INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES('{org}','{repo}','{project}','repo','https://example.invalid/repo');")
        out.append(f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{org}','{spec}','{project}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1);")
        for run_id in org_runs:
            out.append(f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{org}','{run_id}','{project}','{spec}',{D},'{EPOCH}','RUNNING');")
            out.append(f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{org}','{run_id}','{run_id[:-4]}f{run_id[-3:]}','package',1);")
    for pool, org in ((POOL_A, ORG1), (POOL_B, ORG1), (POOL_C, ORG1), (POOL_D, ORG2)):
        out.append(f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{org}','{pool}','railway','fixture','fixture','fixture');")
    for i, (org, run_id, pool, sessions) in enumerate(SANDBOXES):
        sandbox, slot, task, attempt, lease = (uid(0x1000 + i * 8 + k) for k in range(5))
        spec = uid(0x120 + (0 if org == ORG1 else 1))
        package = run_id[:-4] + 'f' + run_id[-3:]
        out.append(f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{org}','{sandbox}','{pool}','RUNNING');")
        out.append(f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{org}','{slot}','{sandbox}','worker',1,'AGENT');")
        out.append(f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{org}','{run_id}','{task}','t{i}','{package}','{spec}',{D},'{{}}',1);")
        out.append(f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{org}','{run_id}','{attempt}','{task}',1,'{EPOCH}',{D},'RUNNING','CURRENT','{sandbox}','{slot}',1,clock_timestamp()+interval '30 minutes');")
        out.append(f"UPDATE hyperfide.tasks SET generation=1,current_attempt_id='{attempt}',state='RUNNING',state_version=state_version+1 WHERE organisation_id='{org}' AND run_id='{run_id}' AND id='{task}';")
        out.append(f"INSERT INTO hyperfide.compute_leases(organisation_id,run_id,id,attempt_id,attempt_generation,authority_epoch,sandbox_boot_generation,expires_at) VALUES('{org}','{run_id}','{lease}','{attempt}',1,'{EPOCH}',1,clock_timestamp()+interval '30 minutes');")
        out.append(f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,role,connector,account_key,native_session_id,attempt_id,sandbox_id,slot_id,sandbox_boot_generation,state) SELECT '{org}','{run_id}','WORKER','codex','fixture','w'||g,'{attempt}','{sandbox}','{slot}',1,'RUNNING' FROM generate_series(1,{sessions}) g;")
    out.append('COMMIT;')
    return '\n'.join(out)


PROBE = r"""
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {createComponent} from './services/hyperfide/dist/recovery/stop.js';
import {createComponent as createScheduler} from './services/hyperfide/dist/scheduler/claim.js';
import {authenticatedInvocation} from './services/hyperfide/dist/transport/protocol.js';
import {createHash,randomUUID} from 'node:crypto';
const ids=JSON.parse(process.env.HF_STOP_IDS);
const out={};const controller=new AbortController();
const r=createResourceContainer({role:'control',env:process.env,signal:controller.signal});
const q=async(sql,values=[])=>(await r.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:3},tx=>tx.query(sql,values))).rows;
const scheduler=createScheduler({});
let supervisorReachable=false;
const calls={stop:new Set(),observe:0,verify:[]};
const supervisor={
 observe:async()=>{calls.observe++;throw Error('no finish observations in this case');},
 stop:async input=>{
  if(!supervisorReachable)throw Error('unreachable');
  calls.stop.add(input.session_id);
  return {status:'CONFIRMED_STOPPED',evidence_digest:'sha256:'+createHash('sha256').update(input.session_id+':'+input.command_id).digest('hex'),observed_at:new Date().toISOString()};
 },
 verifyStop:async input=>{
  calls.verify.push({operation_id:input.operation_id,commands:input.commands.length});
  return {cleanup_complete:true,processes_stopped:true,artifacts_preserved:true,credentials_cleared:true,resources_reconciled:true,evidence_digest:'sha256:'+createHash('sha256').update(input.operation_id+':'+input.commands.length).digest('hex'),observed_at:new Date().toISOString()};
 }
};
const providers={'4.2':{'storage.transactions.v1':r.gateway},'5.1':scheduler.capabilities,'12.4':{'runner.supervisors.v1':supervisor}};
const dependencies={require:(id,name,guard)=>{
 // The supervisor is withheld until phase two: an unreachable supervisor must never resolve a debt.
 if(id==='12.4'&&!supervisorReachable)throw Error('supervisor absent');
 const value=providers[id]?.[name];if(!guard(value))throw Error('missing '+id+'/'+name);return value;}};
const env={...process.env,HYPERFIDE_STOP_DRIVER_INTERVAL_MS:'200',HYPERFIDE_DEPLOYMENT_ID:ids.deployment};
const startup={role:'control',signal:controller.signal,env,resources:r,dependencies};
const operator=(org,run,role='OPERATOR')=>authenticatedInvocation({principal:{credential_id:randomUUID(),organisation_id:org,run_id:run,actor_id:randomUUID(),role,deployment_epoch:ids.epoch,allowed_actions:['recovery.stop.request'],expires_at:new Date(Date.now()+3600000).toISOString()},operation:{},payload:{},signal:controller.signal,guard:async()=>{},identityGuard:async()=>{},continuationGuard:async()=>{}});
const stop=createComponent(startup);
const reconcile=stop.actions['recovery.stop.reconcile'];
let reconcileCalls=0;stop.actions['recovery.stop.reconcile']=(...a)=>{reconcileCalls++;return reconcile(...a);};
const request=(org,run,input,role)=>stop.actions['recovery.stop.request']({scope:{organisation_id:org,run_id:run,authority_epoch:ids.epoch},operation_id:randomUUID(),mode:'STOP',reason:'fleet stop case 2.4',...input},{...startup,invocation:operator(org,run,role)});
const refused=async(promise,code)=>{try{await promise;return false;}catch(e){return e.code===code;}};
const until=async(label,predicate,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return true;await new Promise(f=>setTimeout(f,250));}throw Error('deadline: '+label);};
const count=async(sql,values=[])=>Number((await q(sql,values))[0].n);
try{
 out['scopes-described']=JSON.stringify(stop.actions['recovery.stop.describe']({}).scopes)===JSON.stringify(['RUN','PACKAGE','ATTEMPT','SANDBOX','POOL','ORGANISATION','DEPLOYMENT']);
 out['non-operator-refused']=await refused(request(ids.org1,ids.r1,{scope_kind:'POOL',scope_id:ids.poolA},'COORDINATOR'),'ROLE_DENIED');
 out['foreign-pool-refused']=await refused(request(ids.org1,ids.r1,{scope_kind:'POOL',scope_id:ids.poolD}),'RECOVERY_SCOPE_INVALID');
 out['foreign-organisation-refused']=await refused(request(ids.org1,ids.r1,{scope_kind:'ORGANISATION',scope_id:ids.org2}),'RECOVERY_SCOPE_INVALID');
 out['foreign-deployment-refused']=await refused(request(ids.org1,ids.r1,{scope_kind:'DEPLOYMENT',scope_id:randomUUID()}),'RECOVERY_SCOPE_INVALID');
 out['unknown-scope-refused']=await refused(request(ids.org1,ids.r1,{scope_kind:'REGION',scope_id:ids.poolA}),'RECOVERY_INPUT_INVALID');
 out['refusals-wrote-nothing']=await count('SELECT count(*) AS n FROM hyperfide.recovery_operations')===0;

 const a=await request(ids.org1,ids.r1,{scope_kind:'POOL',scope_id:ids.poolA});
 const b=await request(ids.org1,ids.r1,{scope_kind:'POOL',scope_id:ids.poolB});
 out['pool-requests-recorded-for-driver']=a.fleet===true&&b.fleet===true&&a.driver==='RECOVERY_STOP_DRIVER';
 const poolDebts="SELECT count(*) AS n FROM hyperfide.recovery_resource_debts d JOIN hyperfide.agent_sessions s ON s.organisation_id=d.organisation_id AND s.run_id=d.run_id AND s.id=d.resource_id JOIN hyperfide.sandboxes x ON x.organisation_id=s.organisation_id AND x.id=s.sandbox_id WHERE d.resource_kind='SUPERVISOR' AND x.pool_id=ANY($1::uuid[])";
 await until('fan-out of 1,500 debts',async()=>await count(poolDebts,[[ids.poolA,ids.poolB]])===1500);
 out['driver-fanned-out-1500-debts']=true;
 out['fan-out-per-sandbox-children']=await count("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE kind='STOP' AND result->>'fleet_operation_id' IN ($1,$2) AND result->>'scope_kind'='SANDBOX'",[a.operation_id,b.operation_id])===9;
 const passes=stop.actions['recovery.stop.describe']({}).driver.passes;
 await until('three unreachable passes',async()=>stop.actions['recovery.stop.describe']({}).driver.passes>=passes+3);
 out['unreachable-supervisor-resolves-nothing']=await count(poolDebts+" AND d.status='RESOLVED'",[[ids.poolA,ids.poolB]])===0&&calls.stop.size===0&&await count("SELECT count(*) AS n FROM hyperfide.agent_sessions WHERE state='STOPPED'")===0;
 out['compute-revoked-on-fan-out']=await count("SELECT count(*) AS n FROM hyperfide.attempts a JOIN hyperfide.sandboxes x ON x.organisation_id=a.organisation_id AND x.id=a.sandbox_id WHERE x.pool_id=ANY($1::uuid[]) AND a.compute_authority='REVOKED'",[[ids.poolA,ids.poolB]])===9;

 supervisorReachable=true;
 await until('1,500 debts resolved',async()=>await count(poolDebts+" AND d.status='RESOLVED'",[[ids.poolA,ids.poolB]])===1500);
 out['all-1500-debts-resolved']=calls.stop.size===1500;
 out['pool-sessions-stopped']=await count("SELECT count(*) AS n FROM hyperfide.agent_sessions s JOIN hyperfide.sandboxes x ON x.organisation_id=s.organisation_id AND x.id=s.sandbox_id WHERE x.pool_id=ANY($1::uuid[]) AND s.state='STOPPED'",[[ids.poolA,ids.poolB]])===1500;
 await until('fleet stops settle',async()=>await count("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE operation_id=ANY($1::uuid[]) AND state='RECONCILED'",[[a.operation_id,b.operation_id]])===2);
 const fleet=await q("SELECT result FROM hyperfide.recovery_operations WHERE operation_id=$1",[a.operation_id]);
 out['fleet-stop-reconciled']=fleet[0].result.fanout_complete===true&&fleet[0].result.fanout.applied===2;
 await until('children finalized',async()=>await count("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE result->>'fleet_operation_id' IN ($1,$2) AND state='RECONCILED'",[a.operation_id,b.operation_id])===9);
 const big=calls.verify.filter(v=>v.commands===1000||v.commands===100);
 out['inventory-paginated-past-1000']=big.some(v=>v.commands===1000)&&big.some(v=>v.commands===100)&&calls.verify.every(v=>v.commands<=1000);
 out['other-pools-untouched']=await count("SELECT count(*) AS n FROM hyperfide.agent_sessions s JOIN hyperfide.sandboxes x ON x.organisation_id=s.organisation_id AND x.id=s.sandbox_id WHERE x.pool_id=ANY($1::uuid[]) AND s.state='RUNNING'",[[ids.poolC,ids.poolD]])===10&&await count("SELECT count(*) AS n FROM hyperfide.runs WHERE state<>'RUNNING'")===0;

 const o=await request(ids.org2,ids.r4,{scope_kind:'ORGANISATION',scope_id:ids.org2});
 await until('organisation stop',async()=>(await q('SELECT state FROM hyperfide.runs WHERE id=$1',[ids.r4]))[0].state==='STOPPED');
 out['organisation-stop-completes']=await count("SELECT count(*) AS n FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND state='STOPPED'",[ids.org2])===5&&await count("SELECT count(*) AS n FROM hyperfide.runs WHERE organisation_id=$1 AND state='RUNNING'",[ids.org1])===4;
 await until('organisation fleet settles',async()=>(await q('SELECT state FROM hyperfide.recovery_operations WHERE operation_id=$1',[o.operation_id]))[0].state==='RECONCILED');

 const d=await request(ids.org1,ids.r1,{scope_kind:'DEPLOYMENT',scope_id:ids.deployment});
 await until('deployment stop',async()=>await count("SELECT count(*) AS n FROM hyperfide.runs WHERE state<>'STOPPED'")===0);
 await until('deployment fleet settles',async()=>(await q('SELECT state FROM hyperfide.recovery_operations WHERE operation_id=$1',[d.operation_id]))[0].state==='RECONCILED');
 out['deployment-stop-completes']=await count("SELECT count(*) AS n FROM hyperfide.agent_sessions WHERE state<>'STOPPED'")===0&&await count("SELECT count(*) AS n FROM hyperfide.recovery_resource_debts WHERE status<>'RESOLVED'")===0;
 out['no-external-reconcile']=reconcileCalls===0;
 const replay=await stop.actions['recovery.stop.request']({scope:{organisation_id:ids.org1,run_id:ids.r1,authority_epoch:ids.epoch},operation_id:a.operation_id,mode:'STOP',reason:'fleet stop case 2.4',scope_kind:'POOL',scope_id:ids.poolA},{...startup,invocation:operator(ids.org1,ids.r1)});
 out['fleet-request-idempotent']=replay.operation_id===a.operation_id&&replay.fanout_complete===true;
 const status=stop.actions['recovery.stop.describe']({}).driver;
 out['driver-reports-clean-passes']=status.running===true&&status.last_error===null&&status.last_pass.errors.length===0;
}finally{
 await stop.close();
 out['driver-stops-on-close']=stop.actions['recovery.stop.describe']({}).driver.running===false;
 controller.abort();await r.close();
}
console.log(JSON.stringify(out));
"""


def main():
    binaries = postgres_bin()
    if binaries is None:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN', flush=True)
        return 77
    base = os.environ.copy()
    for key in list(base):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del base[key]
    # The case exercises the current source, so it builds dist rather than trusting a stale one.
    run(['npm', '--prefix', str(SERVICE), 'run', 'build'], base)
    cluster = None
    clean = False
    try:
        cluster = Cluster(binaries)
        cluster.sql('CREATE ROLE ' + OPERATOR + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', database='postgres')
        cluster.sql('CREATE DATABASE ' + DATABASE + ' OWNER ' + OPERATOR, database='postgres')
        # Each migration commits on its own, so a run cut short by the 30 s session deadline resumes where it stopped.
        for attempt in range(6):
            try:
                run(['node', '--input-type=module', '-e', MIGRATE], {**base, 'DATABASE_URL': cluster.url(OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or 'TX_TIMEOUT' not in str(error):
                    raise
        cluster.sql('CREATE ROLE ' + RUNTIME + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT')
        cluster.grants()
        cluster.sql(seed_sql())
        ids = {'org1': ORG1, 'org2': ORG2, 'epoch': EPOCH, 'deployment': DEPLOYMENT, 'r1': R1, 'r4': R4,
               'poolA': POOL_A, 'poolB': POOL_B, 'poolC': POOL_C, 'poolD': POOL_D}
        started = time.monotonic()
        output = run(['node', '--input-type=module', '-e', PROBE],
                     {**base, 'DATABASE_URL': cluster.url(RUNTIME), 'HF_STOP_IDS': json.dumps(ids)}, timeout=900)
        outcomes = json.loads(output.strip().splitlines()[-1])
        print(json.dumps({'type': 'measurement', 'id': 'stop.fleet.elapsed_seconds', 'value': round(time.monotonic() - started, 1)}), flush=True)
        expected = ['scopes-described', 'non-operator-refused', 'foreign-pool-refused', 'foreign-organisation-refused',
                    'foreign-deployment-refused', 'unknown-scope-refused', 'refusals-wrote-nothing', 'pool-requests-recorded-for-driver',
                    'driver-fanned-out-1500-debts', 'fan-out-per-sandbox-children', 'unreachable-supervisor-resolves-nothing',
                    'compute-revoked-on-fan-out', 'all-1500-debts-resolved', 'pool-sessions-stopped', 'fleet-stop-reconciled',
                    'inventory-paginated-past-1000', 'other-pools-untouched', 'organisation-stop-completes',
                    'deployment-stop-completes', 'no-external-reconcile', 'fleet-request-idempotent',
                    'driver-reports-clean-passes', 'driver-stops-on-close']
        for name in expected:
            check(name, lambda name=name: expect(outcomes.get(name) is True, name + ' -> ' + str(outcomes.get(name))))
    except Exception as error:
        FAILED.append('fixture')
        print(str(error)[-3000:], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
