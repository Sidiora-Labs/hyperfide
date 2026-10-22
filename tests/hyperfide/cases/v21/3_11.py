#!/usr/bin/env python3
"""hyperfide-v21 3.11: fleet stops hold their scope.

An ORGANISATION stop that has already reconciled must still stop a run started in that organisation
afterwards, a POOL stop must still revoke a sandbox placed in that pool afterwards, and a refused
DEPLOYMENT stop (D14) must fail the request rather than answer ok with refused:true.

Runs against an owned throwaway PostgreSQL cluster with the real migrations and grants, the real 24.3
stop component with its driver loop, and the real 5.1 execution controls (fixture machinery of v21/2_4.py).
The 12.4 supervisor is an in-process double over synthetic sessions; no OS process is stopped here.
Late rows are inserted through psql as the cluster superuser while the driver runs.
"""
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[4]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


base_case = load('hf_v21_2_4', 'tests/hyperfide/cases/v21/2_4.py')
uid = base_case.uid
ORG1, ORG2, EPOCH, DEPLOYMENT = uid(0x31), uid(0x32), uid(0x33), uid(0x34)
R1, R2, R9 = uid(0x41), uid(0x42), uid(0x49)
POOL_A, POOL_D = uid(0x51), uid(0x54)
PROJECT, SPEC = {ORG1: uid(0x61), ORG2: uid(0x62)}, {ORG1: uid(0x71), ORG2: uid(0x72)}
D = "'sha256:'||repeat('a',64)"
EXPECTED = ['organisation-stop-reconciled', 'other-organisation-untouched', 'late-run-not-left-running', 'late-run-stopped-by-held-stop',
            'late-run-child-of-fleet-stop', 'organisation-stop-settles-again', 'late-sandbox-in-held-pool-revoked',
            'late-sandbox-child-of-pool-stop', 'held-pool-leaves-run-state', 'deployment-refusal-is-an-error', 'deployment-refusal-recorded',
            'deployment-refusal-replay-is-an-error', 'held-stop-idle-pass-writes-nothing', 'driver-reports-clean-passes']


def org_sql(org, n):
    return [f"INSERT INTO hyperfide.organisations(id,name) VALUES('{org}','stop-hold-{n}');",
            f"INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES('{org}','{PROJECT[org]}','fixture');",
            f"INSERT INTO hyperfide.spec_revisions(organisation_id,id,project_id,source_digest,source_content,document,schema_version) VALUES('{org}','{SPEC[org]}','{PROJECT[org]}','sha256:'||encode(sha256(convert_to('fixture','UTF8')),'hex'),'fixture','{{}}',1);"]


def run_sql(org, run_id):
    return [f"INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch,state) VALUES('{org}','{run_id}','{PROJECT[org]}','{SPEC[org]}',{D},'{EPOCH}','RUNNING');",
            f"INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES('{org}','{run_id}','{run_id[:-4]}f{run_id[-3:]}','package',1);"]


def sandbox_sql(org, run_id, pool, n, sessions=3):
    sandbox, slot, task, attempt, lease = (uid(0x1000 + n * 8 + k) for k in range(5))
    package = run_id[:-4] + 'f' + run_id[-3:]
    return [f"INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,observed_state) VALUES('{org}','{sandbox}','{pool}','RUNNING');",
            f"INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES('{org}','{slot}','{sandbox}','worker',1,'AGENT');",
            f"INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES('{org}','{run_id}','{task}','t{n}','{package}','{SPEC[org]}',{D},'{{}}',1);",
            f"INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES('{org}','{run_id}','{attempt}','{task}',1,'{EPOCH}',{D},'RUNNING','CURRENT','{sandbox}','{slot}',1,clock_timestamp()+interval '30 minutes');",
            f"UPDATE hyperfide.tasks SET generation=1,current_attempt_id='{attempt}',state='RUNNING',state_version=state_version+1 WHERE organisation_id='{org}' AND run_id='{run_id}' AND id='{task}';",
            f"INSERT INTO hyperfide.compute_leases(organisation_id,run_id,id,attempt_id,attempt_generation,authority_epoch,sandbox_boot_generation,expires_at) VALUES('{org}','{run_id}','{lease}','{attempt}',1,'{EPOCH}',1,clock_timestamp()+interval '30 minutes');",
            f"INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,role,connector,account_key,native_session_id,attempt_id,sandbox_id,slot_id,sandbox_boot_generation,state) SELECT '{org}','{run_id}','WORKER','codex','fixture','s{n}-'||g,'{attempt}','{sandbox}','{slot}',1,'RUNNING' FROM generate_series(1,{sessions}) g;"], sandbox, attempt


def seed_sql():
    out = ['BEGIN;'] + org_sql(ORG1, 1) + org_sql(ORG2, 2) + run_sql(ORG1, R1) + run_sql(ORG2, R9)
    for pool, org in ((POOL_A, ORG1), (POOL_D, ORG2)):
        out.append(f"INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES('{org}','{pool}','railway','fixture','fixture','fixture');")
    out += sandbox_sql(ORG1, R1, POOL_A, 1)[0] + sandbox_sql(ORG2, R9, POOL_D, 2)[0]
    return '\n'.join(out + ['COMMIT;'])


def late_sql():
    """Rows admitted after the fleet stops settled: a new run in the stopped organisation, a new sandbox in the stopped pool."""
    late_run, _, _ = sandbox_sql(ORG1, R2, POOL_A, 3)
    late_sandbox, sandbox, attempt = sandbox_sql(ORG2, R9, POOL_D, 4)
    return {'run': '\n'.join(['BEGIN;'] + run_sql(ORG1, R2) + late_run + ['COMMIT;']),
            'sandbox': '\n'.join(['BEGIN;'] + late_sandbox + ['COMMIT;']), 'late_sandbox': sandbox, 'late_attempt': attempt}


PROBE = r"""
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {createComponent} from './services/hyperfide/dist/recovery/stop.js';
import {createComponent as createScheduler} from './services/hyperfide/dist/scheduler/claim.js';
import {authenticatedInvocation} from './services/hyperfide/dist/transport/protocol.js';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const ids=JSON.parse(process.env.HF_HOLD_IDS);
const psql=JSON.parse(process.env.HF_HOLD_PSQL);
const superuser=sql=>execFileSync(psql[0],psql.slice(1),{input:sql,encoding:'utf8'});
const out={};const controller=new AbortController();
const r=createResourceContainer({role:'control',env:process.env,signal:controller.signal});
const q=async(sql,values=[])=>(await r.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:3},tx=>tx.query(sql,values))).rows;
const scheduler=createScheduler({});
const receipt=key=>({evidence_digest:'sha256:'+createHash('sha256').update(key).digest('hex'),observed_at:new Date().toISOString()});
const supervisor={
 observe:async()=>{throw Error('no finish observations in this case');},
 stop:async input=>({status:'CONFIRMED_STOPPED',...receipt(input.session_id+':'+input.command_id)}),
 verifyStop:async input=>({cleanup_complete:true,processes_stopped:true,artifacts_preserved:true,credentials_cleared:true,resources_reconciled:true,...receipt(input.operation_id+':'+input.commands.length)})
};
const providers={'4.2':{'storage.transactions.v1':r.gateway},'5.1':scheduler.capabilities,'12.4':{'runner.supervisors.v1':supervisor}};
const dependencies={require:(id,name,guard)=>{const value=providers[id]?.[name];if(!guard(value))throw Error('missing '+id+'/'+name);return value;}};
const env={...process.env,HYPERFIDE_STOP_DRIVER_INTERVAL_MS:'200',HYPERFIDE_DEPLOYMENT_ID:ids.deployment,HYPERFIDE_DEPLOYMENT_OPERATORS:randomUUID()};
const startup={role:'control',signal:controller.signal,env,resources:r,dependencies};
const operator=(org,run)=>authenticatedInvocation({principal:{credential_id:randomUUID(),organisation_id:org,run_id:run,actor_id:randomUUID(),role:'OPERATOR',deployment_epoch:ids.epoch,allowed_actions:['recovery.stop.request'],expires_at:new Date(Date.now()+3600000).toISOString()},operation:{},payload:{},signal:controller.signal,guard:async()=>{},identityGuard:async()=>{},continuationGuard:async()=>{}});
const stop=createComponent(startup);
const request=(org,run,input)=>stop.actions['recovery.stop.request']({scope:{organisation_id:org,run_id:run,authority_epoch:ids.epoch},operation_id:randomUUID(),mode:'STOP',reason:'fleet hold case 3.11',...input},{...startup,invocation:operator(org,run)});
const until=async(label,predicate,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return true;await new Promise(f=>setTimeout(f,200));}throw Error('deadline: '+label);};
const passes=()=>stop.actions['recovery.stop.describe']({}).driver.passes;
const afterPasses=async n=>{const from=passes();await until(n+' driver passes',async()=>passes()>=from+n);};
const one=async(sql,values=[])=>(await q(sql,values))[0];
const runState=async id=>(await one('SELECT state FROM hyperfide.runs WHERE id=$1',[id])).state;
const opState=async id=>(await one('SELECT state FROM hyperfide.recovery_operations WHERE operation_id=$1',[id])).state;
try{
 const o=await request(ids.org1,ids.r1,{scope_kind:'ORGANISATION',scope_id:ids.org1});
 await until('organisation stop settles',async()=>await opState(o.operation_id)==='RECONCILED'&&await runState(ids.r1)==='STOPPED');
 out['organisation-stop-reconciled']=true;
 out['other-organisation-untouched']=await runState(ids.r9)==='RUNNING';

 // The run is admitted after the stop reconciled; the held stop must reach it.
 superuser(ids.late.run);
 await afterPasses(4);
 out['late-run-not-left-running']=await runState(ids.r2)!=='RUNNING';
 await until('late run stopped',async()=>await runState(ids.r2)==='STOPPED');
 out['late-run-stopped-by-held-stop']=Number((await one("SELECT count(*) AS n FROM hyperfide.agent_sessions WHERE run_id=$1 AND state<>'STOPPED'",[ids.r2])).n)===0;
 out['late-run-child-of-fleet-stop']=Number((await one("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE run_id=$1 AND result->>'fleet_operation_id'=$2 AND result->>'scope_kind'='RUN'",[ids.r2,o.operation_id])).n)===1;
 await until('organisation stop settles again',async()=>await opState(o.operation_id)==='RECONCILED');
 const held=await one('SELECT result FROM hyperfide.recovery_operations WHERE operation_id=$1',[o.operation_id]);
 out['organisation-stop-settles-again']=held.result.scope_held===true&&held.result.fanout_complete===true;

 const p=await request(ids.org2,ids.r9,{scope_kind:'POOL',scope_id:ids.poolD});
 await until('pool stop settles',async()=>await opState(p.operation_id)==='RECONCILED');
 superuser(ids.late.sandbox);
 await until('late sandbox revoked',async()=>(await one('SELECT compute_authority FROM hyperfide.attempts WHERE id=$1',[ids.late.late_attempt])).compute_authority==='REVOKED');
 out['late-sandbox-in-held-pool-revoked']=true;
 out['late-sandbox-child-of-pool-stop']=Number((await one("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE run_id=$1 AND result->>'fleet_operation_id'=$2 AND result->>'scope_kind'='SANDBOX' AND result->>'scope_id'=$3",[ids.r9,p.operation_id,ids.late.late_sandbox])).n)===1;
 out['held-pool-leaves-run-state']=await runState(ids.r9)==='RUNNING';

 const denied=randomUUID(),deployment={scope_kind:'DEPLOYMENT',scope_id:ids.deployment,operation_id:denied};
 const code=async promise=>{try{const result=await promise;return 'ok:'+JSON.stringify(result).slice(0,200);}catch(e){return e.code;}};
 out['deployment-refusal-is-an-error']=await code(request(ids.org1,ids.r1,deployment))==='RECOVERY_DEPLOYMENT_OPERATOR_DENIED';
 const refusal=await one('SELECT state,result FROM hyperfide.recovery_operations WHERE operation_id=$1',[denied]);
 out['deployment-refusal-recorded']=refusal.state==='REFUSED'&&refusal.result.refused===true;
 out['deployment-refusal-replay-is-an-error']=await code(request(ids.org1,ids.r1,deployment))==='RECOVERY_DEPLOYMENT_OPERATOR_DENIED';

 await until('all stops settle',async()=>await opState(o.operation_id)==='RECONCILED'&&await opState(p.operation_id)==='RECONCILED');
 const stamp=async()=>(await q('SELECT operation_id,updated_at::text AS at FROM hyperfide.recovery_operations WHERE operation_id=ANY($1::uuid[]) ORDER BY 1',[[o.operation_id,p.operation_id]])).map(x=>x.at).join();
 const before=await stamp();await afterPasses(3);
 out['held-stop-idle-pass-writes-nothing']=before===await stamp();
 const status=stop.actions['recovery.stop.describe']({}).driver;
 out['driver-reports-clean-passes']=status.running===true&&status.last_error===null&&status.last_pass.errors.length===0;
}catch(error){out.error=String(error&&error.stack||error);}
finally{await stop.close();controller.abort();await r.close();}
console.log(JSON.stringify(out));
"""


def main():
    binaries = base_case.postgres_bin()
    if binaries is None:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN', flush=True)
        return 77
    if os.geteuid() != 0:
        print('SKIP: the owned cluster runs PostgreSQL through runuser postgres, which needs root', flush=True)
        return 77
    env = os.environ.copy()
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(env):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del env[key]
    base_case.run(['npm', '--prefix', str(base_case.SERVICE), 'run', 'build'], env)
    cluster, clean, outcomes = None, False, {}
    try:
        cluster = base_case.Cluster(binaries)
        cluster.sql('CREATE ROLE ' + base_case.OPERATOR + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', database='postgres')
        cluster.sql('CREATE DATABASE ' + base_case.DATABASE + ' OWNER ' + base_case.OPERATOR, database='postgres')
        for attempt in range(6):
            try:
                base_case.run(['node', '--input-type=module', '-e', base_case.MIGRATE], {**env, 'DATABASE_URL': cluster.url(base_case.OPERATOR)})
                break
            except AssertionError as error:
                if attempt == 5 or 'TX_TIMEOUT' not in str(error):
                    raise
        cluster.sql('CREATE ROLE ' + base_case.RUNTIME + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT')
        cluster.grants()
        cluster.sql(seed_sql())
        psql = [str(cluster.bin / 'psql'), '-X', '-q', '-h', str(cluster.root), '-p', '5432', '-U', base_case.SUPERUSER,
                '-d', base_case.DATABASE, '-v', 'ON_ERROR_STOP=1']
        ids = {'org1': ORG1, 'org2': ORG2, 'epoch': EPOCH, 'deployment': DEPLOYMENT, 'r1': R1, 'r2': R2, 'r9': R9, 'poolD': POOL_D, 'late': late_sql()}
        started = time.monotonic()
        output = base_case.run(['node', '--input-type=module', '-e', PROBE],
                               {**env, 'DATABASE_URL': cluster.url(base_case.RUNTIME), 'HF_HOLD_IDS': json.dumps(ids), 'HF_HOLD_PSQL': json.dumps(psql)},
                               timeout=600)
        outcomes = json.loads(output.strip().splitlines()[-1])
        if 'error' in outcomes:
            print(outcomes['error'][-3000:], file=sys.stderr)
        print(json.dumps({'type': 'measurement', 'id': 'stop.hold.elapsed_seconds', 'value': round(time.monotonic() - started, 1)}), flush=True)
    except Exception as error:
        print(str(error)[-3000:], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
    failed = [name for name in EXPECTED if outcomes.get(name) is not True]
    for name in EXPECTED:
        print(json.dumps({'type': 'assertion', 'id': 'stop.hold.' + name, 'expected': True, 'actual': outcomes.get(name, False)}), flush=True)
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'status': 'deleted' if clean else 'unknown',
                                                         'observed_absent': clean}], 'complete': clean}), flush=True)
    return 1 if failed or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
