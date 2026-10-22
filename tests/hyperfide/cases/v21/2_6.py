#!/usr/bin/env python3
"""Task 2.6: finding events reach the manager and operator consumers on an owned PostgreSQL cluster.

A finding emit must write delivery rows for both standing finding consumers, and the dispatcher's finding.*
route must carry each delivery through the 6.2 inbox receipt to acknowledgement. The signed HTTPS hop of the
standing worker is not exercised here; the claim, route resolution, receipt and acknowledgement it performs are.
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
import uuid
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
SUPERUSER, OPERATOR, DATABASE = 'hf_superuser', 'hf_operator', 'hyperfide'
FAILED = []


def run(argv, env=None, timeout=300):
    p = subprocess.run(argv, cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise AssertionError(p.stderr + p.stdout)
    return p.stdout


def node(script, env):
    return run(['node', '--input-type=module', '-e', script], env)


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    # A client-only major version ships bin/ without a server; take the newest one that has initdb.
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin') if (path / 'initdb').exists()),
                       key=lambda path: int(path.parent.name))
    return installed[-1] if installed else None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-2-6-', dir='/tmp/hyperfide'))
        owner = pwd.getpwnam('postgres')
        os.chown(self.root, owner.pw_uid, owner.pw_gid)
        self.data = self.root / 'data'
        self.process = None
        self.server('initdb', '-D', self.data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (self.data / 'postgresql.conf').open('a') as conf:
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(self.root) + "'\n")
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

    def sql(self, statement, user=SUPERUSER, database=DATABASE):
        p = subprocess.run([str(self.bin / 'psql'), '-X', '-h', str(self.root), '-p', '5432', '-U', user, '-d', database,
                            '-v', 'ON_ERROR_STOP=1', '-Atc', statement], cwd=ROOT, text=True, capture_output=True, timeout=60)
        if p.returncode:
            raise AssertionError(p.stderr)
        return p.stdout.strip()

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
// The migrator caps one call at 30s; on a loaded host resume it, since applied migrations are skipped.
for(let attempt=1;;attempt++){
 const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
 try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});break;}
 catch(e){if(e?.code!=='TX_TIMEOUT'||attempt>=10)throw e;}
 finally{await r.close();}
}
"""

PROBE = r"""
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {emit,FINDING_CONSUMER_KEYS} from './services/hyperfide/dist/findings/registry.js';
import {FINDING_ROUTE,routeFor} from './services/hyperfide/dist/events/dispatcher.js';
import {claimPending,acknowledge} from './services/hyperfide/dist/events/outbox.js';
import {receive} from './services/hyperfide/dist/events/inbox.js';
const scope={organisation_id:process.env.HF_ORG,run_id:process.env.HF_RUN};
const r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});
const tx=fn=>r.gateway.withPrimaryTransaction({timeoutMs:10000},fn);
const out={};
const step=async(name,fn)=>{try{out[name]=(await fn())??true;}catch(e){out[name]={error:String(e?.code??'')+' '+String(e?.message??e)};}};
const keyed="SELECT c.consumer_key,d.state,e.event_type,e.aggregate_version::text AS version,e.payload FROM hyperfide.outbox_events e JOIN hyperfide.event_deliveries d ON d.organisation_id=e.organisation_id AND d.run_id=e.run_id AND d.event_id=e.id JOIN hyperfide.event_consumers c ON c.organisation_id=d.organisation_id AND c.run_id=d.run_id AND c.id=d.consumer_id WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.aggregate_type='finding' AND e.aggregate_id=$3 ORDER BY c.consumer_key";
try{
 const finding=randomUUID();
 await step('emit',()=>tx(t=>emit(t,scope,finding,'1','finding.observed',{finding_id:finding,observation_id:randomUUID()})));
 await step('deliveries',()=>tx(async t=>{
  const rows=(await t.query(keyed,[scope.organisation_id,scope.run_id,finding])).rows;
  assert.deepEqual(rows.map(x=>x.consumer_key),[FINDING_CONSUMER_KEYS.manager,FINDING_CONSUMER_KEYS.operator]);
  assert(rows.every(x=>x.state==='PENDING'&&x.event_type==='finding.observed'&&x.version==='1'&&x.payload.registry_version==='1'),JSON.stringify(rows));
  return rows.length;
 }));
 // Replaying the same transition at the same registry version is a no-op, as the former ON CONFLICT path was.
 await step('replay-noop',()=>tx(async t=>{
  await emit(t,scope,finding,'1','finding.observed',{finding_id:finding,observation_id:randomUUID()});
  return (await t.query("SELECT count(*)::int AS n FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3",[scope.organisation_id,scope.run_id,finding])).rows[0].n;
 }));
 // A later transition with a registry-version jump still lands on the next contiguous aggregate version.
 await step('second-emit',()=>tx(async t=>{
  await emit(t,scope,finding,'4','finding.repair-escalated',{finding_id:finding,repair_id:randomUUID(),reason:'MAX_ATTEMPTS'});
  return (await t.query("SELECT aggregate_version::text AS v FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3 AND event_type='finding.repair-escalated'",[scope.organisation_id,scope.run_id,finding])).rows[0].v;
 }));
 await step('route',()=>{
  const fixture={aggregate_type:'fixture',event_type:'fixture.changed',component:'fixture.events',action:'fixture.admit',input_mode:'DELIVERY'};
  const configured=[fixture,FINDING_ROUTE];
  for(const type of ['finding.observed','finding.repair-escalated','finding.routed'])assert.equal(routeFor(configured,'finding',type),FINDING_ROUTE,type);
  assert.equal(routeFor(configured,'finding','findingx.observed'),undefined);
  assert.equal(routeFor(configured,'fixture','finding.observed'),undefined);
  assert.equal(routeFor([fixture],'finding','finding.observed'),undefined);
  const exact={...FINDING_ROUTE,event_type:'finding.observed',action:'exact.handler'};
  assert.equal(routeFor([FINDING_ROUTE,exact],'finding','finding.observed'),exact);
  return {...FINDING_ROUTE};
 });
 // Drive each delivery the way a dispatcher pass does: claim, resolve the route, receive with a receipt, acknowledge.
 await step('dispatch',()=>tx(async t=>{
  const consumers=(await t.query("SELECT id::text,consumer_key FROM hyperfide.event_consumers WHERE organisation_id=$1 AND run_id=$2 AND consumer_key LIKE 'finding:%' ORDER BY consumer_key",[scope.organisation_id,scope.run_id])).rows;
  assert.equal(consumers.length,2);
  const dispatched=[];
  for(const c of consumers){
   const claims=await claimPending(t,{...scope,consumer_id:c.id,limit:8,lease_ms:30000});
   assert.equal(claims.length,2,c.consumer_key);
   for(const claim of claims){
    const route=routeFor([FINDING_ROUTE],claim.aggregate_type,claim.event_type);
    assert.equal(route?.component+'/'+route?.action,'6.2/inbox.receive');
    const result=await receive(t,{...scope,event_id:claim.id,consumer_id:c.id});
    assert.equal(result.status,'APPLIED',JSON.stringify(result));
    await assert.rejects(()=>acknowledge(t,{...scope,event_id:claim.id,consumer_id:c.id,attempt_count:claim.attempt_count,inbox_id:randomUUID()}),e=>e.code==='EVENT_RECEIPT_REQUIRED');
    await acknowledge(t,{...scope,event_id:claim.id,consumer_id:c.id,attempt_count:claim.attempt_count,inbox_id:result.inbox_id});
    dispatched.push(c.consumer_key+':'+claim.event_type);
   }
  }
  const left=(await t.query(keyed,[scope.organisation_id,scope.run_id,finding])).rows.filter(x=>x.state!=='ACKNOWLEDGED');
  assert.equal(left.length,0);
  return dispatched;
 }));
 // Negative: a consumer that is no longer standing refuses the emit instead of silently dropping the event.
 await step('stopped-consumer-refused',async()=>{
  await tx(t=>t.query("UPDATE hyperfide.event_consumers SET state='STOPPED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND consumer_key=$3",[scope.organisation_id,scope.run_id,FINDING_CONSUMER_KEYS.operator]));
  await assert.rejects(()=>tx(t=>emit(t,scope,randomUUID(),'1','finding.observed',{})),e=>e.code==='EVENT_CONSUMER_REQUIRED');
  return 'REFUSED';
 });
}finally{await r.close();}
console.log(JSON.stringify(out));
"""


def main():
    def check(name, ok, detail):
        print(json.dumps({'type': 'assertion', 'id': name, 'ok': bool(ok), 'detail': detail}), flush=True)
        if not ok:
            FAILED.append(name)

    binaries = postgres_bin()
    if binaries is None or shutil.which('runuser') is None or not (SERVICE / 'node_modules').exists():
        print('SKIP: PostgreSQL server binaries, runuser or service node_modules unavailable')
        return 77
    run(['npm', '--prefix', str(SERVICE), 'run', 'build'])
    base = {k: v for k, v in os.environ.items()
            if not (k == 'DATABASE_URL' or k.startswith('HYPERFIDE_') and k.endswith('_DATABASE_URL'))}
    cluster, clean = None, False
    try:
        cluster = Cluster(binaries)
        cluster.sql('CREATE ROLE ' + OPERATOR + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
                    database='postgres')
        cluster.sql('CREATE DATABASE ' + DATABASE + ' OWNER ' + OPERATOR, database='postgres')
        env = {**base, 'DATABASE_URL': cluster.url(OPERATOR)}
        # A loaded host can drop the migrator's pool connection outright; resuming is safe because applied
        # migrations are skipped, so only the final attempt's failure counts.
        for attempt in range(1, 6):
            try:
                node(MIGRATE, env)
                break
            except AssertionError:
                if attempt == 5:
                    raise
                time.sleep(2)
        org, run_id = str(uuid.uuid4()), str(uuid.uuid4())
        # The run is an anchor row only; its project and spec revision graph is outside this task.
        cluster.sql("SET session_replication_role=replica;"
                    "INSERT INTO hyperfide.organisations(id,name) VALUES('%s','v21-2-6');"
                    "INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch)"
                    " VALUES('%s','%s',gen_random_uuid(),gen_random_uuid(),'sha256:%s',gen_random_uuid())"
                    % (org, org, run_id, '0' * 64))
        out = json.loads(node(PROBE, {**env, 'HF_ORG': org, 'HF_RUN': run_id}).strip().splitlines()[-1])
        check('finding.emit', out.get('emit') is True, out.get('emit'))
        check('finding.delivery-rows', out.get('deliveries') == 2, out.get('deliveries'))
        check('finding.replay-noop', out.get('replay-noop') == 1, out.get('replay-noop'))
        check('finding.contiguous-version', out.get('second-emit') == '2', out.get('second-emit'))
        route = out.get('route')
        check('dispatcher.finding-route', isinstance(route, dict) and route.get('event_type') == 'finding.*', route)
        expected = sorted(k + ':' + e for k in ('finding:manager', 'finding:operator')
                          for e in ('finding.observed', 'finding.repair-escalated'))
        dispatched = out.get('dispatch')
        check('dispatcher.dispatched-and-acknowledged',
              isinstance(dispatched, list) and sorted(dispatched) == expected, dispatched)
        check('finding.stopped-consumer-refused', out.get('stopped-consumer-refused') == 'REFUSED',
              out.get('stopped-consumer-refused'))
    except Exception as error:
        FAILED.append('fixture')
        print(str(error), file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'complete': clean}), flush=True)
    if FAILED or not clean:
        print('FAIL: ' + ', '.join(FAILED or ['cleanup']))
        return 1
    print('PASS: finding events reach the manager and operator consumers')
    return 0


if __name__ == '__main__':
    sys.exit(main())
