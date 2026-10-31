#!/usr/bin/env python3
"""hyperfide-v21 2.3: attestation expiry warnings and live quota observers.

Part one compiles the TypeScript sources into a temporary directory (stale dist/ cannot pass) and
drives the Railway and Blaxel quota observers with injected transports and a loopback stub: no real
provider endpoint or credential is used. Part two runs the real provisioner service over signed HTTPS
against an owned, ephemeral PostgreSQL cluster and asserts the seven-day attestation warning window.
"""
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
DIGEST = 'sha256:' + '1' * 64
RAILWAY_SCOPE = {'organisation_id': 'org-1', 'pool_id': 'pool-1', 'provider': 'railway', 'provider_account_id': 'account-1',
                 'environment_id': 'environment-1', 'region': 'region-1', 'configuration_digest': DIGEST}
BLAXEL_SCOPE = {**RAILWAY_SCOPE, 'provider': 'blaxel', 'provider_account_id': 'blaxel-account', 'environment_id': 'blaxel-workspace'}
FAILED = []
OBSERVED = []


def expect(value, message):
    if not value:
        raise AssertionError(str(message)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    OBSERVED.append({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual})
    print(json.dumps(OBSERVED[-1]), flush=True)


class BlaxelStub:
    """Loopback recorded Blaxel quota endpoint; one 503 first to exercise the read backoff."""

    def __init__(self):
        self.requests = []
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                owner.requests.append({'path': self.path, 'authorization': self.headers.get('authorization')})
                if len(owner.requests) == 1:
                    body, status = b'{}', 503
                else:
                    body, status = json.dumps({'accountId': 'blaxel-account', 'environmentId': 'blaxel-workspace', 'limits': [
                        {'scope': 'ACCOUNT', 'dimension': 'SANDBOX', 'limit': '40'},
                        {'scope': 'ENVIRONMENT', 'dimension': 'SANDBOX', 'limit': '30'}]}).encode(), 200
                self.send_response(status)
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = 'http://127.0.0.1:%d/v0/quotas' % self.server.server_address[1]


DRIVER = r"""
import fs from 'node:fs';
const [build,inputPath]=process.argv.slice(1);
const data=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const pools=await import(build+'/providers/pools.js');
const prep=await import(build+'/providers/railway/preparation.js');
const rec=await import(build+'/providers/railway/reconciliation.js');
const blaxel=await import(build+'/providers/blaxel/processes.js');
const out={ttl:pools.QUOTA_OBSERVATION_TTL_MS,window:pools.ATTESTATION_WARNING_WINDOW_SECONDS,railway_ttl:rec.RAILWAY_QUOTA_TTL_MS};
const timed=async fn=>{try{return {ok:true,value:await fn()};}catch(e){return {ok:false,code:e.code??null,name:e.constructor.name,message:String(e.message)};}};
const answer=(account,environment,limits)=>({accountId:account,environmentId:environment,limits});
const LIMITS=[{scope:'ACCOUNT',dimension:'SANDBOX',limit:'50'},{scope:'ENVIRONMENT',dimension:'SANDBOX',limit:'25'}];
// Railway: transport injection keeps every request in-process; the live endpoint is never contacted.
function railway(mode,script){
  const calls=[];
  const transport=async(url,init)=>{const body=JSON.parse(init.body);calls.push({url:String(url),query:body.query});
    const next=script.shift()??{status:200,data:{sandboxQuota:answer('account-1','environment-1',LIMITS)}};
    return new Response(JSON.stringify(next.status===200?{data:next.data}:{errors:[{message:'x'}]}),{status:next.status,headers:next.headers??{}});};
  const config={...data.railway_config,mode,endpoint:mode==='live'?'https://backboard.railway.com/graphql/v2':'http://127.0.0.1:9/graphql'};
  return {client:new prep.RailwayClient(config,{HF_RAILWAY_FIXTURE_TOKEN:'not-a-real-credential'},transport),calls};
}
{const r=railway('component-fixture',[]);out.railway_recorded=await timed(()=>rec.observeRailwayQuota(r.client,data.railway_scope));out.railway_recorded_calls=r.calls.length;}
{const r=railway('live',[]);out.railway_live_default=await timed(()=>rec.observeRailwayQuota(r.client,data.railway_scope));out.railway_live_default_calls=r.calls.length;}
{const r=railway('live',[]);out.railway_live_off=await timed(()=>rec.observeRailwayQuota(r.client,data.railway_scope,undefined,{live_quota_observer:false}));out.railway_live_off_calls=r.calls.length;}
{const r=railway('live',[{status:429,headers:{'retry-after':'0'}}]);out.railway_live_on=await timed(()=>rec.observeRailwayQuota(r.client,data.railway_scope,undefined,{live_quota_observer:true}));
 out.railway_live_on_calls=r.calls.map(c=>c.url);}
{const r=railway('live',[{status:200,data:{sandboxQuota:answer('account-other','environment-1',LIMITS)}}]);
 out.railway_live_foreign=await timed(()=>rec.observeRailwayQuota(r.client,data.railway_scope,undefined,{live_quota_observer:true}));}
// Trusted pool policy parsing: the flag is optional, boolean only, and absent means off.
const policyFile=async(i,extra)=>{const bytes=Buffer.from(JSON.stringify({schema_version:1,pools:[{...data.railway_policy,...extra}]}));
  const file=data.work+'/policy-'+i+'.json';fs.writeFileSync(file,bytes,{mode:0o600});
  return {HF_RAILWAY_RUNTIME_POLICY:file,HF_RAILWAY_RUNTIME_POLICY_DIGEST:'sha256:'+(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')};};
out.policy_absent=await timed(async()=>rec.railwayRuntimePolicies({env:await policyFile(1,{})})[0].live_quota_observer);
out.policy_true=await timed(async()=>rec.railwayRuntimePolicies({env:await policyFile(2,{live_quota_observer:true})})[0].live_quota_observer);
out.policy_string=await timed(async()=>rec.railwayRuntimePolicies({env:await policyFile(3,{live_quota_observer:'true'})})[0].live_quota_observer);
out.policy_digest_unchanged=rec.railwayRuntimePolicyDigest({...data.railway_policy,live_quota_observer:true})===rec.railwayRuntimePolicyDigest(data.railway_policy);
// Blaxel: same contract. RECORDED via the loopback stub through the registered observer; LIVE via injected transport.
const blaxelConfig=(i,body)=>{const file=data.work+'/blaxel-quota-'+i+'.json';fs.writeFileSync(file,JSON.stringify(body),{mode:0o600});return file;};
const baseEnv={HF_BLAXEL_ACCOUNT_ID:'blaxel-account',HF_BLAXEL_WORKSPACE:'blaxel-workspace'};
const registered={};
const registry={registerProviderAdapter:()=>()=>{},registerIsolationTransport:()=>()=>{},registerProviderOwnershipProbe:()=>()=>{},
  registerProviderQuotaObserver:(provider,observer)=>{registered.provider=provider;registered.observer=observer;return ()=>{registered.closed=true;};}};
const ctx={env:{...baseEnv,HF_BLAXEL_QUOTA_CONFIG:blaxelConfig(1,{schema_version:1,endpoint:data.blaxel_endpoint})},signal:new AbortController().signal,
  dependencies:{require:(id,name,guard)=>{const v=id==='8.2'?registry:{resolveCredentialReferences(){}};if(!guard(v))throw new Error('guard '+id);return v;}}};
const component=blaxel.createComponent(ctx);
out.blaxel_registered=registered.provider??null;
out.blaxel_recorded=registered.observer?await timed(()=>registered.observer(data.blaxel_scope,AbortSignal.timeout(30000))):null;
out.blaxel_foreign_scope=registered.observer?await timed(()=>registered.observer({...data.blaxel_scope,environment_id:'other-workspace'},AbortSignal.timeout(30000))):null;
component.close();out.blaxel_unregistered=registered.closed===true;
const liveCalls=[];
const liveTransport=async(url,init)=>{liveCalls.push({url:String(url),authorization:init.headers.Authorization??null,workspace:init.headers['X-Blaxel-Workspace']??null});
  return new Response(JSON.stringify(answer('blaxel-account','blaxel-workspace',[{scope:'ACCOUNT',dimension:'CPU_MILLIS',limit:'64000'}])),{status:200});};
const live=(i,body,extra={})=>blaxel.observeBlaxelQuota({env:{...baseEnv,...extra,HF_BLAXEL_QUOTA_CONFIG:blaxelConfig(i,body)}},data.blaxel_scope,AbortSignal.timeout(30000),liveTransport);
const LIVE_ENDPOINT='https://api.blaxel.ai/v0/quotas';
out.blaxel_live_default=await timed(()=>live(2,{schema_version:1,endpoint:LIVE_ENDPOINT},{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'not-a-real-key'}));
out.blaxel_live_string=await timed(()=>live(3,{schema_version:1,endpoint:LIVE_ENDPOINT,live_quota_observer:'true'},{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'not-a-real-key'}));
out.blaxel_live_no_enablement=await timed(()=>live(4,{schema_version:1,endpoint:LIVE_ENDPOINT,live_quota_observer:true}));
out.blaxel_live_calls_before=liveCalls.length;
out.blaxel_live_on=await timed(()=>live(5,{schema_version:1,endpoint:LIVE_ENDPOINT,live_quota_observer:true},{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'not-a-real-key'}));
out.blaxel_live_calls=liveCalls;
out.blaxel_foreign_host=await timed(()=>live(6,{schema_version:1,endpoint:'https://evil.example/v0/quotas',live_quota_observer:true},{HF_BLAXEL_LIVE_ENABLED:'true',HF_BLAXEL_API_KEY:'not-a-real-key'}));
out.blaxel_unconfigured=await timed(()=>blaxel.observeBlaxelQuota({env:baseEnv},data.blaxel_scope,AbortSignal.timeout(30000),liveTransport));
// Both providers' observations must pass the shared contract validator unchanged.
const validate=(rows,scope)=>rows.map(r=>pools.validateQuotaObservation(r,scope));
out.contract=await timed(async()=>{validate(out.railway_recorded.value,data.railway_scope);validate(out.railway_live_on.value,data.railway_scope);
  validate(out.blaxel_recorded.value,data.blaxel_scope);validate(out.blaxel_live_on.value,data.blaxel_scope);return true;});
process.stdout.write(JSON.stringify(out));
"""


def observer_part():
    stub = BlaxelStub()
    build = Path(tempfile.mkdtemp(prefix='.v21-2_3-build-', dir=SERVICE))
    work = Path(tempfile.mkdtemp(prefix='v21-2_3-'))
    try:
        tsc = subprocess.run(['npx', '--no-install', 'tsc', '-p', 'tsconfig.json', '--outDir', str(build)],
                             cwd=SERVICE, capture_output=True, text=True, timeout=600)
        if tsc.returncode != 0:
            raise AssertionError('tsc: ' + (tsc.stdout + tsc.stderr)[-3000:])
        compiled = next(build.rglob('providers/railway/reconciliation.js'))
        root = compiled.parents[2]
        railway_config = {'schema_version': 1, 'mode': 'component-fixture', 'endpoint': 'http://127.0.0.1:9/graphql',
                          'environment_id': 'environment-1', 'region': 'region-1', 'account_id': 'account-1',
                          'token_env': 'HF_RAILWAY_FIXTURE_TOKEN', 'auth_type': 'bearer', 'preparation_root': str(work / 'prep'),
                          'request_timeout_ms': 10000, 'exec_ws_endpoint': None}
        railway_policy = {'scope': RAILWAY_SCOPE, 'seed_reference': 'seed-1', 'seed_source': {'kind': 'FRESH', 'reference': None},
                          'idle_timeout_minutes': 0, 'domains': [], 'runtime_variables': {}, 'build_variables': {},
                          'retention': {'retention_class': 'EPHEMERAL', 'retention_until': None, 'retention_hold': False}}
        payload = work / 'input.json'
        payload.write_text(json.dumps({'railway_config': railway_config, 'railway_scope': RAILWAY_SCOPE, 'railway_policy': railway_policy,
                                       'blaxel_scope': BLAXEL_SCOPE, 'blaxel_endpoint': stub.endpoint, 'work': str(work)}))
        # The Blaxel SDK refuses a working directory carrying .env or blaxel.toml; run from the empty work dir.
        run = subprocess.run(['node', '--input-type=module', '-e', DRIVER, str(root), str(payload)],
                             cwd=work, capture_output=True, text=True, timeout=300)
        if run.returncode != 0:
            raise AssertionError('driver: ' + (run.stdout + run.stderr)[-3000:])
        out = json.loads(run.stdout)
    finally:
        stub.server.shutdown()
        shutil.rmtree(build, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)

    def railway_recorded():
        r = out['railway_recorded']
        expect(r['ok'] and out['railway_recorded_calls'] == 1, r)
        expect(all(o['basis'] == 'PROVIDER_API' and o['evidence_reference'].startswith('simulated:railway-component-fixture:sha256:') for o in r['value']), r)
    check('v21.2.3.railway-recorded-unchanged', railway_recorded)

    def railway_live_default_off():
        for key in ['railway_live_default', 'railway_live_off']:
            r = out[key]
            expect(not r['ok'] and r['message'].startswith('QUOTA_UNQUALIFIED') and out[key + '_calls'] == 0, (key, r))
    check('v21.2.3.railway-live-off-without-flag', railway_live_default_off)

    def railway_live_on():
        r = out['railway_live_on']
        expect(r['ok'], r)
        expect(out['railway_live_on_calls'] == ['https://backboard.railway.com/graphql/v2'] * 2, ('429 was not retried once', out['railway_live_on_calls']))
        rows = {(o['scope_kind'], o['scope_key'], o['dimension'], o['limit']) for o in r['value']}
        expect(rows == {('ACCOUNT', 'account-1', 'SANDBOX', '50'), ('ENVIRONMENT', 'environment-1', 'SANDBOX', '25')}, rows)
        expect(all(o['evidence_reference'].startswith('railway-live:sha256:') and o['basis'] == 'PROVIDER_API' for o in r['value']), r)
        ttl = [(time.mktime(time.strptime(o['expires_at'][:19], '%Y-%m-%dT%H:%M:%S')) - time.mktime(time.strptime(o['observed_at'][:19], '%Y-%m-%dT%H:%M:%S'))) for o in r['value']]
        expect(all(abs(t * 1000 - out['ttl']) <= 1000 for t in ttl) and out['railway_ttl'] == out['ttl'], ttl)
        foreign = out['railway_live_foreign']
        expect(not foreign['ok'] and foreign['code'] == 'PROTOCOL', ('foreign account accepted', foreign))
    check('v21.2.3.railway-live-observer-under-flag', railway_live_on)

    def policy_flag():
        expect(out['policy_absent'] == {'ok': True, 'value': False}, ('absent flag must be off', out['policy_absent']))
        expect(out['policy_true'] == {'ok': True, 'value': True}, out['policy_true'])
        expect(not out['policy_string']['ok'] and out['policy_string']['code'] == 'QUOTA_POLICY_INVALID', ('string flag accepted', out['policy_string']))
        expect(out['policy_digest_unchanged'] is True, 'flag changed the approved adapter policy digest')
    check('v21.2.3.policy-flag-no-default', policy_flag)

    def blaxel_recorded():
        expect(out['blaxel_registered'] == 'blaxel' and out['blaxel_unregistered'] is True, out)
        r = out['blaxel_recorded']
        expect(r['ok'], r)
        expect(len(stub.requests) == 2 and stub.requests[1]['path'] == '/v0/quotas?workspace=blaxel-workspace', ('503 not retried once', stub.requests))
        expect(all(q['authorization'] is None for q in stub.requests), 'recorded mode sent a credential')
        rows = {(o['scope_kind'], o['scope_key'], o['dimension'], o['limit']) for o in r['value']}
        expect(rows == {('ACCOUNT', 'blaxel-account', 'SANDBOX', '40'), ('ENVIRONMENT', 'blaxel-workspace', 'SANDBOX', '30')}, rows)
        expect(all(o['evidence_reference'].startswith('blaxel-recorded:sha256:') for o in r['value']), r)
        foreign = out['blaxel_foreign_scope']
        expect(not foreign['ok'] and foreign['code'] == 'BLAXEL_PROCESS_INVALID', foreign)
    check('v21.2.3.blaxel-recorded-observer-registered', blaxel_recorded)

    def blaxel_live():
        for key, code in [('blaxel_live_default', 'QUOTA_UNQUALIFIED'), ('blaxel_live_string', 'QUOTA_POLICY_INVALID'),
                          ('blaxel_live_no_enablement', 'BLAXEL_CREDENTIALS_UNAVAILABLE'), ('blaxel_foreign_host', 'QUOTA_POLICY_INVALID'),
                          ('blaxel_unconfigured', 'QUOTA_UNQUALIFIED')]:
            expect(not out[key]['ok'] and out[key]['code'] == code, (key, out[key]))
        expect(out['blaxel_live_calls_before'] == 0, 'a refused live observer reached the transport')
        r = out['blaxel_live_on']
        expect(r['ok'] and all(o['evidence_reference'].startswith('blaxel-live:sha256:') for o in r['value']), r)
        expect(out['blaxel_live_calls'] == [{'url': 'https://api.blaxel.ai/v0/quotas?workspace=blaxel-workspace',
                                             'authorization': 'Bearer not-a-real-key', 'workspace': 'blaxel-workspace'}], out['blaxel_live_calls'])
    check('v21.2.3.blaxel-live-under-flag', blaxel_live)

    check('v21.2.3.observer-contract-shared', lambda: expect(out['contract'] == {'ok': True, 'value': True}, out['contract']))
    check('v21.2.3.warning-window-seven-days', lambda: expect(out['window'] == 7 * 86400, out['window']))


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def warning_part(harness, intents):
    f = None
    try:
        def setup(fixture):
            intents.prepare_provider_intent_fixture(fixture)
            fixture.declaration_path = fixture.path / 'capacity-declarations.json'
            fixture.env['HYPERFIDE_CAPACITY_ATTESTATIONS'] = str(fixture.declaration_path)
        f = intents.pools.ProvisionerFixture(extra_components=['8.2', '8.3'], extra_setup=setup)
        org, run_id = f.ids['organisation'], f.ids['run']

        def ok(action, payload, key='operator'):
            status, response = f.invoke(action, payload, component='8.2', key=key)
            expect(status == 200 and response.get('ok') is True, (action, status, response))
            return response['result']

        ok('provider.pools.configure', {})
        active = f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active', [org, f.pool])[0]['configuration_digest']
        provenance = f.path / 'operator-provenance.txt'
        provenance.write_bytes(b'v21 2.3 component-fixture operator declaration; not live capacity evidence.')
        artifact = str(uuid.uuid4())
        f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,$5,'COMPONENT_FIXTURE',$6,'COMPLETE',clock_timestamp())",
              [org, run_id, artifact, intents.sha(provenance.read_bytes()), str(provenance.stat().st_size), str(provenance)])
        stamp = lambda seconds: time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + seconds))
        day = 86400
        ids = {}

        def attest(entries):
            declarations = []
            for name, kind, dimension, seconds in entries:
                ids[name] = str(uuid.uuid4())
                declarations.append({'id': ids[name], 'pool_id': f.pool, 'configuration_digest': active, 'scope_kind': kind,
                                     'scope_key': 'fixture-account' if kind == 'ACCOUNT' else 'fixture-env', 'dimension': dimension,
                                     'limit': '20', 'declared_at': stamp(-1), 'expires_at': stamp(seconds),
                                     'provenance': {'run_id': run_id, 'artifact_id': artifact, 'digest': intents.sha(provenance.read_bytes())}})
            f.declaration_path.write_text(json.dumps({'schema_version': 1, 'organisation_id': org, 'attestations': declarations}))
            f.declaration_path.chmod(0o600)
            return ok('provider.pools.attest-capacity', {})

        attest([('soon', 'ACCOUNT', 'SANDBOX', 3 * day), ('later', 'ENVIRONMENT', 'SANDBOX', 10 * day),
                ('inside', 'ACCOUNT', 'CPU_MILLIS', 7 * day - 120), ('outside', 'ENVIRONMENT', 'CPU_MILLIS', 7 * day + 120),
                ('renewed-old', 'ACCOUNT', 'MEMORY_BYTES', 2 * day), ('renewed-new', 'ACCOUNT', 'MEMORY_BYTES', 20 * day),
                ('lapsing', 'ENVIRONMENT', 'MEMORY_BYTES', 4)])

        def warnings():
            return {w['attestation_id']: w for w in ok('provider.pools.capacity', {'pool_id': f.pool})['attestation_warnings']}

        def window():
            w = warnings()
            expect(set(w) == {ids['soon'], ids['inside'], ids['lapsing']}, ('wrong warning set', {k: v['dimension'] for k, v in w.items()}, ids))
            soon = w[ids['soon']]
            expect(soon['state'] == 'EXPIRING' and soon['severity'] == 'WARNING' and soon['action'] == 'RENEW_CAPACITY_ATTESTATION', soon)
            expect(soon['scope_kind'] == 'ACCOUNT' and soon['dimension'] == 'SANDBOX' and soon['limit'] == '20' and soon['pool_id'] == f.pool, soon)
            expect(3 * day - 120 <= soon['seconds_remaining'] <= 3 * day, soon)
            expect(w[ids['inside']]['seconds_remaining'] <= 7 * day, w[ids['inside']])
        check('v21.2.3.warning-window-boundaries', window)

        check('v21.2.3.renewal-clears-warning', lambda: expect(ids['renewed-old'] not in warnings() and ids['renewed-new'] not in warnings(), 'renewed attestation still warned'))

        def lapsed():
            time.sleep(6)
            w = warnings()
            expect(w[ids['lapsing']]['state'] == 'LAPSED' and w[ids['lapsing']]['severity'] == 'ERROR' and w[ids['lapsing']]['seconds_remaining'] == 0, w.get(ids['lapsing']))
        check('v21.2.3.lapsed-attestation-escalates', lapsed)

        def renew():
            attest([('soon-renewal', 'ACCOUNT', 'SANDBOX', 25 * day)])
            w = warnings()
            expect(ids['soon'] not in w and ids['soon-renewal'] not in w, ('renewal did not clear', w))
            listed = ok('provider.pools.list', {})['pools'][0]['attestation_warnings']
            expect({x['attestation_id'] for x in listed} == set(w), ('list and capacity disagree', listed))
        check('v21.2.3.operator-renewal-and-list-surface', renew)
    finally:
        if f is not None:
            f.close()


def main():
    try:
        observer_part()
    except Exception as error:
        FAILED.append('observer-fixture')
        print('observer fixture: ' + str(error)[:3000], file=sys.stderr)
    harness = load('v21_2_1_harness', 'tests/hyperfide/cases/v21/2_1.py')
    binaries = harness.postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN (observer checks ran above)', flush=True)
        return 1 if FAILED else 77
    if os.geteuid() != 0:
        print('SKIP: the owned cluster runs initdb through runuser postgres, which needs root', flush=True)
        return 1 if FAILED else 77
    for key in list(os.environ):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del os.environ[key]
    cluster = None
    clean = False
    try:
        harness.ensure_build()
        cluster = harness.Cluster(binaries)
        os.environ['DATABASE_URL'] = cluster.url()
        intents = load('provider_intent_fixture', 'tests/hyperfide/cases/tasks/8_3.py')
        warning_part(harness, intents)
    except Exception as error:
        FAILED.append('warning-fixture')
        print('warning fixture: ' + str(error)[:3000], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
        campaign = os.environ.get('HYPERFIDE_CAMPAIGN_DIR')
        if campaign:
            Path(campaign).mkdir(parents=True, exist_ok=True)
            (Path(campaign) / 'v21-2-3-observations.json').write_text(
                json.dumps({'assertions': OBSERVED, 'cluster_removed': clean}, indent=2) + '\n')
    if FAILED:
        print('FAILED: ' + ', '.join(FAILED), file=sys.stderr)
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
