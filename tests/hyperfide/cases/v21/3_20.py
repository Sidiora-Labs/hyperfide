#!/usr/bin/env python3
"""hyperfide-v21 3.20: sparse by default, and the slice gate on every launch.

Local fleet: a worker begun in a throwaway project with no [hierarchy] sparse setting gets a sparse worktree cut from
its slice, and `cg slice --widen` checks a file out and records the widening in the worker's task packet.

Service: the source is compiled into a temporary tree and migrated onto an owned throwaway PostgreSQL cluster (pattern
of v21/2_12.py; never a shared database). Slice rows are seeded with FK triggers suspended. A TEST job and an agent
launch on an empty slot are refused unless a full-tree reason is recorded, admission writes the slot's slice into the
packet, and a job launches in the slot's slice workspace path.

Sealed slice: the closure's metadata roots include every ancestor .gitignore; a blobless partial clone checked out
with exactly that slice and sealed from its remote runs git status (it fails without the ancestor .gitignore files) and
the native checkpoint.snapshot captures it."""
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
SERVICE = ROOT / 'core/control-plane'
CG = Path(os.environ.get('CG', ROOT / 'cg'))
NATIVE = ROOT / 'build/hyperfide-native'
SUPERUSER = 'hf_superuser'
FAILED = []

PROBE = r"""
import fs from 'node:fs';
import {createHash} from 'node:crypto';
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
    const pin=m.pin??i.pin;
    const body={schema_version:1,kind:'hyperfide.workspace-slice',packet_digest:pin,repository_id:i.repository,commit:'a'.repeat(40),
     graph_manifest_id:m.mode==='SLICE'?i.graph:null,graph_manifest_digest:m.mode==='SLICE'?pin:null,mode:m.mode,fallback_reason:m.reason??null,
     included_paths:m.paths??[],excluded_roots:[],build_roots:[],metadata_roots:[],submodules:[],lfs_paths:[],
     closure:{complete:m.mode==='SLICE',seeds:1,files:1,edges:0,unresolved:0,truncated:false,tests:0,fixtures:0},diagnostics:[],
     input_roots:{contracts:[],registries:[]},budget:{files:100000,edges:4000000},slot:m.slot,parent_slice_digest:null,widening:null};
    const text=canonicalJSON(body),digest=sha(text);digests[m.name]=digest;
    await c.query('INSERT INTO hyperfide.workspace_slice_manifests(organisation_id,run_id,digest,derivation_key,packet_digest,repository_id,commit,graph_manifest_id,graph_manifest_digest,mode,fallback_reason,parent_slice_digest,manifest,manifest_text,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
     [i.organisation,m.run,digest,sha(m.name),pin,i.repository,body.commit,body.graph_manifest_id,body.graph_manifest_digest,m.mode,body.fallback_reason,null,JSON.stringify({...body,digest}),text,i.credential]);
   }
   for(const x of i.materialisations){
    const evidence={schema_version:1,metrics:{worktree_bytes:0,disk_bytes:0}};
    await c.query('INSERT INTO hyperfide.workspace_slice_materialisations(organisation_id,run_id,id,slice_digest,sandbox_id,slot_id,sandbox_boot_generation,outcome,reason,released_materialisation_id,verified_head,evidence,evidence_digest,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,1,$7,NULL,NULL,$8,$9,$10,$11)',
     [i.organisation,x.run,x.id,digests[x.manifest],x.slot.sandbox_id,x.slot.slot_id,'READY','a'.repeat(40),JSON.stringify(evidence),sha(JSON.stringify(evidence)),i.credential]);
   }
   await c.query('COMMIT');
  }finally{await c.end();}
  out({ok:digests});
 }else if(i.op==='gate'){
  const executor=await import(dist+'/runner/executor.js'),c=await client();
  try{out({ok:await executor.workerWorkspaceGate(c,i.job)});}finally{await c.end();}
 }else if(i.op==='launch'){
  const c=await client();
  try{out({ok:await slices.resolveLaunchWorkspace(c,i.scope,i.slot,i.packet_digest)});}finally{await c.end();}
 }else if(i.op==='admit'){
  const bridge=await import(dist+'/runner/bridge.js'),c=await client();
  try{out({ok:await bridge.runnerAdmissionPacket(c,i.plan,i.binding,i.allocation,i.readiness)});}finally{await c.end();}
 }else if(i.op==='path'){
  const executor=await import(dist+'/runner/executor.js');
  out({ok:executor.launchWorkspacePath(i.env,i.row,i.workspace)});
 }else if(i.op==='closure'){
  const r=slices.sliceClosure({files:i.files,links:[],unresolved:[]},i.repository,i.owned,{contracts:[],registries:[]},{files:1000,edges:1000});
  out({ok:{included:r.included,metadata:r.metadata,fallback:r.fallback}});
 }
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


def run(argv, check_rc=True, **kw):
    p = subprocess.run([str(a) for a in argv], capture_output=True, text=True, timeout=900, **kw)
    if check_rc:
        expect(p.returncode == 0, ' '.join(map(str, argv)) + ': ' + (p.stderr + p.stdout)[-2000:])
    return p


def git(*args, cwd, env=None, check_rc=True):
    return run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', *args], cwd=cwd, env=env, check_rc=check_rc)


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    installed = sorted((p for p in Path('/usr/lib/postgresql').glob('*/bin') if (p / 'initdb').exists() and (p / 'postgres').exists()),
                       key=lambda p: int(p.parent.name))
    return installed[-1] if installed else None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory (pattern of v21/2_12.py)."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-3-20-', dir='/tmp/hyperfide'))
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
    service = base / 'core/control-plane'
    service.mkdir(parents=True)
    for name in ['package.json', 'tsconfig.json']:
        shutil.copyfile(SERVICE / name, service / name)
    shutil.copytree(SERVICE / 'src', service / 'src')
    shutil.copytree(SERVICE / 'migrations', service / 'migrations')
    (service / 'node_modules').symlink_to((SERVICE / 'node_modules').resolve(), target_is_directory=True)
    run([service / 'node_modules/.bin/tsc', '-p', 'tsconfig.json'], cwd=service)
    (service / 'probe.mjs').write_text(PROBE)
    return service


# ---------------------------------------------------------------------------------------------------- local fleet
def fleet_scenario(tmp):
    proj = tmp / 'proj'
    (proj / 'src').mkdir(parents=True)
    (proj / 'docs').mkdir()
    (proj / 'src/b.ts').write_text('export const b = 1;\n')
    (proj / 'docs/d.md').write_text('# doc\n')
    env = {k: v for k, v in os.environ.items() if not k.startswith('CG_')}
    git('init', '-q', '-b', 'main', '.', cwd=proj)
    for argv in (['spec', 'new', 'alpha'], ['spec', 'docs', 'off'], ['spec', 'start', '1.1'], ['spec', 'done', '1.1'], ['spec', 'mode', 'parallel'],
                 ['spec', 'add', '2.1', '--title', 'X', '--wave', '1', '--reqs', '1.1', '--touches', 'src/b.ts'], ['init']):
        run([CG, *argv], cwd=proj, env=env)
    (proj / '.gitignore').write_text('.codegraph/\n*.lock\n')
    workflow = proj / 'spec/workflow.kvx'
    text = workflow.read_text()
    expect('sparse' not in text.split('[hierarchy]')[-1] if '[hierarchy]' in text else True, 'fixture workflow already names a sparse mode')
    workflow.write_text(text + '\n[hierarchy]\ntest_gate = "true"\npr = "manual"\n')
    git('add', '-A', cwd=proj)
    git('commit', '-qm', 'base', cwd=proj)
    state = {}

    def default_sparse():
        begun = json.loads(run([CG, 'fleet', 'begin', '2.1', '--json'], cwd=proj, env=env).stdout)
        wt = Path(begun['worktree'])
        state['wt'] = wt
        expect(begun['workspace']['mode'] == 'SLICE' and begun['workspace']['fallback_reason'] is None and
               str(begun['workspace']['slice_digest']).startswith('sha256:'), ('begin workspace', begun.get('workspace')))
        sparse = git('config', '--get', 'core.sparseCheckout', cwd=wt).stdout.strip()
        expect(sparse == 'true', ('core.sparseCheckout', sparse))
        expect((wt / 'src/b.ts').exists() and not (wt / 'docs/d.md').exists(), 'worker worktree is not cut to its slice')
    check('fleet.default-worker-is-sparse', default_sparse)

    def widen_recorded():
        wt = state['wt']
        wenv = dict(env, CG_AGENT='w-alpha-2.1', CG_ROLE='worker', CG_FEATURE='alpha', CG_WAVE='1')
        run([CG, 'spec', 'start', '2.1'], cwd=wt, env=wenv)
        r = json.loads(run([CG, 'slice', '2.1', '--widen', 'docs/d.md', '--reason', 'CONFLICT_UNDER_TEST', '--json'], cwd=wt, env=wenv).stdout)
        expect(r['reason'] == 'CONFLICT_UNDER_TEST' and r['added_paths'] == ['docs/d.md'] and r['slice_digest'] != r['parent_slice_digest'], r)
        expect((wt / 'docs/d.md').exists(), 'widened file was not checked out')
        packet = Path(r['recorded_in']).read_text()
        block = packet[packet.index('[task.2.1]'):]
        block = block[:block.index('\n[', 1)] if '\n[' in block[1:] else block
        expect('docs/d.md' in block and 'CONFLICT_UNDER_TEST:docs/d.md' in block, ('task packet does not record the widening', block[:800]))
        refused = run([CG, 'slice', '2.1', '--widen', 'docs/none.md', '--reason', 'lower'], cwd=wt, env=wenv, check_rc=False)
        expect(refused.returncode != 0, 'a widen without a reason code was accepted')
    check('fleet.widen-recorded-in-task-packet', widen_recorded)


# ---------------------------------------------------------------------------------------------------- sealed slice
def sealed_scenario(tmp, probe):
    src = tmp / 'sealed-src'
    (src / 'sub/dir').mkdir(parents=True)
    (src / 'other').mkdir()
    (src / '.gitignore').write_text('*.log\n')
    (src / 'sub/.gitignore').write_text('*.tmp\n')
    (src / '.gitattributes').write_text('* text=auto\n')
    (src / 'sub/dir/a.ts').write_text('export const a = 1;\n')
    (src / 'other/b.ts').write_text('export const b = 2;\n')
    git('init', '-q', '-b', 'main', '.', cwd=src)
    git('add', '-A', cwd=src)
    git('commit', '-qm', 'init', cwd=src)
    origin = tmp / 'origin.git'
    git('clone', '-q', '--bare', src, origin, cwd=tmp)
    git('config', 'uploadpack.allowFilter', 'true', cwd=origin)
    git('config', 'uploadpack.allowAnySHA1InWant', 'true', cwd=origin)
    repository = str(uuid.uuid4())
    state = {}

    def metadata_roots():
        r = probe({'op': 'closure', 'repository': repository, 'owned': ['sub/dir/a.ts'],
                   'files': [{'id': '1', 'path': 'sub/dir/a.ts', 'language': 'typescript', 'repository': repository},
                             {'id': '2', 'path': 'other/b.ts', 'language': 'typescript', 'repository': repository}]})['ok']
        for name in ['.gitignore', 'sub/.gitignore', 'sub/dir/.gitignore', '.gitattributes', 'sub/.gitattributes']:
            expect(name in r['metadata'] and name in r['included'], ('metadata root missing', name, r))
        expect('other/b.ts' not in r['included'] and r['fallback'] is None, r)
        state['included'] = r['included']
    check('slice.metadata-roots-include-ancestor-gitignore', metadata_roots)

    sealed_env = dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0')

    def materialise(name, patterns):
        allowed = tmp / ('allowed-' + name)
        allowed.mkdir()
        work = allowed / 'w'
        git('clone', '-q', '--no-checkout', '--filter=blob:none', '--sparse', 'file://' + str(origin), work, cwd=tmp)
        p = subprocess.run(['git', 'sparse-checkout', 'set', '--no-cone', '--stdin'], cwd=work, input='\n'.join(patterns) + '\n',
                           capture_output=True, text=True, timeout=300)
        expect(p.returncode == 0, p.stderr)
        git('checkout', '-q', 'main', cwd=work)
        # Sealed: the promisor remote is unreachable and lazy fetch is off, as in a slice workspace.
        git('config', 'remote.origin.url', 'file:///nonexistent/sealed', cwd=work)
        # An edit inside the slice, and a file only the ancestor sub/.gitignore ignores.
        (work / 'sub/dir/a.ts').write_text('export const a = 3;\n')
        (work / 'sub/dir/scratch.tmp').write_text('ignored\n')
        status = git('status', '--porcelain', '--untracked-files=all', '--ignored', cwd=work, env=sealed_env, check_rc=False)
        return allowed, work, status

    def sealed_status_and_snapshot():
        patterns = ['/' + p for p in state['included']]
        control = [p for p in patterns if not p.endswith('.gitignore')]
        _, _, without = materialise('control', control)
        expect(without.returncode != 0, ('git status succeeded without the ancestor .gitignore files; the control is not sealed', without.stdout))
        allowed, work, status = materialise('slice', patterns)
        expect(status.returncode == 0 and ' M sub/dir/a.ts' in status.stdout and '!! sub/dir/scratch.tmp' in status.stdout, ('sealed slice git status', status.returncode, status.stdout, status.stderr[-800:]))
        if not NATIVE.exists():
            run(['make', 'hyperfide-native'], cwd=ROOT)
        spool = tmp / 'spool'
        spool.mkdir(mode=0o700)
        os.chmod(spool, 0o700)
        head = git('rev-parse', 'HEAD', cwd=work).stdout.strip()
        request = {'candidate_path': 'w', 'organisation_id': str(uuid.uuid4()), 'run_id': str(uuid.uuid4()), 'repository_id': repository,
                   'task_id': str(uuid.uuid4()), 'attempt_id': str(uuid.uuid4()), 'base_commit': head, 'slice_digest': 'sha256:' + '7' * 64}
        nenv = dict(sealed_env, HF_CHECKPOINT_ALLOWED_ROOT=str(allowed), HF_CHECKPOINT_SPOOL_ROOT=str(spool))
        p = subprocess.run([str(NATIVE), '--component', '15.1', '--action', 'checkpoint.snapshot'], input=json.dumps(request), env=nenv,
                           capture_output=True, text=True, timeout=300)
        try:
            r = json.loads(p.stdout)
        except ValueError:
            r = {'raw': p.stdout[-800:], 'stderr': p.stderr[-800:]}
        expect(p.returncode == 0 and r.get('ok') is True and r['result'].get('slice_digest') == request['slice_digest'], ('checkpoint.snapshot', p.returncode, r))
        expect(r['result'].get('capture_state') != 'REFUSED', ('checkpoint.snapshot refused', r))
    check('slice.sealed-with-ancestor-gitignore-status-and-snapshot', sealed_status_and_snapshot)


# ---------------------------------------------------------------------------------------------------- service gate
def service_scenario(probe):
    r = probe({'op': 'migrate'})
    expect(r.get('ok') is True, ('migration', r))
    org, run1, cred, repo, graph = (str(uuid.uuid4()) for _ in range(5))
    pin, full_pin = 'sha256:' + '1' * 64, 'sha256:' + '2' * 64
    slot = {name: {'sandbox_id': str(uuid.uuid4()), 'slot_id': str(uuid.uuid4()), 'sandbox_boot_generation': '1'} for name in 'AC'}
    ids = {'a': str(uuid.uuid4())}
    seeded = probe({'op': 'seed', 'organisation': org, 'credential': cred, 'repository': repo, 'graph': graph, 'pin': pin,
                    'manifests': [{'name': 'slice-a', 'run': run1, 'mode': 'SLICE', 'slot': slot['A'], 'paths': ['src/a.ts']},
                                  {'name': 'full-p', 'run': run1, 'mode': 'FULL_TREE', 'reason': 'GRAPH_SOURCE_COVERAGE_INCOMPLETE', 'slot': slot['C'], 'pin': full_pin}],
                    'materialisations': [{'id': ids['a'], 'run': run1, 'manifest': 'slice-a', 'slot': slot['A']}]})
    expect('ok' in seeded, ('seed', seeded))
    digests = seeded['ok']
    scope = {'organisation_id': org, 'run_id': run1}

    def refused(result, code):
        expect(result.get('error') == code, ('expected ' + code, result))

    def gate(name, kind, workspace=None):
        request = {'argv': ['true']}
        if workspace is not None:
            request['workspace'] = workspace
        job = {'organisation_id': org, 'run_id': run1, 'job_class': 'WORKER', 'plan': {'request': request, 'allocation': dict(slot[name], job_kind=kind)}}
        return probe({'op': 'gate', 'job': job})

    def test_job():
        refused(gate('C', 'TEST'), 'WORKER_SLICE_REQUIRED')
        refused(gate('C', 'BUILD'), 'WORKER_SLICE_REQUIRED')
        r = gate('C', 'TEST', {'mode': 'FULL_TREE', 'fallback_reason': 'INDEPENDENT_VERIFICATION'})['ok']
        expect(r['source'] == 'DECLARED_FULL_TREE' and r['fallback_reason'] == 'INDEPENDENT_VERIFICATION', r)
        r = gate('A', 'TEST')['ok']
        expect(r['source'] == 'MATERIALISED_SLICE' and r['slice_digest'] == digests['slice-a'], r)
    check('service.test-job-without-slice-refused-unless-full-tree', test_job)

    def agent_launch():
        refused(probe({'op': 'launch', 'scope': scope, 'slot': slot['C'], 'packet_digest': pin}), 'WORKER_SLICE_REQUIRED')
        r = probe({'op': 'launch', 'scope': scope, 'slot': slot['C'], 'packet_digest': full_pin})['ok']
        expect(r['source'] == 'DECLARED_FULL_TREE' and r['fallback_reason'] == 'GRAPH_SOURCE_COVERAGE_INCOMPLETE', r)
        r = probe({'op': 'launch', 'scope': scope, 'slot': slot['A'], 'packet_digest': pin})['ok']
        expect(r['source'] == 'MATERIALISED_SLICE' and r['materialisation_id'] == ids['a'], r)
        refused(probe({'op': 'launch', 'scope': scope, 'slot': slot['A'], 'packet_digest': full_pin}), 'WORKER_SLICE_MISMATCH')
        refused(probe({'op': 'launch', 'scope': scope, 'slot': {'sandbox_id': 'x', 'slot_id': 'y', 'sandbox_boot_generation': '1'}, 'packet_digest': pin}),
                'WORKER_SLICE_SLOT_UNBOUND')
    check('service.agent-launch-without-slice-refused-unless-full-tree', agent_launch)

    def admission():
        plan = {'session_id': str(uuid.uuid4()), 'operation_id': str(uuid.uuid4()), 'repository_id': repo, 'reservation_id': str(uuid.uuid4()),
                'argv': ['/usr/bin/node', 'job.mjs'], 'cwd': '.', 'environment': {}, 'timeout_ms': 60000, 'source_digest': pin,
                'policy_digest': pin, 'executable_digest': pin, 'environment_digest': pin, 'artifact_paths': []}
        binding = {'organisation_id': org, 'run_id': run1, 'session_id': plan['session_id'], 'pool_id': str(uuid.uuid4())}
        readiness = {'source_state_digest': pin, 'workspace_digest': pin}

        def admit(name):
            allocation = {'allocation_id': str(uuid.uuid4()), 'job_kind': 'TEST', **slot[name]}
            r = probe({'op': 'admit', 'plan': plan, 'binding': binding, 'allocation': allocation, 'readiness': readiness})
            expect('ok' in r, r)
            return r['ok']['packet']['request']
        expect(admit('A').get('workspace') == {'mode': 'SLICE', 'slice_digest': digests['slice-a']}, 'admission did not write the slot slice')
        expect('workspace' not in admit('C'), 'admission invented a workspace for an empty slot')
    check('service.admission-writes-request-workspace', admission)

    def launch_path():
        row = {'plan': {'binding': {'workspace_path': '/srv/runner/workspace'}, 'allocation': slot['A']}}
        sliced = gate('A', 'AGENT')['ok']
        r = probe({'op': 'path', 'env': {'HF_PREPARATION_WORKSPACE_ROOT': '/srv/hf/slices'}, 'row': row, 'workspace': sliced})
        expect(r.get('ok') == '/srv/hf/slices/%s/%s/1/workspace' % (slot['A']['sandbox_id'], slot['A']['slot_id']), r)
        refused(probe({'op': 'path', 'env': {}, 'row': row, 'workspace': sliced}), 'WORKER_WORKSPACE_ROOT_UNSET')
        refused(probe({'op': 'path', 'env': {'HF_PREPARATION_WORKSPACE_ROOT': 'relative/root'}, 'row': row, 'workspace': sliced}), 'WORKER_WORKSPACE_ROOT_INVALID')
        declared = gate('C', 'TEST', {'mode': 'FULL_TREE', 'fallback_reason': 'INDEPENDENT_VERIFICATION'})['ok']
        r = probe({'op': 'path', 'env': {}, 'row': row, 'workspace': declared})
        expect(r.get('ok') == '/srv/runner/workspace', r)
    check('service.executor-launches-in-slice-workspace', launch_path)

    def wiring():
        executor = (SERVICE / 'src/runner/executor.ts').read_text()
        expect('VERIFICATION_JOB_KINDS' not in executor, 'executor still exempts verification kinds')
        body = executor[executor.index('async function execute('):]
        expect(body.index('workerWorkspaceGate(') < body.index('jobRequest(row,refs,cwd)'), 'execute() builds the launch before resolving the workspace')
        dispatch = (SERVICE / 'src/runner/dispatch.ts').read_text()
        expect(dispatch.index('resolveLaunchWorkspace(') < dispatch.index('await reader!('), 'agent launch is not gated before its plan is read')
        slices = (SERVICE / 'src/preparation/slices.ts').read_text()
        occupancy = slices[slices.index('async function currentMaterialisation('):]
        expect('m.run_id=$5' in occupancy[:800], 'slot occupancy is not checked by run')
    check('service.gate-wired-on-every-launch', wiring)


def main():
    for tool in ('node', 'git'):
        if shutil.which(tool) is None:
            print('SKIP: %s is required' % tool)
            return 77
    if not CG.exists():
        print('SKIP: cg is not built (make cg)')
        return 77
    if not (SERVICE / 'node_modules/.bin/tsc').exists():
        print('SKIP: core/control-plane/node_modules is not installed')
        return 77
    binaries = postgres_bin()
    if binaries is None:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
        return 77
    with tempfile.TemporaryDirectory(prefix='hf-v21-3-20-') as tmp:
        tmp = Path(tmp)
        fleet_scenario(tmp)
        service = build(tmp / 'build')
        dist = str(service / 'dist')
        cluster = Cluster(binaries)
        env = dict(os.environ, DATABASE_URL=cluster.url())
        try:
            def probe(payload):
                r = subprocess.run(['node', str(service / 'probe.mjs'), dist], cwd=service, env=env, input=json.dumps(payload),
                                   capture_output=True, text=True, timeout=300)
                expect(r.returncode == 0 and r.stdout, ('probe', payload.get('op'), r.stdout, r.stderr[-1500:]))
                return json.loads(r.stdout)
            sealed_scenario(tmp, probe)
            service_scenario(probe)
        finally:
            cluster.close()
    print(json.dumps({'type': 'summary', 'failed': FAILED}))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
