#!/usr/bin/env python3
"""hyperfide-v21 3.8: snapshots are the unit of record; agents never commit.

The native component is linked into a temporary build directory and the service source is compiled into a temporary
tree. Every trusted migration is applied to an owned throwaway PostgreSQL 16 cluster. A slice workspace is materialised
the way preparation/slices.ts does it (partial clone, no-cone sparse checkout, detached base); the agent edits files
without committing and captureSourceSnapshot records the result. Prerequisite rows (task, attempt, slice manifest,
repository, principal) are seeded with FK triggers suspended; the snapshot row itself is written with every constraint live.
"""
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
SUPERUSER = 'hf_superuser'
FAILED = []
GIT_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0',
           'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid', 'GIT_COMMITTER_NAME': 'Fixture',
           'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}

PROBE = r"""
import fs from 'node:fs';
import pg from 'pg';
const dist=process.argv[2],i=JSON.parse(fs.readFileSync(0,'utf8'));
const out=v=>process.stdout.write(JSON.stringify(v));
const submission=await import(dist+'/assurance/submission.js');
async function client(){const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();return c;}
try{
 if(i.op==='migrate'){
  const {createResourceContainer}=await import(dist+'/storage/runtime.js'),{MigrationCoordinator}=await import(dist+'/storage/durability.js');
  const signal=new AbortController().signal,r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});
  try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}
  out({ok:true});
 }else if(i.op==='seed'){
  const c=await client(),x=i;
  try{
   await c.query('BEGIN');await c.query("SET LOCAL session_replication_role=replica");
   await c.query("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,'3.8',$4,$5,$6,'{}',3)",[x.org,x.run,x.task,x.feature,x.revision,x.pin]);
   for(const g of [1,2])await c.query('INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest) VALUES($1,$2,$3,$4,$5,$6,$7)',[x.org,x.run,x.attempts[g-1],x.task,g,x.epoch,x.pin]);
   await c.query("INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES($1,$2,$3,$4,'refs/heads/trunk')",[x.org,x.run,x.repository,x.base]);
   await c.query('INSERT INTO hyperfide.workspace_slice_manifests(organisation_id,run_id,digest,derivation_key,packet_digest,repository_id,commit,graph_manifest_id,graph_manifest_digest,mode,fallback_reason,parent_slice_digest,manifest,manifest_text,created_by_credential_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,$11,$12,$13)',
    [x.org,x.run,x.slice,x.pin,x.pin,x.repository,x.base,x.graph,x.pin,'SLICE',JSON.stringify({included_paths:x.paths}),'{}',x.credential]);
   await c.query("INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,attempt_id,attempt_generation,allowed_actions,expires_at) VALUES($1,$2,$3,$4,'WORKER',$5,$6,$7,1,ARRAY['submission.snapshot'],clock_timestamp()+interval '1 hour')",
    [x.credential,x.org,x.run,x.actor,'A'.repeat(43),x.epoch,x.attempts[0]]);
   await c.query('COMMIT');
  }finally{await c.end();}
  out({ok:true});
 }else if(i.op==='capture'){
  const c=await client();
  try{out({ok:await submission.captureSourceSnapshot(c,i.native,i.request)});}finally{await c.end();}
 }else if(i.op==='rows'){
  const c=await client();
  try{out({ok:(await c.query('SELECT * FROM hyperfide.source_snapshots WHERE organisation_id=$1 AND run_id=$2 ORDER BY created_at',[i.org,i.run])).rows});}finally{await c.end();}
 }else if(i.op==='update'){
  const c=await client();
  try{await c.query("UPDATE hyperfide.source_snapshots SET result_tree=base_tree WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[i.org,i.run,i.id]);out({ok:'updated'});}finally{await c.end();}
 }else if(i.op==='bind'){
  const c=await client();
  try{out({ok:await submission.bindSubmittedSnapshot(c,[i.org,i.run],i.result,i.tree)});}finally{await c.end();}
 }else if(i.op==='actions')out({ok:Object.keys(submission.createComponent({}).actions)});
}catch(e){out({error:e.code??e.message,message:String(e.message).slice(0,400)});}
"""


def expect(value, message):
    if not value:
        raise AssertionError(str(message)[:1500])


def okay(result):
    expect('ok' in result, result)
    return result['ok']


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)[:1500]
    print(json.dumps(dict(type='assertion', id=name, expected='observed', actual=actual)), flush=True)


def run(argv, **kw):
    p = subprocess.run(argv, capture_output=True, timeout=900, **kw)
    expect(p.returncode == 0, ' '.join(map(str, argv)) + ': ' + (p.stderr + p.stdout)[-2000:].decode('utf8', 'replace'))
    return p.stdout


def git(repo, *args, data=None):
    return run(['git', '-c', 'protocol.file.allow=always', '-c', 'advice.detachedHead=false', '-C', str(repo), *args],
               env=GIT_ENV, input=data).decode().strip()


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
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-3-8-', dir='/tmp/hyperfide'))
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
    # The native generator only writes beneath its own root, so the component build runs in a source copy.
    tree = base / 'native-src'
    (tree / 'tools/repository').mkdir(parents=True)
    shutil.copyfile(ROOT / 'Makefile', tree / 'Makefile')
    shutil.copyfile(ROOT / 'tools/repository/hyperfide-native-components.py', tree / 'tools/repository/hyperfide-native-components.py')
    shutil.copytree(ROOT / 'core/native/src', tree / 'core/native/src')
    run(['make', '-s', 'hyperfide-native'], cwd=tree)
    service = base / 'core/control-plane'
    service.mkdir(parents=True)
    for name in ['package.json', 'tsconfig.json']:
        shutil.copyfile(SERVICE / name, service / name)
    shutil.copytree(SERVICE / 'src', service / 'src')
    shutil.copytree(SERVICE / 'migrations', service / 'migrations')
    (service / 'node_modules').symlink_to((SERVICE / 'node_modules').resolve(), target_is_directory=True)
    run([str(service / 'node_modules/.bin/tsc'), '-p', 'tsconfig.json'], cwd=service)
    (service / 'probe.mjs').write_text(PROBE)
    return service, tree / 'build/hyperfide-native'


def slice_workspace(origin, target, base, patterns):
    """The materialisation commands of preparation/slices.ts: partial clone, no-cone sparse checkout, detached base, sealed promisor."""
    run(['git', '-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--no-tags', '--filter=blob:none', '--sparse', '--',
         'file://' + str(origin), str(target)], env=GIT_ENV)
    git(target, 'sparse-checkout', 'set', '--no-cone', '--stdin', data=('\n'.join(patterns) + '\n').encode())
    git(target, 'checkout', '-q', '--detach', base)
    git(target, 'config', 'remote.origin.url', 'file:///nonexistent/hyperfide-slice-promisor-sealed')


def state(repo):
    """Everything a commit, ref move or index write by the capture would change."""
    gitdir = Path(repo) / '.git'
    logs = sorted(str(p.relative_to(gitdir)) + ':' + hashlib.sha256(p.read_bytes()).hexdigest() for p in (gitdir / 'logs').rglob('*') if p.is_file())
    return {'head': git(repo, 'rev-parse', 'HEAD'), 'refs': git(repo, 'for-each-ref', '--format=%(objectname) %(refname)'),
            'commits': git(repo, 'rev-list', '--all', '--count'), 'index': hashlib.sha256((gitdir / 'index').read_bytes()).hexdigest(),
            'logs': logs, 'status': git(repo, 'status', '--porcelain=v1', '--untracked-files=all')}


def main():
    for tool in ['node', 'git', 'make', 'cc']:
        if shutil.which(tool) is None:
            print('SKIP: ' + tool + ' is required')
            return 77
    if not (SERVICE / 'node_modules/.bin/tsc').exists():
        print('SKIP: core/control-plane/node_modules is not installed')
        return 77
    binaries = postgres_bin()
    if binaries is None:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
        return 77
    with tempfile.TemporaryDirectory(prefix='hf-v21-3-8-') as tmp:
        base_dir = Path(tmp)
        service, native_binary = build(base_dir)
        dist = str(service / 'dist')
        allowed, spool = base_dir / 'allowed', base_dir / 'spool'
        allowed.mkdir()
        spool.mkdir(mode=0o700)
        native = {'binary': str(native_binary), 'allowed_root': str(allowed), 'spool_root': str(spool)}

        origin = base_dir / 'origin'
        origin.mkdir()
        git(origin, 'init', '-q', '-b', 'trunk')
        git(origin, 'config', 'uploadpack.allowFilter', 'true')
        (origin / 'src/a').mkdir(parents=True)
        (origin / 'src/b').mkdir(parents=True)
        (origin / 'src/a/edit.txt').write_text('one\ntwo\nthree\n')
        (origin / 'src/a/remove.txt').write_text('gone\nsoon\n')
        (origin / 'src/a/image.bin').write_bytes(bytes(range(256)))
        (origin / 'src/b/other.txt').write_text('outside the slice\n')
        (origin / 'README').write_text('root file outside the slice\n')
        (origin / '.gitignore').write_text('*.log\n')
        git(origin, 'add', '.')
        git(origin, 'commit', '-q', '-m', 'base')
        base = git(origin, 'rev-parse', 'HEAD')
        base_tree = git(origin, 'rev-parse', 'HEAD^{tree}')
        # Ignore rules are checkout metadata: capture must honour them without fetching out-of-slice blobs.
        patterns = ['/src/a/', '/.gitignore']

        ws = allowed / 'ws'
        slice_workspace(origin, ws, base, patterns)
        before = state(ws)

        def agent_edits(root):
            (root / 'src/a/edit.txt').write_text('one\nTWO\nthree\nfour\n')
            (root / 'src/a/remove.txt').unlink()
            (root / 'src/a/new.txt').write_text('added\nlines\n')
            (root / 'src/a/image.bin').write_bytes(bytes(range(255, -1, -1)))
            (root / 'src/a/scratch.log').write_text('ignored output\n')
        agent_edits(ws)
        edited = state(ws)

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
            ids = {k: str(uuid.uuid4()) for k in ['org', 'run', 'task', 'feature', 'revision', 'epoch', 'repository', 'graph', 'credential', 'actor']}
            attempts = [str(uuid.uuid4()), str(uuid.uuid4())]
            slice_digest = 'sha256:' + hashlib.sha256(b'slice-3.8').hexdigest()
            seeded = probe({'op': 'seed', **ids, 'attempts': attempts, 'base': base, 'slice': slice_digest, 'paths': patterns,
                            'pin': 'sha256:' + '1' * 64})
            expect(seeded.get('ok') is True, ('seed', seeded))
            request = {'organisation_id': ids['org'], 'run_id': ids['run'], 'task_id': ids['task'], 'attempt_id': attempts[0],
                       'attempt_generation': '1', 'repository_id': ids['repository'], 'slice_digest': slice_digest,
                       'candidate_path': 'ws', 'credential_id': ids['credential']}
            first = probe({'op': 'capture', 'native': native, 'request': request})
            expect('ok' in first, ('capture', first))
            snap = first['ok']
            rows = probe({'op': 'rows', 'org': ids['org'], 'run': ids['run']})['ok']

            # The independent expectation: a full clone given the same edits, staged and written as a tree.
            full = base_dir / 'full'
            run(['git', 'clone', '-q', str(origin), str(full)], env=GIT_ENV)
            agent_edits(full)
            git(full, 'add', '-A')
            expected_tree = git(full, 'write-tree')

            def row_recorded():
                expect(len(rows) == 1, rows)
                row = rows[0]
                expect(row['id'] == snap['snapshot_id'] and snap['replayed'] is False, (row, snap))
                expect(row['task_id'] == ids['task'] and row['attempt_id'] == attempts[0] and str(row['attempt_generation']) == '1', row)
                expect(row['repository_id'] == ids['repository'] and row['slice_digest'] == slice_digest, row)
                expect(row['base_commit'] == base and row['base_tree'] == base_tree, row)
                expect(row['created_by_credential_id'] == ids['credential'], row)
            check('row.task-attempt-base-slice-recorded', row_recorded)

            def diff_statistics():
                row = rows[0]
                # edit.txt +2/-1, remove.txt -2, new.txt +2, image.bin binary.
                expect({k: int(row[k]) for k in ['files_changed', 'insertions', 'deletions', 'binary_files']} ==
                       {'files_changed': 4, 'insertions': 4, 'deletions': 3, 'binary_files': 1}, row)
                numstat = git(full, 'diff', '--cached', '--numstat', 'HEAD')
                expect(len(numstat.splitlines()) == 4, numstat)
            check('row.diff-statistics', diff_statistics)

            def tree_identity():
                row = rows[0]
                expect(row['result_tree'] == expected_tree, (row['result_tree'], expected_tree))
                expect(git(ws, 'cat-file', '-t', row['result_tree']) == 'tree', 'result tree is not an object in the workspace store')
                listing = git(ws, 'ls-tree', '-r', '--name-only', row['result_tree']).splitlines()
                expect('src/b/other.txt' in listing and 'README' in listing, ('skip-worktree paths dropped', listing))
                expect('src/a/remove.txt' not in listing and 'src/a/new.txt' in listing and 'src/a/scratch.log' not in listing, listing)
            check('tree.identity-matches-full-tree-staging', tree_identity)

            def checkpoint_receipt():
                row = rows[0]
                receipt = row['checkpoint_receipt']
                capsule = spool / (row['checkpoint_digest'][7:] + '.hfs')
                data = capsule.read_bytes()
                expect('sha256:' + hashlib.sha256(data).hexdigest() == row['checkpoint_digest'] == receipt['checkpoint_digest'], receipt)
                expect(receipt['format'] == 'HFSN0001' and receipt['authority'] == 'NONE' and receipt['size_bytes'] == str(len(data)), receipt)
                expect(data[:8] == b'HFSN0001', 'capsule magic')
                meta_n, pack_n = struct.unpack('>QQ', data[8:24])
                meta = json.loads(data[24:24 + meta_n])
                expect(meta['result_tree_id'] == row['result_tree'] and meta['base_commit'] == base and meta['task_id'] == ids['task'], meta)
                expect('sha256:' + hashlib.sha256(data[24:24 + meta_n]).hexdigest() == receipt['metadata_digest'], receipt)
                # The checkpoint restores the result over a store that holds only the base.
                restore = base_dir / 'restore'
                run(['git', 'clone', '-q', '--bare', str(origin), str(restore)], env=GIT_ENV)
                run(['git', '-C', str(restore), 'unpack-objects', '-q'], env=GIT_ENV, input=data[24 + meta_n:24 + meta_n + pack_n])
                expect(24 + meta_n + pack_n == len(data), 'capsule length')
                expect(git(restore, 'rev-parse', row['result_tree'] + ':src/a/new.txt') == git(full, 'rev-parse', ':src/a/new.txt'), 'restored blob')
                run(['git', '-C', str(restore), 'ls-tree', '-r', row['result_tree']], env=GIT_ENV)
            check('checkpoint.receipt-and-restorable-pack', checkpoint_receipt)

            def no_commits():
                after = state(ws)
                expect(after == edited, ('capture changed the workspace', edited, after))
                expect(after['head'] == before['head'] == base and after['refs'] == before['refs'], 'HEAD or refs moved')
                expect(after['commits'] == before['commits'] and after['logs'] == before['logs'], 'a commit or reflog entry was written')
            check('workspace.has-no-commits', no_commits)

            def replay():
                again = probe({'op': 'capture', 'native': native, 'request': request})['ok']
                expect(again['snapshot_id'] == snap['snapshot_id'] and again['replayed'] is True, again)
                expect(len(probe({'op': 'rows', 'org': ids['org'], 'run': ids['run']})['ok']) == 1, 'replay wrote a second row')
            check('capture.replay-same-row', replay)

            def immutable():
                r = probe({'op': 'update', 'org': ids['org'], 'run': ids['run'], 'id': snap['snapshot_id']})
                expect('error' in r, ('snapshot row was mutable', r))
            check('row.immutable', immutable)

            def refused(payload, code, detail=None):
                r = probe({'op': 'capture', 'native': native, 'request': payload})
                expect(r.get('error') == code and (detail is None or detail in r.get('message', '')), (code, detail, r))

            check('binding.unknown-slice-refused',
                  lambda: refused(dict(request, slice_digest='sha256:' + '9' * 64), 'SOURCE_SNAPSHOT_SLICE_UNKNOWN'))
            check('binding.wrong-attempt-generation-refused',
                  lambda: refused(dict(request, attempt_generation='2'), 'SOURCE_SNAPSHOT_ATTEMPT_UNKNOWN'))
            check('binding.path-escape-refused', lambda: refused(dict(request, candidate_path='../ws'), 'QUALIFICATION_INPUT_INVALID'))

            ws2 = allowed / 'ws2'
            slice_workspace(origin, ws2, base, patterns)
            other = dict(request, attempt_id=attempts[1], attempt_generation='2', candidate_path='ws2')

            def out_of_slice():
                (ws2 / 'src/b').mkdir(parents=True)
                (ws2 / 'src/b/stray.txt').write_text('written outside the slice\n')
                refused(other, 'SOURCE_SNAPSHOT_REFUSED', 'OUT_OF_SLICE_WRITE')
                shutil.rmtree(ws2 / 'src/b')
            check('native.out-of-slice-write-refused', out_of_slice)

            def sensitive():
                (ws2 / 'src/a/.env').write_text('TOKEN=canary\n')
                refused(other, 'SOURCE_SNAPSHOT_REFUSED', 'SENSITIVE_PATH')
                (ws2 / 'src/a/.env').unlink()
            check('native.sensitive-path-refused', sensitive)

            def committed():
                (ws2 / 'src/a/edit.txt').write_text('committed by an agent\n')
                git(ws2, 'commit', '-q', '-am', 'agent commit')
                refused(other, 'SOURCE_SNAPSHOT_REFUSED', 'WORKER_COMMITTED')
            check('native.agent-commit-refused', committed)
            check('rows.refusals-record-nothing',
                  lambda: expect(len(probe({'op': 'rows', 'org': ids['org'], 'run': ids['run']})['ok']) == 1, 'a refused capture wrote a row'))

            unchanged = allowed / 'ws3'
            slice_workspace(origin, unchanged, base, patterns)

            def empty_snapshot():
                r = okay(probe({'op': 'capture', 'native': native, 'request': dict(other, candidate_path='ws3')}))
                expect(r['result_tree'] == r['base_tree'] == base_tree and r['files_changed'] == 0, r)
            check('capture.unchanged-tree-is-base-tree', empty_snapshot)

            result = {'task_id': ids['task'], 'attempt_id': attempts[0], 'attempt_generation': '1', 'repository_id': ids['repository'],
                      'snapshot_id': snap['snapshot_id']}

            def bind():
                r = okay(probe({'op': 'bind', 'org': ids['org'], 'run': ids['run'], 'result': result, 'tree': expected_tree}))
                expect(r['snapshot_id'] == snap['snapshot_id'] and r['snapshot_tree_id'] == expected_tree and r['snapshot_slice_digest'] == slice_digest, r)
                for bad, tree in [(result, base_tree), (dict(result, attempt_id=attempts[1]), expected_tree),
                                  (dict(result, snapshot_id=str(uuid.uuid4())), expected_tree)]:
                    r = probe({'op': 'bind', 'org': ids['org'], 'run': ids['run'], 'result': bad, 'tree': tree})
                    expect(r.get('error') == 'QUALIFICATION_SNAPSHOT_MISMATCH', r)
            check('result.carries-snapshot-of-its-attempt', bind)

            def wired():
                actions = probe({'op': 'actions'})['ok']
                expect('submission.snapshot' in actions, actions)
                text = (SERVICE / 'src/assurance/submission.ts').read_text()
                body = text[text.index('async function submit('):text.index('async function revoke(')]
                expect("['snapshot_id']" in body, 'submit does not accept a snapshot id')
                bound, admitted = body.find('bindSubmittedSnapshot('), body.find('INSERT INTO hyperfide.submission_custodies')
                expect(0 <= bound < admitted and '...snapshot' in body, 'submit does not bind the snapshot before admitting custody')
                component = json.loads((SERVICE / 'components/16.1.json').read_text())
                expect('submission.snapshot' in component['actions'], component)
                native_kvx = (ROOT / 'core/native/src/hyperfide/components/15.1.kvx').read_text()
                expect(re.search(r'actions = \[[^]]*"checkpoint\.snapshot"', native_kvx), native_kvx)
            check('wiring.worker-result-and-actions', wired)
        finally:
            cluster.close()
    print(json.dumps({'type': 'summary', 'failed': FAILED}))
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
