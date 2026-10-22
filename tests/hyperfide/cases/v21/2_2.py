#!/usr/bin/env python3
"""hyperfide-v21 2.2: Railway ownership probe and 429/5xx backoff before UNKNOWN.

The Railway GraphQL API is stubbed over local HTTP (found, not found, 429 then found,
persistent 429, 5xx then found, foreign marker). No real Railway endpoint or credential is used.
The TypeScript sources are compiled into a temporary directory so stale dist/ cannot pass this."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
DIGEST = 'sha256:' + '1' * 64
SCOPE = {'organisation_id': 'org-1', 'pool_id': 'pool-1', 'provider': 'railway', 'provider_account_id': 'account-1',
         'environment_id': 'environment-1', 'region': 'region-1', 'configuration_digest': DIGEST}
OPERATION = '6f2c1d8e-0000-4000-8000-000000000001'
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
        actual = f'{type(error).__name__}: {error}'
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


class Stub:
    """Scripted Railway API. Each sandbox id names its behaviour; every request is logged."""

    def __init__(self):
        self.requests = []
        self.counts = {}
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=None, headers=()):
                data = json.dumps(body).encode() if body is not None else b''
                self.send_response(status)
                for key, value in headers:
                    self.send_header(key, value)
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                raw = json.loads(self.rfile.read(int(self.headers['content-length'])))
                query, variables = raw['query'], raw.get('variables', {})
                sid = variables.get('id')
                kind = 'exec' if 'sandboxExec' in query else 'destroy' if 'sandboxDestroy' in query else 'get'
                owner.requests.append((kind, sid))
                n = owner.counts[(kind, sid)] = owner.counts.get((kind, sid), 0) + 1
                if sid == 'sb-throttled':
                    return self.reply(429, {'errors': [{'message': 'rate limited'}]}, [('retry-after', '0')])
                if sid == 'sb-throttled-then-found' and kind == 'get' and n <= 2:
                    return self.reply(429, {'errors': [{'message': 'rate limited'}]}, [('retry-after', '1' if n == 1 else '0')])
                if sid == 'sb-503-then-found' and kind == 'get' and n == 1:
                    return self.reply(503)
                if kind == 'destroy':
                    return self.reply(503)
                if kind == 'exec':
                    marker = 'some-other-operation' if sid == 'sb-foreign' else OPERATION
                    return self.reply(200, {'data': {'sandboxExec': {'exitCode': 0, 'stdout': marker + '\n', 'stderr': '',
                                                                     'truncated': False, 'timedOut': False}}})
                if sid == 'sb-missing':
                    return self.reply(200, {'data': {'sandbox': None}})
                return self.reply(200, {'data': {'sandbox': {
                    'id': sid, 'status': 'CREATING' if sid == 'sb-creating' else 'RUNNING', 'networkIsolation': 'ISOLATED',
                    'environmentId': 'environment-1', 'region': 'region-1', 'idleTimeoutMinutes': 0,
                    'createdAt': '2026-10-22T00:00:00.000Z', 'domains': []}}})

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.endpoint = f'http://127.0.0.1:{self.server.server_address[1]}/graphql/v2'

    def count(self, kind, sid):
        return self.counts.get((kind, sid), 0)


DRIVER = r"""
import fs from 'node:fs';
const [build,inputPath]=process.argv.slice(1);
const data=JSON.parse(fs.readFileSync(inputPath,'utf8'));
const prep=await import(build+'/providers/railway/preparation.js');
const rec=await import(build+'/providers/railway/reconciliation.js');
const client=new prep.RailwayClient(data.config,{HF_RAILWAY_FIXTURE_TOKEN:'not-a-real-credential'});
const out={};
const timed=async(fn)=>{const start=Date.now();try{return {ok:true,value:await fn(),ms:Date.now()-start};}
  catch(e){return {ok:false,name:e.constructor.name,code:e.code??null,provider_code:e.providerCode??null,
    attempts:e.attempts??null,retry_after_ms:e.retryAfterMs??null,message:String(e.message),ms:Date.now()-start};}};
for(const id of data.probes)out['probe:'+id]=await timed(()=>rec.probeRailwayOwnership(client,data.scope,data.operation_id,id,AbortSignal.timeout(60000)));
out.wrong_scope=await timed(()=>rec.probeRailwayOwnership(client,{...data.scope,environment_id:'environment-2'},data.operation_id,'sb-found'));
const ac=new AbortController();setTimeout(()=>ac.abort(),50);
out.aborted=await timed(()=>rec.probeRailwayOwnership(client,data.scope,data.operation_id,'sb-throttled',ac.signal));
const delays=[];for(let a=0;a<8;a++)delays.push([prep.railwayBackoffDelay(a,null,()=>0.999999),prep.railwayBackoffDelay(a,null,()=>0),prep.railwayBackoffDelay(a,3000,()=>0),prep.railwayBackoffDelay(a,10**9,()=>0)]);
out.delays=delays;out.policy=prep.RAILWAY_BACKOFF;
out.mutation=await timed(()=>client.request('mutation RailwayDestroy($environmentId:String!,$id:String!){sandboxDestroy(environmentId:$environmentId,id:$id)}',{environmentId:'environment-1',id:'sb-destroy'}));
// Adapter observe: a throttled read must back off and then record the attempt count in its UNKNOWN observation.
const observations=[];
const adapter=rec.createRailwayAdapter(client,{persistence:{recordObservation:async(op,outcome)=>{observations.push(outcome);}},
  runtimeProfile:async()=>{throw new Error('unused');},preparedBase:async()=>{throw new Error('unused');},
  credentials:async()=>({}),sessions:{}});
for(const [key,id] of [['observe_throttled','sb-throttled'],['observe_recovered','sb-503-then-found']]){
  const op=data.observe[id];
  out[key]=await timed(()=>adapter.observe(op,AbortSignal.timeout(60000)));
}
out.observations=observations;
// Registration: the provisioner runtime hands the probe to the 8.2 registry, bound to configured pools.
const registered={};
const registry={registerProviderAdapter:()=>()=>{registered.adapter_closed=true;},registerIsolationTransport:()=>()=>{},
  registerArtifactReferenceReader:()=>()=>{},registerProviderQuotaObserver:()=>()=>{},
  registerProviderOwnershipProbe:(provider,probe)=>{registered.provider=provider;registered.probe=probe;return ()=>{registered.probe_closed=true;};}};
const credentials={inspectInTransaction(){},resolveCredentialReferences(){},inspect(){},attach(){},privateAttachment(){}};
const capabilities={'8.2':registry,'14.2':credentials,'15.2':{invoke(){}}};
const context={env:data.env,signal:new AbortController().signal,dependencies:{require:(id,name,guard)=>{
  const v=capabilities[id];if(!guard(v))throw new Error('guard refused '+id);return v;}}};
const component=rec.createComponent(context);
out.registered_provider=registered.provider??null;
out.registered_probe=registered.probe?await timed(()=>registered.probe(data.scope,data.operation_id,'sb-registered',AbortSignal.timeout(60000))):null;
out.registered_foreign_pool=registered.probe?await timed(()=>registered.probe({...data.scope,pool_id:'pool-2'},data.operation_id,'sb-found',AbortSignal.timeout(60000))):null;
await component.close();
out.probe_unregistered=registered.probe_closed===true;
process.stdout.write(JSON.stringify(out));
"""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def operation(kind, sid):
    from datetime import datetime, timedelta, timezone
    deadline = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    op = {'schema_version': 1, 'kind': kind, 'scope': SCOPE, 'deadline_at': deadline,
          'identity': {'operation_id': 'observe-1', 'idempotency_key': 'idempotency-observe-1', 'payload_digest': '',
                       'correlation_id': 'correlation-1', 'causation_id': 'causation-1'},
          'resource': {'native_sandbox_id': sid, 'sandbox_boot_generation': '7'},
          'preparation_digest': None, 'parameters': {}}
    op['identity']['payload_digest'] = 'sha256:' + hashlib.sha256(canonical(
        {k: op[k] for k in ['kind', 'scope', 'resource', 'preparation_digest', 'deadline_at', 'parameters']}).encode()).hexdigest()
    return op


def main():
    stub = Stub()
    build = Path(tempfile.mkdtemp(prefix='.v21-2_2-build-', dir=SERVICE))
    work = Path(tempfile.mkdtemp(prefix='v21-2_2-'))
    try:
        tsc = subprocess.run(['npx', '--no-install', 'tsc', '-p', 'tsconfig.json', '--outDir', str(build)],
                             cwd=SERVICE, capture_output=True, text=True, timeout=600)
        if tsc.returncode != 0:
            print(tsc.stdout[-4000:], tsc.stderr[-4000:], file=sys.stderr)
            return 1
        compiled = build / 'providers/railway/reconciliation.js'
        if not compiled.exists():
            compiled = next(build.rglob('providers/railway/reconciliation.js'))
        root = compiled.parents[2]
        config = {'schema_version': 1, 'mode': 'component-fixture', 'endpoint': stub.endpoint, 'environment_id': 'environment-1',
                  'region': 'region-1', 'account_id': 'account-1', 'token_env': 'HF_RAILWAY_FIXTURE_TOKEN',
                  'auth_type': 'bearer', 'preparation_root': str(work / 'prep'), 'request_timeout_ms': 10000,
                  'exec_ws_endpoint': None}
        config_path = work / 'railway.json'
        config_path.write_text(json.dumps(config))
        config_path.chmod(0o600)
        policy = json.dumps({'schema_version': 1, 'pools': [{'scope': SCOPE, 'seed_reference': 'seed-1',
            'seed_source': {'kind': 'FRESH', 'reference': None}, 'idle_timeout_minutes': 0, 'domains': [],
            'runtime_variables': {}, 'build_variables': {},
            'retention': {'retention_class': 'EPHEMERAL', 'retention_until': None, 'retention_hold': False}}]}).encode()
        policy_path = work / 'policy.json'
        policy_path.write_bytes(policy)
        policy_path.chmod(0o600)
        spool = work / 'spool'
        env = {'HF_RAILWAY_CONFIG': str(config_path), 'HF_RAILWAY_FIXTURE_TOKEN': 'not-a-real-credential',
               'HF_RAILWAY_RUNTIME_POLICY': str(policy_path),
               'HF_RAILWAY_RUNTIME_POLICY_DIGEST': 'sha256:' + hashlib.sha256(policy).hexdigest(),
               'HF_RAILWAY_PROCESS_ROOT': str(spool)}
        probes = ['sb-found', 'sb-missing', 'sb-throttled-then-found', 'sb-throttled', 'sb-503-then-found', 'sb-foreign', 'sb-creating']
        payload = work / 'input.json'
        payload.write_text(json.dumps({'config': config, 'scope': SCOPE, 'operation_id': OPERATION, 'probes': probes,
                                       'observe': {sid: operation('observe', sid) for sid in ['sb-throttled', 'sb-503-then-found']}, 'env': env}))
        run = subprocess.run(['node', '--input-type=module', '-e', DRIVER, str(root), str(payload)],
                             cwd=SERVICE, capture_output=True, text=True, timeout=300)
        if run.returncode != 0:
            print(run.stdout[-4000:], run.stderr[-4000:], file=sys.stderr)
            return 1
        out = json.loads(run.stdout)
        policy_attempts = out['policy']['attempts']

        def probe(sid):
            return out['probe:' + sid]

        def found():
            r = probe('sb-found')
            expect(r['ok'] and r['value']['matches'] is True and r['value']['found'] is True, r)
            expect(r['value']['attempts'] == 2 and r['value']['provider_state'] == 'RUNNING', r)
            expect(r['value']['evidence_digest'].startswith('sha256:') and len(r['value']['evidence_digest']) == 71, r)
            expect(stub.count('exec', 'sb-found') == 1, 'marker read once')
        check('railway.probe.found-owned', found)

        def missing():
            r = probe('sb-missing')
            expect(r['ok'] and r['value']['matches'] is False and r['value']['found'] is False, r)
            expect(r['value']['attempts'] == 1 and stub.count('exec', 'sb-missing') == 0, (r, stub.counts))
        check('railway.probe.not-found-never-matches', missing)

        def throttled_then_found():
            r = probe('sb-throttled-then-found')
            expect(r['ok'] and r['value']['matches'] is True, r)
            expect(stub.count('get', 'sb-throttled-then-found') == 3, stub.counts)
            expect(r['value']['attempts'] == 4, r)  # three lookups and one marker read
            expect(r['ms'] >= 1000, ('Retry-After of 1s was not honoured', r['ms']))
        check('railway.probe.429-then-found-backs-off', throttled_then_found)

        def persistent():
            r = probe('sb-throttled')
            expect(not r['ok'] and r['name'] == 'RailwayRequestError' and r['code'] == 'UNKNOWN', r)
            expect(r['provider_code'] == 'HTTP_429' and r['attempts'] == policy_attempts, r)
            expect(stub.count('get', 'sb-throttled') >= policy_attempts, stub.counts)
            expect(stub.count('exec', 'sb-throttled') == 0, 'marker read without a lookup')
        check('railway.probe.persistent-429-bounded-then-unknown', persistent)

        def recovered_5xx():
            r = probe('sb-503-then-found')
            expect(r['ok'] and r['value']['matches'] is True and r['value']['attempts'] == 3, r)
        check('railway.probe.5xx-then-found-backs-off', recovered_5xx)

        def foreign():
            r = probe('sb-foreign')
            expect(r['ok'] and r['value']['found'] is True and r['value']['matches'] is False, r)
            c = probe('sb-creating')
            expect(c['ok'] and c['value']['matches'] is False and c['value']['provider_state'] == 'CREATING', c)
            expect(stub.count('exec', 'sb-creating') == 0, 'exec against a non-running sandbox')
        check('railway.probe.foreign-or-unready-never-matches', foreign)

        def refusals():
            expect(not out['wrong_scope']['ok'] and 'scope' in out['wrong_scope']['message'], out['wrong_scope'])
            expect(not out['aborted']['ok'] and out['aborted']['ms'] < 2000, out['aborted'])
        check('railway.probe.scope-and-abort-refuse', refusals)

        def jitter():
            base, cap = out['policy']['base_ms'], out['policy']['cap_ms']
            for attempt, (high, low, after, huge) in enumerate(out['delays']):
                ceiling = min(cap, base * 2 ** attempt)
                expect(low == 0 and ceiling - 1 <= high < ceiling, (attempt, high, low, ceiling))
                expect(after == min(3000, cap) and huge == cap, (attempt, after, huge))
        check('railway.backoff.full-jitter-bounded', jitter)

        def mutation():
            r = out['mutation']
            expect(not r['ok'] and r['provider_code'] == 'HTTP_503' and r['attempts'] == 1, r)
            expect(stub.count('destroy', 'sb-destroy') == 1, ('mutation replayed', stub.counts))
        check('railway.backoff.never-replays-mutations', mutation)

        def observation():
            expect(out['observe_throttled']['ok'], out['observe_throttled'])
            expect(out['observe_throttled']['ok'] and out['observe_recovered']['ok'], (out['observe_throttled'], out['observe_recovered']))
            t = out['observe_throttled']['value']
            expect(t['status'] == 'UNKNOWN' and t['error']['code'] == 'RATE_LIMIT' and t['error']['provider_code'] == 'HTTP_429', t)
            expect(f'after {policy_attempts} attempts' in t['error']['message'], t['error'])
            expect(isinstance(t['error']['retry_after_ms'], int), t['error'])
            expect(out['observations'][0] == t, 'recorded observation differs from returned outcome')
            ok = out['observe_recovered']['value']
            expect(ok['status'] == 'SUCCEEDED' and ok['result']['provider_state'] == 'RUNNING', ok)
        check('railway.observe.attempts-in-unknown-observation', observation)

        def registration():
            expect(out['registered_provider'] == 'railway', out['registered_provider'])
            r = out['registered_probe']
            expect(r and r['ok'] and r['value']['matches'] is True, r)
            f = out['registered_foreign_pool']
            expect(f and not f['ok'] and 'pool policy' in f['message'], f)
            expect(out['probe_unregistered'] is True, 'probe left registered after close')
        check('railway.probe.registered-with-provider-runtime', registration)
    finally:
        stub.server.shutdown()
        shutil.rmtree(build, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
