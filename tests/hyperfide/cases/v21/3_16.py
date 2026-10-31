#!/usr/bin/env python3
"""hyperfide-v21 3.16: a held fleet stop can be released, and admission honours a held scope.

An ORGANISATION stop is held; admission in that organisation is refused with ADMISSION_SCOPE_HELD while another
organisation is admitted. A LEADER cannot release it (refused and recorded). An operator releases it: the stop is
marked RELEASED with who and why, recovery.stop.released is emitted, the same admission is then admitted, a replayed
release returns the recorded result without a second event, and the driver no longer fans the stop out to a run
started afterwards. A POOL stop refuses a sandbox in that pool and a LEADER may release it. A DEPLOYMENT stop is
refused to release for a LEADER and for an operator outside HYPERFIDE_DEPLOYMENT_OPERATORS (both recorded as REFUSED,
replays included) and is released by an allow-listed operator of another organisation.

The admission check is recovery/scope_hold.ts assertScopeNotHeld, the single call agent.admission.reserve makes; the
native admission path itself needs qualified native profiles and is not driven here.
Runs against an owned throwaway PostgreSQL cluster (the v21/3_11.py fixture) with the real 24.3 stop component,
its driver loop, the real 5.1 execution controls and the real 6.1 outbox enqueue.
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


hold = load('hf_v21_3_11', 'tests/hyperfide/cases/v21/3_11.py')
base_case = hold.base_case
uid = base_case.uid
ORG1, ORG2, EPOCH, DEPLOYMENT, R1, R2, R9 = hold.ORG1, hold.ORG2, hold.EPOCH, hold.DEPLOYMENT, hold.R1, hold.R2, hold.R9
POOL_A, POOL_D = hold.POOL_A, hold.POOL_D
ALLOWED = uid(0x99)
EXPECTED = ['organisation-stop-held', 'organisation-admission-refused', 'other-organisation-admitted', 'leader-release-of-organisation-refused',
            'leader-release-recorded', 'operator-release-succeeds', 'stop-marked-released', 'release-event-emitted', 'admitted-after-release',
            'replayed-release-idempotent', 'replay-emits-no-second-event', 'released-stop-not-fanned-out', 'released-stop-not-rewritten',
            'pool-sandbox-admission-refused', 'leader-releases-pool-stop', 'pool-sandbox-admitted-after-release',
            'deployment-admission-refused', 'non-operator-deployment-release-refused', 'non-operator-deployment-release-recorded',
            'unlisted-operator-deployment-release-refused', 'refused-release-replay-is-an-error', 'deployment-stop-still-held',
            'listed-operator-releases-deployment-stop', 'driver-reports-clean-passes']


def consumers_sql():
    return '\n'.join(['BEGIN;'] + [f"INSERT INTO hyperfide.event_consumers(organisation_id,run_id,id,consumer_key,critical,state) VALUES('{org}','{run}','{uid(0x700 + n)}','fixture:release',true,'ACTIVE');"
                                   for n, (org, run) in enumerate(((ORG1, R1), (ORG2, R9)))] + ['COMMIT;'])


PROBE = r"""
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {createComponent} from './core/control-plane/dist/recovery/stop.js';
import {assertScopeNotHeld} from './core/control-plane/dist/recovery/scope_hold.js';
import {enqueue} from './core/control-plane/dist/events/outbox.js';
import {createComponent as createScheduler} from './core/control-plane/dist/scheduler/claim.js';
import {authenticatedInvocation} from './core/control-plane/dist/transport/protocol.js';
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
const providers={'4.2':{'storage.transactions.v1':r.gateway},'5.1':scheduler.capabilities,'6.1':{'events.outbox.v1':{enqueue}},'12.4':{'runner.supervisors.v1':supervisor}};
const dependencies={require:(id,name,guard)=>{const value=providers[id]?.[name];if(!guard(value))throw Error('missing '+id+'/'+name);return value;}};
const env={...process.env,HYPERFIDE_STOP_DRIVER_INTERVAL_MS:'200',HYPERFIDE_DEPLOYMENT_ID:ids.deployment,HYPERFIDE_DEPLOYMENT_OPERATORS:ids.allowed};
const startup={role:'control',signal:controller.signal,env,resources:r,dependencies};
const principal=(org,run,role,credential=randomUUID())=>authenticatedInvocation({principal:{credential_id:credential,organisation_id:org,run_id:run,actor_id:randomUUID(),role,deployment_epoch:ids.epoch,allowed_actions:['recovery.stop.request','recovery.stop.release'],expires_at:new Date(Date.now()+3600000).toISOString()},operation:{},payload:{},signal:controller.signal,guard:async()=>{},identityGuard:async()=>{},continuationGuard:async()=>{}});
const stop=createComponent(startup);
const scope=(org,run)=>({organisation_id:org,run_id:run,authority_epoch:ids.epoch});
const request=(org,run,input,credential)=>stop.actions['recovery.stop.request']({scope:scope(org,run),operation_id:randomUUID(),mode:'STOP',reason:'fleet release case 3.16',...input},{...startup,invocation:principal(org,run,'OPERATOR',credential)});
const release=(org,run,role,input,credential)=>stop.actions['recovery.stop.release']({scope:scope(org,run),operation_id:randomUUID(),reason:'case 3.16 lifts the hold',...input},{...startup,invocation:principal(org,run,role,credential)});
const code=async promise=>{try{const result=await promise;return 'ok:'+JSON.stringify(result).slice(0,300);}catch(e){return e.code;}};
const admit=target=>code(r.gateway.withPrimaryTransaction({timeoutMs:30000,maxRetries:3},tx=>assertScopeNotHeld(tx,target).then(()=>'admitted')));
const until=async(label,predicate,ms=120000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return true;await new Promise(f=>setTimeout(f,200));}throw Error('deadline: '+label);};
const passes=()=>stop.actions['recovery.stop.describe']({}).driver.passes;
const afterPasses=async n=>{const from=passes();await until(n+' driver passes',async()=>passes()>=from+n);};
const one=async(sql,values=[])=>(await q(sql,values))[0];
const runState=async id=>(await one('SELECT state FROM hyperfide.runs WHERE id=$1',[id])).state;
const op=async id=>await one('SELECT state,result,updated_at::text AS at FROM hyperfide.recovery_operations WHERE operation_id=$1',[id]);
const events=async stopId=>Number((await one("SELECT count(*) AS n FROM hyperfide.outbox_events WHERE event_type='recovery.stop.released' AND aggregate_id=$1",[stopId])).n);
try{
 // ORGANISATION hold, refusal, release, re-admission, replay.
 const o=await request(ids.org1,ids.r1,{scope_kind:'ORGANISATION',scope_id:ids.org1});
 await until('organisation stop settles',async()=>(await op(o.operation_id)).state==='RECONCILED'&&await runState(ids.r1)==='STOPPED');
 out['organisation-stop-held']=(await op(o.operation_id)).result.scope_held===true;
 out['organisation-admission-refused']=await admit({organisation_id:ids.org1,run_id:ids.r2,sandbox_id:null})==='ADMISSION_SCOPE_HELD';
 out['other-organisation-admitted']=await admit({organisation_id:ids.org2,run_id:ids.r9,sandbox_id:null})==='ok:"admitted"';
 const leaderId=randomUUID();
 out['leader-release-of-organisation-refused']=await code(release(ids.org1,ids.r1,'LEADER',{operation_id:leaderId,stop_operation_id:o.operation_id}))==='RECOVERY_RELEASE_ROLE_DENIED';
 const leaderRow=await op(leaderId);
 out['leader-release-recorded']=leaderRow.state==='REFUSED'&&leaderRow.result.refused===true&&leaderRow.result.refused_by.role==='LEADER'&&(await op(o.operation_id)).result.released!==true;
 const operatorCredential=randomUUID(),releaseInput={operation_id:randomUUID(),stop_operation_id:o.operation_id,reason:'incident closed'};
 const released=await release(ids.org1,ids.r1,'OPERATOR',releaseInput,operatorCredential);
 out['operator-release-succeeds']=released.released===true&&released.already_released===false;
 const marked=await op(o.operation_id);
 out['stop-marked-released']=marked.result.hold==='RELEASED'&&marked.result.released===true&&marked.result.released_by.credential_id===operatorCredential&&marked.result.release_reason==='incident closed'&&marked.result.release_operation_id===releaseInput.operation_id;
 out['release-event-emitted']=await events(o.operation_id)===1&&released.event_obligations===1;
 out['admitted-after-release']=await admit({organisation_id:ids.org1,run_id:ids.r2,sandbox_id:null})==='ok:"admitted"';
 const replayed=await release(ids.org1,ids.r1,'OPERATOR',releaseInput,operatorCredential);
 out['replayed-release-idempotent']=JSON.stringify(replayed)===JSON.stringify((await op(releaseInput.operation_id)).result)&&replayed.released===true&&replayed.event_id===released.event_id;
 out['replay-emits-no-second-event']=await events(o.operation_id)===1;
 // A run started after the release is not reached by the released stop.
 const stamp=(await op(o.operation_id)).at;
 superuser(ids.late.run);
 await afterPasses(4);
 out['released-stop-not-fanned-out']=await runState(ids.r2)==='RUNNING'&&Number((await one("SELECT count(*) AS n FROM hyperfide.recovery_operations WHERE run_id=$1 AND result->>'fleet_operation_id'=$2",[ids.r2,o.operation_id])).n)===0;
 out['released-stop-not-rewritten']=(await op(o.operation_id)).at===stamp;

 // POOL: a sandbox in the pool is refused; a LEADER may release a POOL stop.
 const p=await request(ids.org2,ids.r9,{scope_kind:'POOL',scope_id:ids.poolD});
 await until('pool stop settles',async()=>(await op(p.operation_id)).state==='RECONCILED');
 const pooled={organisation_id:ids.org2,run_id:ids.r9,sandbox_id:ids.sandboxD};
 out['pool-sandbox-admission-refused']=await admit(pooled)==='ADMISSION_SCOPE_HELD';
 const leaderPool=await release(ids.org2,ids.r9,'LEADER',{stop_operation_id:p.operation_id});
 out['leader-releases-pool-stop']=leaderPool.released===true&&(await op(p.operation_id)).result.released_by.role==='LEADER';
 out['pool-sandbox-admitted-after-release']=await admit(pooled)==='ok:"admitted"';

 // DEPLOYMENT: placed by an allow-listed operator in ORG2; refused for a LEADER and an unlisted operator.
 const d=await request(ids.org2,ids.r9,{scope_kind:'DEPLOYMENT',scope_id:ids.deployment},ids.allowed);
 out['deployment-admission-refused']=await admit({organisation_id:ids.org1,run_id:ids.r2,sandbox_id:null})==='ADMISSION_SCOPE_HELD';
 const nonOperator={operation_id:randomUUID(),stop_operation_id:d.operation_id};
 out['non-operator-deployment-release-refused']=await code(release(ids.org2,ids.r9,'LEADER',nonOperator))==='RECOVERY_RELEASE_ROLE_DENIED';
 const refusedRow=await op(nonOperator.operation_id);
 out['non-operator-deployment-release-recorded']=refusedRow.state==='REFUSED'&&refusedRow.result.refused===true&&refusedRow.result.error.code==='RECOVERY_RELEASE_ROLE_DENIED'&&refusedRow.result.stop_operation_id===d.operation_id;
 const unlisted={operation_id:randomUUID(),stop_operation_id:d.operation_id},unlistedCredential=randomUUID();
 out['unlisted-operator-deployment-release-refused']=await code(release(ids.org2,ids.r9,'OPERATOR',unlisted,unlistedCredential))==='RECOVERY_DEPLOYMENT_OPERATOR_DENIED'&&(await op(unlisted.operation_id)).state==='REFUSED';
 out['refused-release-replay-is-an-error']=await code(release(ids.org2,ids.r9,'OPERATOR',unlisted,unlistedCredential))==='RECOVERY_DEPLOYMENT_OPERATOR_DENIED';
 out['deployment-stop-still-held']=(await op(d.operation_id)).result.released!==true&&await admit({organisation_id:ids.org2,run_id:ids.r9,sandbox_id:null})==='ADMISSION_SCOPE_HELD';
 const listed=await release(ids.org1,ids.r1,'OPERATOR',{stop_operation_id:d.operation_id},ids.allowed);
 out['listed-operator-releases-deployment-stop']=listed.released===true&&(await op(d.operation_id)).result.hold==='RELEASED'&&await admit({organisation_id:ids.org2,run_id:ids.r9,sandbox_id:null})==='ok:"admitted"';

 await afterPasses(3);
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
        cluster.sql(hold.seed_sql())
        cluster.sql(consumers_sql())
        psql = [str(cluster.bin / 'psql'), '-X', '-q', '-h', str(cluster.root), '-p', '5432', '-U', base_case.SUPERUSER,
                '-d', base_case.DATABASE, '-v', 'ON_ERROR_STOP=1']
        ids = {'org1': ORG1, 'org2': ORG2, 'epoch': EPOCH, 'deployment': DEPLOYMENT, 'allowed': ALLOWED, 'r1': R1, 'r2': R2, 'r9': R9,
               'poolD': POOL_D, 'sandboxD': hold.sandbox_sql(ORG2, R9, POOL_D, 2)[1], 'late': hold.late_sql()}
        started = time.monotonic()
        output = base_case.run(['node', '--input-type=module', '-e', PROBE],
                               {**env, 'DATABASE_URL': cluster.url(base_case.RUNTIME), 'HF_HOLD_IDS': json.dumps(ids), 'HF_HOLD_PSQL': json.dumps(psql)},
                               timeout=600)
        outcomes = json.loads(output.strip().splitlines()[-1])
        if 'error' in outcomes:
            print(outcomes['error'][-3000:], file=sys.stderr)
        print(json.dumps({'type': 'measurement', 'id': 'stop.release.elapsed_seconds', 'value': round(time.monotonic() - started, 1)}), flush=True)
    except Exception as error:
        print(str(error)[-3000:], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
    failed = [name for name in EXPECTED if outcomes.get(name) is not True]
    for name in EXPECTED:
        print(json.dumps({'type': 'assertion', 'id': 'stop.release.' + name, 'expected': True, 'actual': outcomes.get(name, False)}), flush=True)
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'status': 'deleted' if clean else 'unknown',
                                                         'observed_absent': clean}], 'complete': clean}), flush=True)
    return 1 if failed or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
