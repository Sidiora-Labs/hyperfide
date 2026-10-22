#!/usr/bin/env python3
"""hyperfide-v21 2.12: every worker materialises a slice unless a full-tree reason is recorded.

The service source is compiled into a temporary tree, every trusted migration is applied to an owned throwaway
PostgreSQL 16 cluster, and slice history rows are written into the real tables (FK triggers are suspended only for
that seeding, so the rows need no packet, graph or sandbox ancestry). The executor's worker gate then resolves each
slot exactly as claim() does before a launch."""
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
import uuid
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
SUPERUSER = 'hf_superuser'
FAILED = []

PROBE = r"""
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
const dist=process.argv[2],i=JSON.parse(fs.readFileSync(0,'utf8'));
const out=v=>process.stdout.write(JSON.stringify(v));
const slices=await import(dist+'/preparation/slices.js');
const sha=t=>'sha256:'+createHash('sha256').update(t).digest('hex');
async function client(){const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
try{
 if(i.op==='migrate'){
  const {createResourceContainer}=await import(dist+'/storage/runtime.js'),{MigrationCoordinator}=await import(dist+'/storage/durability.js');
  const signal=new AbortController().signal,r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
  try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}
  out({ok:true});
 }else if(i.op==='seed'){
  const {canonicalJSON}=await import(dist+'/preparation/manifests.js');
  const c=await client(),digests={};
  try{
   await c.query('BEGIN');await c.query("SET LOCAL session_replication_role=replica");
   for(const m of i.manifests){
    const body={schema_version:1,kind:'hyperfide.workspace-slice',packet_digest:i.pin,repository_id:i.repository,commit:'a'.repeat(40),
     graph_manifest_id:m.mode==='SLICE'?i.graph:null,graph_manifest_digest:m.mode==='SLICE'?i.pin:null,mode:m.mode,fallback_reason:m.reason??null,
     included_paths:m.paths??[],excluded_roots:[],build_roots:[],metadata_roots:[],submodules:[],lfs_paths:[],
     closure:{complete:m.mode==='SLICE',seeds:1,files:1,edges:0,unresolved:0,truncated:false,tests:0,fixtures:0},diagnostics:[],
     input_roots:{contracts:[],registries:[]},budget:{files:100000,edges:4000000},slot:m.slot,
     parent_slice_digest:m.parent?digests[m.parent]:null,widening:m.parent?{added_paths:m.added,reason:'OUT_OF_SLICE_READ'}:null};
    const text=canonicalJSON(body),digest=sha(text);digests[m.name]=digest;
    await c.query('INSERT INTO hyperfide.workspace_slice_manifests(organisation_id,run_id,digest,derivation_key,packet_digest,repository_id,commit,graph_manifest_id,graph_manifest_digest,mode,fallback_reason,parent_slice_digest,manifest,manifest_text,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
     [i.organisation,m.run,digest,sha(m.name),i.pin,i.repository,body.commit,body.graph_manifest_id,body.graph_manifest_digest,m.mode,body.fallback_reason,body.parent_slice_digest,JSON.stringify({...body,digest}),text,i.credential]);
   }
   for(const x of i.materialisations){
    const evidence={schema_version:1,metrics:{worktree_bytes:x.bytes??0,disk_bytes:(x.bytes??0)*2}};
    await c.query('INSERT INTO hyperfide.workspace_slice_materialisations(organisation_id,run_id,id,slice_digest,sandbox_id,slot_id,sandbox_boot_generation,outcome,reason,released_materialisation_id,verified_head,evidence,evidence_digest,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,1,$7,NULL,$8,$9,$10,$11,$12)',
     [i.organisation,x.run,x.id,digests[x.manifest],x.slot.sandbox_id,x.slot.slot_id,x.outcome,x.released??null,x.outcome==='READY'?'a'.repeat(40):null,JSON.stringify(evidence),sha(JSON.stringify(evidence)),i.credential]);
   }
   for(const e of i.events){
    await c.query('INSERT INTO hyperfide.workspace_slice_access_events(organisation_id,run_id,id,slice_digest,path,access,source,decision,reason,widened_slice_digest,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
     [i.organisation,e.run,randomUUID(),digests[e.manifest],e.path,e.access,e.source,e.decision,e.reason,e.widened?digests[e.widened]:null,i.credential]);
   }
   await c.query('COMMIT');
  }finally{await c.end();}
  out({ok:digests});
 }else if(i.op==='gate'){
  const executor=await import(dist+'/runner/executor.js'),c=await client();
  try{out({ok:await executor.workerWorkspaceGate(c,i.job)});}finally{await c.end();}
 }else if(i.op==='summary'){
  const c=await client(),p=[i.organisation,i.run,i.digest];
  try{
   const m=(await c.query('SELECT outcome,evidence FROM hyperfide.workspace_slice_materialisations WHERE organisation_id=$1 AND run_id=$2 AND slice_digest=$3 ORDER BY created_at,id',p)).rows;
   const a=(await c.query('SELECT path,access,decision FROM hyperfide.workspace_slice_access_events WHERE organisation_id=$1 AND run_id=$2 AND slice_digest=$3 ORDER BY created_at,id',p)).rows;
   const k=(await c.query('SELECT digest FROM hyperfide.workspace_slice_manifests WHERE organisation_id=$1 AND run_id=$2 AND parent_slice_digest=$3',p)).rows.map(r=>r.digest);
   out({ok:slices.sliceSummary(m,a,k)});
  }finally{await c.end();}
 }else if(i.op==='widen')out({ok:slices.planWidening(i.manifest,i.findings,i.limit)});
 else if(i.op==='declaration')out({ok:slices.workspaceDeclaration(i.value)});
 else if(i.op==='describe')out({ok:await slices.createComponent({}).actions['preparation.slice.describe']({},{role:'control'})});
}catch(e){out({error:e.code??e.message,message:String(e.message).slice(0,400)});}
"""


def expect(value, message):
    if not value:
        raise AssertionError(str(message)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)[:1500]
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    installed = sorted((p for p in Path('/usr/lib/postgresql').glob('*/bin') if (p / 'initdb').exists() and (p / 'postgres').exists()),
                       key=lambda p: int(p.parent.name))
    return installed[-1] if installed else None


def run(argv, **kw):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=900, **kw)
    expect(p.returncode == 0, ' '.join(map(str, argv)) + ': ' + (p.stderr + p.stdout)[-2000:])
    return p.stdout


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory (pattern of v21/2_1.py)."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-2-12-', dir='/tmp/hyperfide'))
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

    def url(self):
        return 'postgresql://' + SUPERUSER + '@localhost:5432/postgres?host=' + quote(str(self.root), safe='')

    def close(self):
        if self.process and self.process.poll() is None:
            self.server('pg_ctl', '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop')
        if self.process:
            self.process.wait(timeout=60)
        shutil.rmtree(self.root, ignore_errors=True)


def build(base):
    service = base / 'services/hyperfide'
    service.mkdir(parents=True)
    for name in ['package.json', 'tsconfig.json']:
        shutil.copyfile(SERVICE / name, service / name)
    shutil.copytree(SERVICE / 'src', service / 'src')
    shutil.copytree(SERVICE / 'migrations', service / 'migrations')
    (service / 'node_modules').symlink_to((SERVICE / 'node_modules').resolve(), target_is_directory=True)
    run([str(service / 'node_modules/.bin/tsc'), '-p', 'tsconfig.json'], cwd=service)
    (service / 'probe.mjs').write_text(PROBE)
    return service


def main():
    if shutil.which('node') is None:
        print('SKIP: node is required')
        return 77
    if not (SERVICE / 'node_modules/.bin/tsc').exists():
        print('SKIP: services/hyperfide/node_modules is not installed')
        return 77
    binaries = postgres_bin()
    if binaries is None:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
        return 77
    with tempfile.TemporaryDirectory(prefix='hf-v21-2-12-') as tmp:
        service = build(Path(tmp))
        dist = str(service / 'dist')
        cluster = Cluster(binaries)
        env = dict(os.environ, DATABASE_URL=cluster.url())
        try:
            def probe(payload):
                r = subprocess.run(['node', str(service / 'probe.mjs'), dist], cwd=service, env=env, input=json.dumps(payload),
                                   capture_output=True, text=True, timeout=300)
                expect(r.returncode == 0 and r.stdout, ('probe', payload.get('op'), r.stdout, r.stderr[-1500:]))
                return json.loads(r.stdout)

            r = probe({'op': 'migrate'})
            expect(r.get('ok') is True, ('migration', r))
            org, run1, run2, cred, repo, graph = (str(uuid.uuid4()) for _ in range(6))
            pin = 'sha256:' + '1' * 64
            slot = {name: {'sandbox_id': str(uuid.uuid4()), 'slot_id': str(uuid.uuid4()), 'sandbox_boot_generation': '1'}
                    for name in 'ABCDEFG'}
            ids = {name: str(uuid.uuid4()) for name in ['a', 'b', 'd', 'd-release', 'f', 'g', 'e1', 'e2']}
            manifests = [
                {'name': 'slice-a', 'run': run1, 'mode': 'SLICE', 'slot': slot['A'], 'paths': ['src/a.ts', 'tests/']},
                {'name': 'full-b', 'run': run1, 'mode': 'FULL_TREE', 'reason': 'GRAPH_SOURCE_COVERAGE_INCOMPLETE', 'slot': slot['B']},
                {'name': 'slice-d', 'run': run1, 'mode': 'SLICE', 'slot': slot['D'], 'paths': ['src/d.ts']},
                {'name': 'slice-f', 'run': run2, 'mode': 'SLICE', 'slot': slot['F'], 'paths': ['src/f.ts']},
                {'name': 'slice-g', 'run': run1, 'mode': 'SLICE', 'slot': slot['G'], 'paths': ['src/a.ts', 'src/b.ts', 'tests/'],
                 'parent': 'slice-a', 'added': ['src/b.ts']},
                {'name': 'slice-e', 'run': run1, 'mode': 'SLICE', 'slot': slot['E'], 'paths': ['src/e.ts']},
            ]
            materialisations = [
                {'id': ids['a'], 'run': run1, 'manifest': 'slice-a', 'slot': slot['A'], 'outcome': 'READY', 'bytes': 4096},
                {'id': ids['b'], 'run': run1, 'manifest': 'full-b', 'slot': slot['B'], 'outcome': 'READY', 'bytes': 1 << 20},
                {'id': ids['d'], 'run': run1, 'manifest': 'slice-d', 'slot': slot['D'], 'outcome': 'READY'},
                {'id': ids['d-release'], 'run': run1, 'manifest': 'slice-d', 'slot': slot['D'], 'outcome': 'RELEASED', 'released': ids['d']},
                {'id': ids['f'], 'run': run2, 'manifest': 'slice-f', 'slot': slot['F'], 'outcome': 'READY'},
                {'id': ids['g'], 'run': run1, 'manifest': 'slice-g', 'slot': slot['G'], 'outcome': 'READY', 'bytes': 8192},
                {'id': ids['e1'], 'run': run1, 'manifest': 'slice-e', 'slot': slot['E'], 'outcome': 'READY'},
                {'id': ids['e2'], 'run': run1, 'manifest': 'slice-e', 'slot': slot['E'], 'outcome': 'READY'},
            ]
            events = [
                {'run': run1, 'manifest': 'slice-a', 'path': 'src/b.ts', 'access': 'READ', 'source': 'LAZY_FETCH', 'decision': 'REFUSED', 'reason': 'OUT_OF_SLICE_READ'},
                {'run': run1, 'manifest': 'slice-a', 'path': 'src/c.ts', 'access': 'READ', 'source': 'ACCESS_MONITOR', 'decision': 'REFUSED', 'reason': 'OUT_OF_SLICE_READ'},
                {'run': run1, 'manifest': 'slice-a', 'path': 'docs/x.md', 'access': 'WRITE', 'source': 'WORKTREE_STATUS', 'decision': 'REFUSED', 'reason': 'OUT_OF_SLICE_WRITE'},
                {'run': run1, 'manifest': 'slice-a', 'path': 'src/b.ts', 'access': 'READ', 'source': 'EXPLICIT_WIDENING', 'decision': 'WIDENED', 'reason': 'OUT_OF_SLICE_READ', 'widened': 'slice-g'},
            ]
            seeded = probe({'op': 'seed', 'organisation': org, 'credential': cred, 'repository': repo, 'graph': graph, 'pin': pin,
                            'manifests': manifests, 'materialisations': materialisations, 'events': events})
            expect('ok' in seeded, ('seed', seeded))
            digests = seeded['ok']

            def gate(slot_name, run_id=run1, workspace=None, job_class='WORKER', allocation=None, kind='AGENT'):
                request = {'argv': ['true']}
                if workspace is not None:
                    request['workspace'] = workspace
                bound = dict(slot[slot_name], job_kind=kind) if allocation is None else allocation
                job = {'organisation_id': org, 'run_id': run_id, 'job_class': job_class, 'plan': {'request': request, 'allocation': bound}}
                return probe({'op': 'gate', 'job': job})

            def refused(result, code):
                expect(result.get('error') == code, ('expected ' + code, result))

            check('default.no-slice-no-reason-refused', lambda: refused(gate('C'), 'WORKER_SLICE_REQUIRED'))

            def slice_runs():
                r = gate('A')['ok']
                expect(r == {'mode': 'SLICE', 'source': 'MATERIALISED_SLICE', 'slice_digest': digests['slice-a'], 'materialisation_id': ids['a'],
                             'fallback_reason': None}, r)
            check('default.materialised-slice-runs', slice_runs)
            check('default.released-slot-refused', lambda: refused(gate('D'), 'WORKER_SLICE_REQUIRED'))
            check('default.other-run-slice-invisible', lambda: refused(gate('F'), 'WORKER_SLICE_REQUIRED'))
            check('default.ambiguous-slot-refused', lambda: refused(gate('E'), 'WORKER_SLICE_AMBIGUOUS'))
            check('default.unbound-slot-refused', lambda: refused(gate('A', allocation={}), 'WORKER_SLICE_SLOT_UNBOUND'))
            check('default.preparation-exempt', lambda: expect(gate('C', job_class='PREPARATION') == {'ok': None}, 'preparation job was gated'))

            def worker_kinds():
                for kind in ['BUILD', 'TEST', 'REVIEW', 'INDEX', 'INTEGRATION']:
                    expect(gate('C', kind=kind) == {'ok': None}, ('verification kind gated', kind))
                for kind in ['AGENT', 'CHILD', 'SOMETHING_NEW']:
                    refused(gate('C', kind=kind), 'WORKER_SLICE_REQUIRED')
                refused(gate('C', allocation={k: v for k, v in slot['C'].items()}), 'WORKER_SLICE_REQUIRED')
            check('default.every-worker-kind-gated-verification-exempt', worker_kinds)
            check('default.declared-unmaterialised-slice-refused',
                  lambda: refused(gate('C', workspace={'mode': 'SLICE', 'slice_digest': digests['slice-a']}), 'WORKER_SLICE_REQUIRED'))

            def matching_declaration():
                r = gate('A', workspace={'mode': 'SLICE', 'slice_digest': digests['slice-a']})['ok']
                expect(r['mode'] == 'SLICE' and r['slice_digest'] == digests['slice-a'], r)
                refused(gate('A', workspace={'mode': 'SLICE', 'slice_digest': digests['slice-d']}), 'WORKER_SLICE_MISMATCH')
            check('default.declared-slice-must-match-slot', matching_declaration)

            def materialised_full_tree():
                r = gate('B')['ok']
                expect(r['mode'] == 'FULL_TREE' and r['source'] == 'MATERIALISED_FULL_TREE' and r['fallback_reason'] == 'GRAPH_SOURCE_COVERAGE_INCOMPLETE'
                       and r['slice_digest'] == digests['full-b'], r)
            check('fallback.full-tree-manifest-carries-recorded-reason', materialised_full_tree)

            def declared_full_tree():
                r = gate('C', workspace={'mode': 'FULL_TREE', 'fallback_reason': 'MONOREPO_WIDE_RENAME'})['ok']
                expect(r == {'mode': 'FULL_TREE', 'source': 'DECLARED_FULL_TREE', 'slice_digest': None, 'materialisation_id': None,
                             'fallback_reason': 'MONOREPO_WIDE_RENAME'}, r)
            check('fallback.declared-reason-recorded', declared_full_tree)

            def reason_required():
                for bad in [{'mode': 'FULL_TREE'}, {'mode': 'FULL_TREE', 'fallback_reason': 'because'}, {'mode': 'FULL_TREE', 'fallback_reason': ''},
                            {'mode': 'FULL_TREE', 'fallback_reason': 'X_Y_Z', 'extra': 1}, {'mode': 'SPARSE'}, 'FULL_TREE']:
                    refused(gate('C', workspace=bad), 'WORKER_WORKSPACE_INVALID')
            check('fallback.reason-required-and-well-formed', reason_required)
            check('fallback.cannot-bypass-materialised-slice',
                  lambda: refused(gate('A', workspace={'mode': 'FULL_TREE', 'fallback_reason': 'OPERATOR_PREFERENCE'}), 'WORKER_SLICE_MISMATCH'))

            def widened_slot():
                r = gate('G')['ok']
                expect(r['mode'] == 'SLICE' and r['slice_digest'] == digests['slice-g'] and r['materialisation_id'] == ids['g'], r)
            check('widen.widened-child-slice-runs', widened_slot)

            def summary():
                r = probe({'op': 'summary', 'organisation': org, 'run': run1, 'digest': digests['slice-a']})['ok']
                expect(r == {'worktree_bytes': 4096, 'disk_bytes': 8192, 'derivation_misses': 2, 'out_of_slice_writes': 1, 'widen_events': 1,
                             'widened_children': 1}, r)
            check('record.worktree-bytes-misses-widen-events', summary)

            manifest = {'mode': 'SLICE', 'included_paths': ['src/a.ts', 'tests/']}

            def widen_rules():
                findings = [
                    {'access': 'READ', 'path': 'src/b.ts', 'source': 'LAZY_FETCH', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': 'src/b.ts', 'source': 'ACCESS_MONITOR', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': 'pkg/fixtures/case/one.json', 'source': 'ACCESS_MONITOR', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': 'pkg/fixtures/two.json', 'source': 'LAZY_FETCH', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': 'lib/package.json', 'source': 'ACCESS_MONITOR', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': 'tools/codegen.py', 'source': 'DECLARED_REQUIREMENT', 'reason': 'BUILD_ROOT_EXCLUDED'},
                    {'access': 'READ', 'path': 'tests/unit/x.py', 'source': 'ACCESS_MONITOR', 'reason': 'OUT_OF_SLICE_READ'},
                    {'access': 'READ', 'path': None, 'source': 'ACCESS_MONITOR_UNAVAILABLE', 'reason': 'ACCESS_MONITOR_UNAVAILABLE'},
                    {'access': 'WRITE', 'path': 'docs/out.md', 'source': 'WORKTREE_STATUS', 'reason': 'OUT_OF_SLICE_WRITE'},
                ]
                r = probe({'op': 'widen', 'manifest': manifest, 'findings': findings})['ok']
                expect(r['requests'] == [{'reason': 'BUILD_ROOT_EXCLUDED', 'paths': ['lib/package.json', 'tools/codegen.py']},
                                         {'reason': 'FIXTURE_DIRECTORY_READ', 'paths': ['pkg/fixtures/']},
                                         {'reason': 'OUT_OF_SLICE_READ', 'paths': ['src/b.ts']}], r)
                expect(r['refused'] == [{'path': 'docs/out.md', 'reason': 'OUT_OF_SLICE_WRITE'}] and r['fallback_reason'] is None, r)
            check('widen.rules-group-misses-by-class', widen_rules)

            def widen_fallbacks():
                r = probe({'op': 'widen', 'manifest': manifest, 'findings': [
                    {'access': 'READ', 'path': 'git-object:' + 'f' * 40, 'source': 'LAZY_FETCH', 'reason': 'OUT_OF_SLICE_READ'}]})['ok']
                expect(r['fallback_reason'] == 'UNMAPPED_OBJECT_READ' and not r['requests'], r)
                many = [{'access': 'READ', 'path': 'src/m%d.ts' % n, 'source': 'LAZY_FETCH', 'reason': 'OUT_OF_SLICE_READ'} for n in range(5)]
                r = probe({'op': 'widen', 'manifest': manifest, 'findings': many, 'limit': 4})['ok']
                expect(r['fallback_reason'] == 'WIDEN_LIMIT_EXCEEDED' and not r['requests'], r)
                r = probe({'op': 'widen', 'manifest': manifest, 'findings': many[:4], 'limit': 4})['ok']
                expect(r['fallback_reason'] is None and len(r['requests'][0]['paths']) == 4, r)
                r = probe({'op': 'widen', 'manifest': {'mode': 'FULL_TREE', 'included_paths': []}, 'findings': many})['ok']
                expect(r == {'requests': [], 'refused': [], 'fallback_reason': None}, r)
            check('widen.unmappable-and-limit-fall-back-to-full-tree', widen_fallbacks)

            def describe():
                r = probe({'op': 'describe'})['ok']
                expect(r['worker_default'] == 'SLICE_UNLESS_FULL_TREE_REASON_RECORDED', r)
            check('describe.worker-default', describe)

            def claim_wired():
                text = (SERVICE / 'src/runner/executor.ts').read_text()
                body = text[text.index('async function claim('):text.index('async function execute(')]
                gate_at, claimed_at = body.find('workerWorkspaceGate('), body.find("SET state='CLAIMED'")
                expect(0 <= gate_at < claimed_at, 'claim() does not gate the worker workspace before CLAIMED')
                settle = re.search(r"if\(!/\^\(([^)]*)\)/\.test\(code\)\)throw error;", body)
                expect(settle and 'WORKER_SLICE_' in settle.group(1) and 'WORKER_WORKSPACE_' in settle.group(1), 'slice refusals are not settled as UNKNOWN')
                expect("workspaces:{...workspaces,policy:'SLICE_UNLESS_FULL_TREE_REASON_RECORDED'}" in text, 'executor describe lacks workspace counters')
            check('executor.claim-gates-before-launch', claim_wired)
        finally:
            cluster.close()
    print(json.dumps({'type': 'summary', 'failed': FAILED}))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
