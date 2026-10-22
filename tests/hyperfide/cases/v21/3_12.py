#!/usr/bin/env python3
"""hyperfide-v21 3.12: finding consumers are claimable and provider throttling backs off.

Part A (no database): the actual Railway adapter against a local HTTP stub of the GraphQL API. A 429 on
sandboxCreate retries under the shared budget before UNKNOWN, a 5xx on create is never replayed, and an
idempotent destroy retries a 5xx. No real Railway endpoint or credential is used.
Part B (owned PostgreSQL): a default fan-out (task.changed) skips the finding consumers while a finding
reaches them, their ids are derived so the shipped dispatch config names them, and a claim by that id works.
Part C (owned PostgreSQL, actual provisioner service with a SIMULATED adapter): an exhausted ownership probe
leaves the intent UNKNOWN with OWNERSHIP_PROBE_UNVERIFIED instead of quarantine, and an operator-DELETED orphan
stays DELETED and unprobed when the provider still lists it.
Without PostgreSQL server binaries or root, part A still runs and the case prints SKIP and exits 77.
"""
import importlib.util
import io
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
TEMPLATE = ROOT / 'deploy/hyperfide/config/dispatch-worker.example.json'
SUPERUSER, OPERATOR, OUTBOX_DB = 'hf_superuser', 'hf_operator', 'hf_outbox'
FAILED = []


def expect(value, message):
    if not value:
        raise AssertionError(message[:1500] if isinstance(message, str) else json.dumps(message, default=str)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual}), flush=True)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(argv, env=None, timeout=900):
    p = subprocess.run(argv, cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise AssertionError(' '.join(map(str, argv))[:200] + ': ' + (p.stderr + p.stdout)[-2500:])
    return p.stdout


# ---------------------------------------------------------------- part A: Railway writes back off

RAILWAY_DRIVER = r"""
import fs from 'node:fs';
import {RailwayClient,RAILWAY_BACKOFF} from './services/hyperfide/dist/providers/railway/preparation.js';
import {createRailwayAdapter} from './services/hyperfide/dist/providers/railway/reconciliation.js';
import {RailwaySessionSpool} from './services/hyperfide/dist/providers/railway/processes.js';
const data=JSON.parse(fs.readFileSync(process.argv[1])),events=[];
const client=new RailwayClient(data.config,{HF_RAILWAY_FIXTURE_TOKEN:'not-real'});
const adapter=createRailwayAdapter(client,{
 persistence:{
  assignedBootGeneration:async()=>'17',
  persistEarlyResource:async(op,id)=>{events.push('early-id:'+id);return {native_sandbox_id:id,sandbox_boot_generation:'17'};},
  recordObservation:async(op,outcome)=>{events.push('observation:'+outcome.status);}
 },
 runtimeProfile:async()=>data.profile,preparedBase:async()=>data.base,
 credentials:async()=>({GIT_TOKEN:'fixture-worker-value'}),sessions:new RailwaySessionSpool(data.spool)
});
const op=data.operation;
const result=await adapter[op.kind](op,new AbortController().signal);
process.stdout.write(JSON.stringify({outcome:result,events,policy:RAILWAY_BACKOFF}));
"""


def railway_part():
    c = load('railway_fixture_9_1', 'tests/hyperfide/cases/tasks/9_1.py')
    with tempfile.TemporaryDirectory(prefix='hyperfide-v21-3-12-railway-') as folder:
        fixture = c.Fixture(folder)
        injected = {'create': [], 'destroy': []}
        handler = fixture.server.RequestHandlerClass
        original = handler.do_POST

        def do_POST(self):
            body = self.rfile.read(int(self.headers['content-length']))
            query = json.loads(body)['query']
            kind = 'create' if 'sandboxCreate' in query else 'destroy' if 'sandboxDestroy' in query else None
            if kind and injected[kind]:
                status = injected[kind].pop(0)
                fixture.requests.append(json.loads(body))
                out = json.dumps({'errors': [{'message': 'simulated ' + str(status)}]}).encode()
                self.send_response(status)
                if status == 429:
                    self.send_header('retry-after', '0')
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(out)))
                self.end_headers()
                self.wfile.write(out)
                return
            self.rfile = io.BytesIO(body)
            return original(self)
        handler.do_POST = do_POST
        try:
            params = {'profile': c.profile(), 'config': fixture.config, 'base': c.base(), 'spool': str(Path(folder) / 'spool')}
            driver = Path(folder) / 'driver.json'

            def adapter(operation):
                params['operation'] = operation
                driver.write_text(json.dumps(params))
                p = subprocess.run(['node', '--input-type=module', '-e', RAILWAY_DRIVER, str(driver)], cwd=ROOT,
                                   capture_output=True, text=True, timeout=120)
                expect(p.returncode == 0, p.stderr)
                return json.loads(p.stdout)

            def count(word):
                return sum(1 for r in fixture.requests if word in r['query'])

            def create_429_then_success():
                fixture.state['mode'] = 'normal'
                before = count('sandboxCreate')
                injected['create'] = [429]
                out = adapter(c.operation('create', 'create-429-once'))
                expect(out['outcome']['status'] == 'SUCCEEDED' and out['outcome']['resource']['native_sandbox_id'] == 'sandbox-1', out)
                expect(count('sandboxCreate') - before == 2, ('throttled create was not retried', count('sandboxCreate') - before))
            check('railway.create.429-retries-then-succeeds', create_429_then_success)

            def create_429_exhausted():
                before = count('sandboxCreate')
                injected['create'] = [429] * 20
                out = adapter(c.operation('create', 'create-429-always'))
                o, attempts = out['outcome'], out['policy']['attempts']
                injected['create'] = []
                expect(o['status'] == 'UNKNOWN' and o['resource'] is None, o)
                expect(o['error']['code'] == 'RATE_LIMIT' and o['error']['provider_code'] == 'HTTP_429', o['error'])
                expect('after ' + str(attempts) + ' attempts' in o['error']['message'], o['error'])
                expect(count('sandboxCreate') - before == attempts, ('create not bounded by the shared budget', count('sandboxCreate') - before))
            check('railway.create.429-bounded-backoff-before-unknown', create_429_exhausted)

            def create_5xx_not_replayed():
                before = count('sandboxCreate')
                injected['create'] = [503]
                out = adapter(c.operation('create', 'create-503'))
                injected['create'] = []
                expect(out['outcome']['status'] == 'UNKNOWN' and out['outcome']['error']['provider_code'] == 'HTTP_503', out['outcome'])
                expect(count('sandboxCreate') - before == 1, 'a create that met a 5xx was replayed')
            check('railway.create.5xx-never-replayed', create_5xx_not_replayed)

            def destroy_5xx_retried():
                fixture.state['mode'] = 'destroyed'
                before = count('sandboxDestroy')
                injected['destroy'] = [503]
                out = adapter(c.operation('destroy', 'destroy-503'))
                fixture.state['mode'] = 'normal'
                expect(out['outcome']['status'] == 'SUCCEEDED' and out['outcome']['result'] == {'deletion': 'CONFIRMED'}, out['outcome'])
                expect(count('sandboxDestroy') - before == 2, ('idempotent destroy did not retry its 5xx', count('sandboxDestroy') - before))
            check('railway.destroy.5xx-retried-idempotent', destroy_5xx_retried)
        finally:
            fixture.close()


# ---------------------------------------------------------------- owned PostgreSQL cluster

def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin')
                        if path.parent.name.isdigit() and (path / 'initdb').exists() and (path / 'postgres').exists()),
                       key=lambda path: int(path.parent.name))
    return installed[-1] if installed else None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory (pattern of v21/3_1.py, 2_1.py)."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-3-12-', dir='/tmp/hyperfide'))
        owner = pwd.getpwnam('postgres')
        os.chown(self.root, owner.pw_uid, owner.pw_gid)
        self.data = self.root / 'data'
        self.process = None
        self.server('initdb', '-D', self.data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (self.data / 'postgresql.conf').open('a') as conf:
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(self.root) + "'\nfsync=off\n")
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

    def url(self, database='postgres', user=SUPERUSER):
        return 'postgresql://' + quote(user) + '@localhost:5432/' + database + '?host=' + quote(str(self.root), safe='')

    def sql(self, statement, user=SUPERUSER, database='postgres'):
        return run([str(self.bin / 'psql'), '-X', '-h', str(self.root), '-p', '5432', '-U', user, '-d', database,
                    '-v', 'ON_ERROR_STOP=1', '-Atc', statement], timeout=60).strip()

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
for(let attempt=1;;attempt++){
 const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
 try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});break;}
 catch(e){if(e?.code!=='TX_TIMEOUT'||attempt>=10)throw e;}
 finally{await r.close();}
}
"""

# ---------------------------------------------------------------- part B: finding consumers addressed-only and claimable

OUTBOX_PROBE = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';
import {registerConsumer,enqueue,claimPending} from './services/hyperfide/dist/events/outbox.js';
import {emit,findingConsumerIds,FINDING_CONSUMER_KEYS} from './services/hyperfide/dist/findings/registry.js';
import {dispatchConfiguration} from './services/hyperfide/dist/events/dispatcher.js';
const scope={organisation_id:process.env.HF_ORG,run_id:process.env.HF_RUN};
const r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});
const tx=fn=>r.gateway.withPrimaryTransaction({timeoutMs:10000},fn);
const out={};
const step=async(name,fn)=>{try{out[name]=(await fn())??true;}catch(e){out[name]={error:String(e?.code??'')+' '+String(e?.message??e)};}};
const recipients="SELECT c.id::text,c.consumer_key FROM hyperfide.event_deliveries d JOIN hyperfide.event_consumers c ON c.organisation_id=d.organisation_id AND c.run_id=d.run_id AND c.id=d.consumer_id WHERE d.organisation_id=$1 AND d.run_id=$2 AND d.event_id=$3 ORDER BY c.consumer_key";
const ids=findingConsumerIds(scope),normal=randomUUID();
try{
 // A standing non-finding consumer must exist before the first event of the run.
 await step('normal-registered',()=>tx(t=>registerConsumer(t,{...scope,id:normal,consumer_key:'runner:fixture',critical:true,state:'ACTIVE'})).then(()=>true));
 await step('random-id-refused',async()=>{
  await assert.rejects(()=>tx(t=>registerConsumer(t,{...scope,id:randomUUID(),consumer_key:FINDING_CONSUMER_KEYS.manager,critical:true,state:'ACTIVE'})),e=>e.code==='EVENT_INPUT_INVALID');
  return 'REFUSED';
 });
 const finding=randomUUID();
 await step('finding-recipients',()=>tx(async t=>{
  await emit(t,scope,finding,'1','finding.observed',{finding_id:finding});
  const ev=(await t.query("SELECT id::text FROM hyperfide.outbox_events WHERE organisation_id=$1 AND run_id=$2 AND aggregate_id=$3",[scope.organisation_id,scope.run_id,finding])).rows[0].id;
  return (await t.query(recipients,[scope.organisation_id,scope.run_id,ev])).rows;
 }));
 const task={...scope,id:randomUUID(),aggregate_type:'task',aggregate_id:randomUUID(),aggregate_version:'1',event_type:'task.changed',payload:{note:'fixture'}};
 await step('task-recipients',()=>tx(async t=>{
  const result=await enqueue(t,task);
  return {obligations:result.obligations,rows:(await t.query(recipients,[scope.organisation_id,scope.run_id,task.id])).rows};
 }));
 await step('template',()=>{
  const raw=fs.readFileSync(process.env.HF_TEMPLATE,'utf8')
   .replace('REPLACE_WITH_ORGANISATION_UUID',scope.organisation_id).replace('REPLACE_WITH_RUN_UUID',scope.run_id)
   .replace('REPLACE_WITH_DISPATCH_CREDENTIAL_UUID',randomUUID()).replace('REPLACE_WITH_CONTROL_TLS_NAME','control.fixture.invalid').replace('REPLACE_WITH_PORT','8443');
  const named=JSON.parse(raw).consumer_ids,config=dispatchConfiguration(JSON.parse(raw));
  return {named,resolved:config.consumer_ids,routes:config.routes.map(x=>x.event_type)};
 });
 await step('claims',()=>tx(async t=>{
  const by=async id=>(await claimPending(t,{...scope,consumer_id:id,limit:8,lease_ms:30000})).map(c=>c.event_type).sort();
  return {manager:await by(ids.manager),operator:await by(ids.operator),normal:await by(normal)};
 }));
}finally{await r.close();}
console.log(JSON.stringify({...out,ids,normal}));
"""


def outbox_part(cluster, base):
    cluster.sql('CREATE ROLE ' + OPERATOR + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    cluster.sql('CREATE DATABASE ' + OUTBOX_DB + ' OWNER ' + OPERATOR)
    env = {**base, 'DATABASE_URL': cluster.url(OUTBOX_DB, OPERATOR)}
    for attempt in range(1, 6):
        try:
            run(['node', '--input-type=module', '-e', MIGRATE], env)
            break
        except AssertionError:
            if attempt == 5:
                raise
            time.sleep(2)
    org, run_id = str(uuid.uuid4()), str(uuid.uuid4())
    # The run is an anchor row only; its project and spec revision graph is outside this task.
    cluster.sql("SET session_replication_role=replica;"
                "INSERT INTO hyperfide.organisations(id,name) VALUES('%s','v21-3-12');"
                "INSERT INTO hyperfide.runs(organisation_id,id,project_id,spec_revision_id,policy_digest,authority_epoch)"
                " VALUES('%s','%s',gen_random_uuid(),gen_random_uuid(),'sha256:%s',gen_random_uuid())"
                % (org, org, run_id, '0' * 64), database=OUTBOX_DB)
    out = json.loads(run(['node', '--input-type=module', '-e', OUTBOX_PROBE],
                         {**env, 'HF_ORG': org, 'HF_RUN': run_id, 'HF_TEMPLATE': str(TEMPLATE)}).strip().splitlines()[-1])
    ids, normal = out['ids'], out['normal']
    finding_keys = [['finding:manager', ids['manager']], ['finding:operator', ids['operator']]]

    check('outbox.finding-consumer-random-id-refused', lambda: expect(
        out.get('normal-registered') is True and out.get('random-id-refused') == 'REFUSED', out))
    check('outbox.finding-reaches-derived-finding-consumers', lambda: expect(
        [[r['consumer_key'], r['id']] for r in out['finding-recipients']] == finding_keys, out.get('finding-recipients')))
    check('outbox.default-fanout-skips-finding-consumers', lambda: expect(
        out['task-recipients'] == {'obligations': 1, 'rows': [{'id': normal, 'consumer_key': 'runner:fixture'}]},
        out.get('task-recipients')))
    check('dispatch.shipped-config-names-finding-consumers', lambda: expect(
        out['template']['named'] == ['finding:manager', 'finding:operator']
        and out['template']['resolved'] == [ids['manager'], ids['operator']]
        and 'finding.*' in out['template']['routes'], out.get('template')))
    check('dispatch.finding-consumers-claimable', lambda: expect(
        out['claims'] == {'manager': ['finding.observed'], 'operator': ['finding.observed'], 'normal': ['task.changed']},
        out.get('claims')))


# ---------------------------------------------------------------- part C: probe exhaustion and DELETED orphans

def provider_part(intents):
    folder = tempfile.mkdtemp(prefix='hyperfide-v21-3-12-provider-')
    state = Path(folder) / 'provider-state.json'
    f = None

    def provider():
        return json.loads(state.read_text())

    def configure(**values):
        data = provider()
        data.update(values)
        nxt = state.with_suffix('.tmp')
        nxt.write_text(json.dumps(data))
        nxt.replace(state)

    try:
        state.write_text(json.dumps({'resources': {}, 'calls': [], 'create_mode': 'lose-owned', 'probe_mode': 'throw', 'incompatible': False}))
        module_root = intents.simulated_module_root(folder)
        source = intents.SIMULATED_ADAPTER
        lose, probe_head = "if(mode==='lose')throw", "registerProviderOwnershipProbe('railway',async(scope,operationId,native)=>{"
        expect(lose in source and probe_head in source, 'simulated adapter fixture changed shape')
        # Modes added here: 'lose-owned' loses the create response for a resource the probe can prove is ours,
        # and probe_mode 'throw' makes the ownership probe fail the way an exhausted provider read does.
        source = source.replace(lose, "if(mode==='lose'||mode==='lose-owned')throw").replace(probe_head, probe_head +
            "update(v=>{v.calls.push({method:'probe',operation_id:operationId,native_sandbox_id:native});});"
            "if(read().probe_mode==='throw')throw new Error('simulated ownership probe exhausted');")
        (module_root / 'fixtures/simulated-provider.js').write_text(source)

        def setup(fx):
            intents.prepare_provider_intent_fixture(fx)
            (fx.components / '8.3-simulated-adapter.json').write_text(json.dumps(intents.SIMULATED_FRAGMENT))
            fx.env.update({'HF_SIMULATED_PROVIDER_STATE': str(state), 'HYPERFIDE_PROVISIONER_POLL_MS': '200',
                           'HYPERFIDE_PROVISIONER_RETRY_MS': '300', 'HYPERFIDE_PROVISIONER_LEASE_MS': '3000',
                           'HYPERFIDE_PROVISIONER_CONCURRENCY': '2'})
        f = intents.SimulatedProvisionerFixture(module_root, extra_components=['8.2', '8.3'], extra_setup=setup,
                                                extra_actions=['provider.simulated.describe'])
        org, run_id = f.ids['organisation'], f.ids['run']

        def ok(action, payload, key='operator', component='8.3'):
            status, response = f.invoke(action, payload, component=component, key=key)
            expect(status == 200 and response.get('ok') is True, (action, status, response))
            return response['result']

        def intent(iid):
            return f.sql('SELECT state,native_sandbox_id,failure_code FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND id=$2', [org, iid])[0]

        def orphan(native):
            rows = f.sql("SELECT state,(extract(epoch FROM last_observed_at)*1000000)::bigint::text AS seen FROM hyperfide.provider_orphans WHERE organisation_id=$1 AND pool_id=$2 AND native_sandbox_id=$3", [org, f.pool, native])
            return rows[0] if rows else None

        def lost(iid):
            return [k for k, v in provider()['resources'].items() if v['operation_id'] == iid]

        def probes(native, since=0):
            return [c for c in provider()['calls'][since:] if c['method'] == 'probe' and c.get('native_sandbox_id') == native]

        ok('provider.pools.configure', {}, component='8.2')
        intents.seed_provider_capacity(f)

        def reserve():
            for name, quantity in {'SANDBOX': '1', 'CPU_MILLIS': '2000', 'MEMORY_BYTES': '4294967296', 'DISK_BYTES': '32212254720'}.items():
                aid = f.sql("SELECT id FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension=$3 AND capacity_class='PHYSICAL'", [org, f.pool, name])[0]['id']
                rid = str(uuid.uuid4())
                f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$3::numeric,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [org, aid, quantity])
                f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')", [org, run_id, rid, str(uuid.uuid4()), aid, quantity])
                f.reservations.append(rid)

        def commit():
            request = {'run_id': run_id, 'pool_id': f.pool, 'sandbox_id': str(uuid.uuid4()), 'request_key': str(uuid.uuid4()),
                       'deadline_at': intents.utc(115000), 'reservation_ids': f.reservations[-4:], 'profile_id': f.profile,
                       'preparation_digest': f.preparation, 'purpose': 'PREPARATION'}
            answer = ok('provider.intents.prepare-create', request)
            expect(answer['created'] is True, answer)
            return answer['intent']['id']

        a, b = {}, {}

        def unverified_not_quarantined():
            # An unresolved orphan blocks admission (CAPACITY_UNKNOWN), so both intents are committed before either create runs.
            ok('provider.worker.stop', {}, key='provisioner')
            a['id'] = commit()
            reserve()
            b['id'] = commit()
            started = ok('provider.worker.start', {}, key='provisioner')
            expect(started['running'] is True, started)
            row = intents.wait_for(lambda: (lambda r: r if r['failure_code'] == 'OWNERSHIP_PROBE_UNVERIFIED' else None)(intent(a['id'])),
                                   'exhausted probe did not record OWNERSHIP_PROBE_UNVERIFIED', 40)
            expect(row['state'] in ('UNKNOWN', 'RECONCILING') and row['native_sandbox_id'] is None, row)
            a['native'] = lost(a['id'])[0]
            seen, deadline = set(), time.monotonic() + 3
            while time.monotonic() < deadline:
                seen.add(intent(a['id'])['state'])
                time.sleep(0.1)
            expect('QUARANTINED' not in seen and seen <= {'UNKNOWN', 'RECONCILING', 'SUBMITTING'}, sorted(seen))
            expect(len(probes(a['native'])) >= 2, ('probe was not retried after backoff', probes(a['native'])))
            expect(orphan(a['native'])['state'] == 'QUARANTINED', orphan(a['native']))
        check('provider.probe.exhausted-is-unverified-not-quarantined', unverified_not_quarantined)

        def second_intent_unverified():
            intents.wait_for(lambda: intent(b['id'])['failure_code'] == 'OWNERSHIP_PROBE_UNVERIFIED',
                             'second intent did not reach OWNERSHIP_PROBE_UNVERIFIED', 40)
            b['native'] = lost(b['id'])[0]
            expect(len(lost(b['id'])) == 1 and intent(b['id'])['state'] != 'QUARANTINED', intent(b['id']))
        check('provider.probe.unverified-keeps-intent-reconcilable', second_intent_unverified)

        def deleted_survives():
            evidence = intents.sha(b'operator-observed-provider-console-absence-3-12')
            result = ok('provider.orphans.resolve', {'pool_id': f.pool, 'native_sandbox_id': a['native'], 'resolution': 'DELETE',
                                                     'reason': 'operator removed the resource in the provider console', 'evidence_digest': evidence})
            expect(result['state'] == 'DELETED', result)
            expect(not [c for c in provider()['calls'] if c['method'] == 'destroy'] and a['native'] in provider()['resources'],
                   'DELETE called the provider')
            at_delete = int(orphan(a['native'])['seen'])
            mark = len(provider()['calls'])
            configure(probe_mode='normal')
            row = intents.wait_for(lambda: (lambda r: r if r['native_sandbox_id'] == b['native'] else None)(intent(b['id'])),
                                   'second intent was not adopted once its probe succeeded', 40)
            expect(orphan(b['native'])['state'] == 'OWNERSHIP_VERIFIED', (row, orphan(b['native'])))
            qa = intents.wait_for(lambda: (lambda r: r if r['state'] == 'QUARANTINED' else None)(intent(a['id'])),
                                  'first intent with a DELETED candidate did not quarantine', 40)
            expect(qa['failure_code'] == 'OWNERSHIP_UNVERIFIED' and qa['native_sandbox_id'] is None, qa)
            now = orphan(a['native'])
            expect(now['state'] == 'DELETED' and int(now['seen']) > at_delete, ('DELETED orphan reopened or not re-observed', now, at_delete))
            expect(probes(a['native'], mark) == [], ('a DELETED orphan was probed', probes(a['native'], mark)))
            expect(not [c for c in provider()['calls'] if c['method'] == 'destroy'], 'reconciliation destroyed a DELETED orphan')
        check('provider.orphan.deleted-survives-reobservation', deleted_survives)
        f.close()
        f = None
    finally:
        if f is not None:
            try:
                f.close()
            except Exception as error:
                print('provider fixture cleanup failed: ' + str(error), file=sys.stderr)
        shutil.rmtree(folder, ignore_errors=True)


def main():
    # Only the owned cluster is reachable: never let an inherited database URL redirect a probe.
    for key in list(os.environ):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del os.environ[key]
    base = os.environ.copy()
    if not (SERVICE / 'node_modules').exists():
        print('SKIP: service node_modules unavailable', flush=True)
        return 77
    run(['npm', '--prefix', str(SERVICE), 'run', 'build'], base)
    check('dispatch.template-names-finding-consumers', lambda: expect(
        json.loads(TEMPLATE.read_text())['consumer_ids'] == ['finding:manager', 'finding:operator'], TEMPLATE.read_text()))
    railway_part()
    binaries = postgres_bin()
    reason = None
    if binaries is None or not (binaries / 'initdb').exists():
        reason = 'no PostgreSQL server binaries (initdb); set HYPERFIDE_PG_BIN'
    elif os.geteuid() != 0 or shutil.which('runuser') is None:
        reason = 'the owned cluster runs initdb through runuser postgres, which needs root'
    if reason:
        print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
        if FAILED:
            return 1
        print('SKIP: ' + reason, flush=True)
        return 77
    cluster, clean = None, False
    try:
        cluster = Cluster(binaries)
        outbox_part(cluster, base)
        os.environ['DATABASE_URL'] = cluster.url()
        provider_part(load('provider_intent_fixture_3_12', 'tests/hyperfide/cases/tasks/8_3.py'))
    except Exception as error:
        FAILED.append('fixture')
        print('fixture: ' + str(error)[:3000], file=sys.stderr)
    finally:
        os.environ.pop('DATABASE_URL', None)
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'observed_absent': clean}], 'complete': clean}), flush=True)
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
