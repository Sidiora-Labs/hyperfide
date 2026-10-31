#!/usr/bin/env python3
"""hyperfide-v21 5.5: publication per wave.

A local bare repository stands in for the protected origin (nothing is pushed anywhere else); its pre-receive hook logs
every ref update it receives. The integrator store is a bare clone. Six agent snapshots for five tasks are folded onto
the internal trunk by the real 4.8 queue (runQueue), then wave 4 (four tasks, one of them with two snapshots) and wave 5
(one task, folded on the trunk between wave-4 tasks) are published through the operator entry of
integration/publication.ts behind the per-wave release barrier. The case asserts: the barrier holds (closure pending,
unfolded snapshot, snapshot under the wrong task, wave out of order) without touching the origin; the publisher refuses
without the gateway role, refuses a remote URL, and reports a hook rejection; one squashed commit per task in barrier
order with feature, wave, task, snapshot, trunk and barrier trailers; one ref update per wave; an idempotent replay;
trees equal to an independent replay of the edits. Retention (artifacts/retention.ts) then reads the publication dates
from the origin and prunes agent snapshot capsules N days after publication, keeping adoptable checkpoints, unpublished
snapshots and snapshots still inside the window; N comes from control.example.json and has no code default.
"""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
DIST = SERVICE / 'dist'
FAILED = []
FEATURE = 'hyperfide-v21'
TARGET = 'refs/heads/main'
GIT_ENV = {'PATH': '/usr/bin:/bin:/usr/local/bin', 'LANG': 'C', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid',
           'GIT_COMMITTER_NAME': 'Fixture', 'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
DRIVER = r"""
import fs from 'node:fs';
const request=JSON.parse(fs.readFileSync(0,'utf8')),dist=request.dist;
const out=v=>process.stdout.write(JSON.stringify(v));
if(request.op==='fold'){
 const {runQueue}=await import(dist+'/integration/queue.js');
 out(await runQueue(request.request,{requalify:async()=>({outcome:'PASS',receipt_digest:'sha256:'+'0'.repeat(64)})}));
}else if(request.op==='policy'){
 const {validatePolicy}=await import(dist+'/policy/programme.js');
 const policy=validatePolicy(JSON.parse(fs.readFileSync(request.file,'utf8')),request.revision,'control');
 out({publication:policy.publication??null});
}
"""


def expect(value, message):
    if not value:
        raise AssertionError(str(message)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)[:1500]
        FAILED.append(name)
    print(json.dumps({'type': 'assertion', 'id': 'publication.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def git(repo, *args, data=None, env=None):
    p = subprocess.run(['git', '-C', str(repo), *args], env=dict(GIT_ENV, **(env or {})), input=data, capture_output=True, timeout=120)
    expect(p.returncode == 0, 'git ' + ' '.join(args) + ': ' + p.stderr.decode('utf8', 'replace')[-800:])
    return p.stdout.decode().strip()


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def utc(delta_days):
    t = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0) - datetime.timedelta(days=delta_days)
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def iso_ms(text):
    return datetime.datetime.strptime(text, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)


class Fixture:
    def __init__(self, root):
        self.root = root
        self.origin = root / 'origin.git'
        self.repo = root / 'integrator.git'
        self.checkpoints = root / 'checkpoints'
        self.hook_log = root / 'origin-hook.log'
        self.reject_flag = root / 'reject'
        self.run = str(uuid.uuid4())
        self.trunk = 'refs/hyperfide/trunk/' + self.run
        self.checkpoints.mkdir()

    def node(self, payload):
        p = subprocess.run(['node', '--input-type=module', '-e', DRIVER], input=json.dumps(dict(payload, dist=str(DIST))), text=True,
                           capture_output=True, timeout=300, cwd=ROOT)
        expect(p.returncode == 0, 'driver failed: ' + p.stderr[-1500:])
        return json.loads(p.stdout)

    def cli(self, module, flag, request, env=None):
        path = self.root / ('request-%s.json' % uuid.uuid4().hex[:8])
        path.write_text(json.dumps(request))
        full_env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': '/nonexistent'}
        full_env.update(env or {})
        p = subprocess.run(['node', str(DIST / module), flag, str(path)], capture_output=True, text=True, timeout=300, cwd=ROOT, env=full_env)
        lines = [x for x in p.stdout.splitlines() if x.startswith('{')]
        expect(lines, 'no JSON from ' + module + ': ' + (p.stdout + p.stderr)[-1500:])
        return p.returncode, json.loads(lines[-1])

    def tree_with(self, base_commit, files):
        """A tree over base_commit with files written, built in the integrator store through a private index."""
        index = self.root / ('index-%s' % uuid.uuid4().hex[:8])
        env = {'GIT_INDEX_FILE': str(index)}
        git(self.repo, 'read-tree', base_commit, env=env)
        for name, body in files.items():
            blob = git(self.repo, 'hash-object', '-w', '--stdin', data=body.encode())
            git(self.repo, 'update-index', '--add', '--cacheinfo', '100644,%s,%s' % (blob, name), env=env)
        tree = git(self.repo, 'write-tree', env=env)
        index.unlink()
        return tree


def build(f):
    git(f.root, 'init', '-q', '--bare', '-b', 'main', str(f.origin))
    work = f.root / 'seed'
    git(f.root, 'init', '-q', '-b', 'main', str(work))
    for name in ['A', 'B', 'C', 'D', 'E']:
        (work / 'src').mkdir(exist_ok=True)
        (work / 'src' / (name + '.txt')).write_text('base %s\n' % name)
    (work / 'README').write_text('fixture\n')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'base')
    git(work, 'push', '-q', str(f.origin), 'main:main')
    # The protected origin: its server-side hook logs every update and refuses while the flag file exists.
    hook = f.origin / 'hooks' / 'pre-receive'
    hook.write_text('#!/bin/sh\nif [ -e %s ]; then echo protected-refusal >&2; exit 1; fi\ncat >> %s\n' % (f.reject_flag, f.hook_log))
    hook.chmod(0o755)
    subprocess.run(['git', 'clone', '-q', '--bare', str(f.origin), str(f.repo)], env=GIT_ENV, check=True, capture_output=True)
    f.base = git(f.origin, 'rev-parse', TARGET)
    f.base_tree = git(f.origin, 'rev-parse', TARGET + '^{tree}')


EDITS = {
    'A1': {'src/A.txt': 'task A\n'},
    'B1': {'src/B.txt': 'b one\n'},
    'C1': {'src/C.txt': 'task C\n', 'docs/c.md': 'C notes\n'},
    'E1': {'src/E.txt': 'task E\n'},
    'D1': {'src/D.txt': 'task D\n'},
    'B2': {'src/B.txt': 'b two\n', 'src/B2.txt': 'b rework\n'},
}
TASK_OF = {'A1': 'A', 'B1': 'B', 'B2': 'B', 'C1': 'C', 'D1': 'D', 'E1': 'E'}
KEYS = {'A': '4.1', 'B': '4.2', 'C': '4.3', 'D': '4.4', 'E': '5.1'}


def snapshot(f, name, base_commit):
    tree = f.tree_with(base_commit, EDITS[name])
    meta = json.dumps({'format': 'HFSN0001', 'result_tree_id': tree, 'base_commit': base_commit, 'snapshot': name}).encode()
    capsule = b'HFSN0001' + len(meta).to_bytes(8, 'big') + (0).to_bytes(8, 'big') + meta
    digest = sha(capsule)
    (f.checkpoints / (digest[7:] + '.hfs')).write_bytes(capsule)
    f.snap[name] = {'id': f.ids[name], 'tree': tree, 'base': base_commit, 'checkpoint': digest}


def fold(f, names):
    entries = []
    for n in names:
        s = f.snap[n]
        entries.append({'custody_id': str(uuid.uuid4()), 'task_id': f.task[TASK_OF[n]], 'task_key': KEYS[TASK_OF[n]], 'snapshot_id': s['id'],
                        'base_commit': s['base'], 'base_tree': git(f.repo, 'rev-parse', s['base'] + '^{tree}'), 'result_tree': s['tree'],
                        'checkpoint_digest': s['checkpoint']})
    report = f.node({'op': 'fold', 'request': {'repository_path': str(f.repo), 'trunk_ref': f.trunk, 'run_base': f.base, 'entries': entries,
                                                'checkpoint_root': str(f.checkpoints)}})
    expect(not report['rejected'] and not report['conflicts'] and len(report['folded']) == len(names), report)
    for x in report['folded']:
        f.fold_commit[x['snapshot_id']] = x['commit']
    return report


def barrier(f, wave, previous, tasks, release, closure='PASS'):
    return {'version': 1, 'feature': FEATURE, 'wave': wave, 'previous_wave': previous, 'run_base': f.base, 'trunk_ref': f.trunk,
            'target_ref': TARGET, 'release_time': release,
            'closure': {'outcome': closure, 'receipt_digest': sha(('closure %d' % wave).encode()) if closure == 'PASS' else None},
            'tasks': [{'task_id': f.task[t], 'task_key': KEYS[t], 'title': 'Task ' + t, 'snapshot_ids': [f.ids[s] for s in snaps]}
                      for t, snaps in tasks]}


def scenario(f):
    f.snap, f.fold_commit = {}, {}
    f.ids = {n: str(uuid.uuid4()) for n in EDITS}
    f.task = {t: str(uuid.uuid4()) for t in KEYS}
    for n in ['A1', 'B1', 'C1', 'E1', 'D1']:
        snapshot(f, n, f.base)
    gateway = {'HYPERFIDE_INTEGRATION_ROLE': 'PUBLICATION_GATEWAY'}
    origin_head = lambda: git(f.origin, 'rev-parse', TARGET)
    hook_lines = lambda: [x for x in f.hook_log.read_text().splitlines() if x] if f.hook_log.exists() else []
    request = lambda b: {'repository_path': str(f.repo), 'origin_path': str(f.origin), 'barrier': b}
    release4, release5 = utc(40), utc(2)
    wave4_tasks = [('C', ['C1']), ('A', ['A1']), ('D', ['D1']), ('B', ['B1', 'B2'])]
    wave4 = barrier(f, 4, None, wave4_tasks, release4)
    wave5 = barrier(f, 5, 4, [('E', ['E1'])], release5)

    def first_fold():
        fold(f, ['A1', 'B1', 'C1', 'E1', 'D1'])
        expect(origin_head() == f.base and hook_lines() == [], 'folding the trunk reached the origin')
    check('trunk.fold-never-pushes', first_fold)

    def held(b, needle):
        code, out = f.cli('integration/publication.js', '--publish-wave', request(b), gateway)
        expect(code == 3 and out['ok'] and out['result']['state'] == 'HELD' and out['result']['pushed'] is False, out)
        expect(any(r.startswith(needle) for r in out['result']['reasons']), ('missing reason ' + needle, out['result']['reasons']))
        expect(origin_head() == f.base and hook_lines() == [], 'a held barrier moved the origin')
        return out['result']['reasons']

    # B2 is pinned by the wave-4 barrier but not folded yet.
    check('barrier.holds-unfolded-snapshot', lambda: (snapshot(f, 'B2', git(f.repo, 'rev-parse', f.trunk)), held(wave4, 'SNAPSHOT_NOT_FOLDED:' + f.snap['B2']['id'])))
    check('barrier.holds-pending-closure', lambda: held(barrier(f, 4, None, wave4_tasks, release4, 'PENDING'), 'WAVE_CLOSURE_PENDING'))
    check('barrier.holds-wave-out-of-order', lambda: held(wave5, 'PREVIOUS_WAVE_UNPUBLISHED:4'))
    check('barrier.holds-snapshot-under-wrong-task', lambda: held(barrier(f, 4, None, [('A', ['A1', 'E1'])], release4), 'SNAPSHOT_TASK_MISMATCH:' + f.snap['E1']['id']))

    def second_fold():
        fold(f, ['B2'])
        expect(origin_head() == f.base and hook_lines() == [], 'folding the trunk reached the origin')
    check('trunk.rework-folds', second_fold)

    def refused(req, env, code_name):
        code, out = f.cli('integration/publication.js', '--publish-wave', req, env)
        expect(code == 1 and out['ok'] is False and out['code'] == code_name, out)
        expect(origin_head() == f.base and hook_lines() == [], 'a refused publication moved the origin')
    check('refuse.without-gateway-role', lambda: refused(request(wave4), {}, 'PUBLICATION_ROLE_DENIED'))
    check('refuse.remote-target', lambda: refused(dict(request(wave4), origin_path='https://github.com/example/never.git'), gateway, 'PUBLICATION_WAVE_TARGET_UNSUPPORTED'))

    def hook_rejects():
        f.reject_flag.write_text('1')
        try:
            refused(request(wave4), gateway, 'PUBLICATION_WAVE_REJECTED')
        finally:
            f.reject_flag.unlink()
    check('refuse.protected-hook-rejection', hook_rejects)

    result = {}

    def publish4():
        code, out = f.cli('integration/publication.js', '--publish-wave', request(wave4), gateway)
        expect(code == 0 and out['ok'] and out['result']['state'] == 'PUBLISHED' and out['result']['pushed'] is True, out)
        result.update(out['result'])
        expect(origin_head() == result['new_head'] and result['old_head'] == f.base, result)
    check('wave4.published', publish4)

    def one_update_per_wave():
        expect(hook_lines() == ['%s %s %s' % (f.base, result['new_head'], TARGET)], hook_lines())
    check('wave4.one-ref-update', one_update_per_wave)

    def one_commit_per_task_in_barrier_order():
        chain = git(f.origin, 'rev-list', '--reverse', '--first-parent', f.base + '..' + TARGET).split()
        expect(len(chain) == 4 and git(f.origin, 'rev-list', '--count', '--min-parents=2', f.base + '..' + TARGET) == '0', chain)
        keys = [git(f.origin, 'log', '-1', '--format=%(trailers:key=Hyperfide-Task-Key,valueonly)', c) for c in chain]
        expect(keys == [KEYS[t] for t, _ in wave4_tasks], keys)
        expect([c['commit'] for c in result['commits']] == chain, 'report differs from the origin chain')
        expected_paths = {'C': ['docs/c.md', 'src/C.txt'], 'A': ['src/A.txt'], 'D': ['src/D.txt'], 'B': ['src/B.txt', 'src/B2.txt']}
        for c, (t, _) in zip(chain, wave4_tasks):
            paths = sorted(git(f.origin, 'diff-tree', '-r', '--no-commit-id', '--name-only', c + '^', c).split())
            expect(paths == expected_paths[t], (t, paths))
        expect(git(f.origin, 'show', chain[3] + ':src/B.txt') == 'b two', 'task B was not squashed to its last snapshot')
    check('wave4.one-squashed-commit-per-task-in-barrier-order', one_commit_per_task_in_barrier_order)

    def trailers():
        digest = sha(canonical(wave4).encode())
        expect(result['barrier_digest'] == digest, (result['barrier_digest'], digest))
        chain = git(f.origin, 'rev-list', '--reverse', '--first-parent', f.base + '..' + TARGET).split()
        for c, (t, snaps) in zip(chain, wave4_tasks):
            get = lambda key: git(f.origin, 'log', '-1', '--format=%(trailers:key=' + key + ',valueonly)', c).split('\n')
            expect(get('Hyperfide-Feature') == [FEATURE] and get('Hyperfide-Wave') == ['4'] and get('Hyperfide-Task') == [f.task[t]], c)
            expect(get('Hyperfide-Snapshot') == [f.snap[s]['id'] for s in snaps], (t, get('Hyperfide-Snapshot')))
            expect(get('Hyperfide-Trunk') == [f.fold_commit[f.snap[snaps[-1]]['id']]], (t, get('Hyperfide-Trunk')))
            expect(get('Hyperfide-Barrier') == [digest], get('Hyperfide-Barrier'))
            subject = git(f.origin, 'log', '-1', '--format=%s', c)
            expect(subject == '%s %s: Task %s [spec:%s/%s]' % (FEATURE, KEYS[t], t, FEATURE, KEYS[t]), subject)
            expect(git(f.origin, 'log', '-1', '--format=%cI', c).replace('+00:00', 'Z') == release4, 'commit date is not the release time')
    check('wave4.trailers-carry-snapshot-identities', trailers)

    def tree_matches_replay():
        files = {}
        for n in ['A1', 'B1', 'C1', 'D1', 'B2']:
            files.update(EDITS[n])
        expect(git(f.origin, 'rev-parse', TARGET + '^{tree}') == f.tree_with(f.base, files), 'wave 4 tree differs from the replayed edits')
        expect(git(f.origin, 'show', TARGET + ':src/E.txt') == 'base E', 'a wave-5 change reached wave 4')
    check('wave4.tree-matches-replay', tree_matches_replay)

    def replay():
        before = hook_lines()
        code, out = f.cli('integration/publication.js', '--publish-wave', request(wave4), gateway)
        expect(code == 0 and out['result']['replayed'] is True and out['result']['pushed'] is False, out)
        expect([c['commit'] for c in out['result']['commits']] == [c['commit'] for c in result['commits']], out)
        expect(hook_lines() == before and origin_head() == result['new_head'], 'replay republished')
    check('wave4.rerun-replays', replay)

    def publish5():
        code, out = f.cli('integration/publication.js', '--publish-wave', request(wave5), gateway)
        expect(code == 0 and out['result']['state'] == 'PUBLISHED' and out['result']['old_head'] == result['new_head'], out)
        expect(hook_lines()[-1] == '%s %s %s' % (result['new_head'], out['result']['new_head'], TARGET) and len(hook_lines()) == 2, hook_lines())
        chain = git(f.origin, 'rev-list', '--first-parent', result['new_head'] + '..' + TARGET).split()
        expect(len(chain) == 1 and git(f.origin, 'log', '-1', '--format=%(trailers:key=Hyperfide-Wave,valueonly)', chain[0]) == '5', chain)
        expect(git(f.origin, 'rev-parse', TARGET + '^{tree}') == git(f.repo, 'rev-parse', f.trunk + '^{tree}'), 'published tree differs from the trunk')
        code, out = f.cli('integration/publication.js', '--publish-wave', request(wave4), gateway)
        expect(code == 0 and out['result']['replayed'] is True and len(hook_lines()) == 2, 'wave 4 replay after wave 5 republished')
    check('wave5.published-after-wave4', publish5)

    # Retention: N from the shipped control policy; the code has none.
    example = ROOT / 'deploy/hyperfide/policies/control.example.json'
    policy = f.root / 'control.json'
    shutil.copyfile(example, policy)

    def shipped_variable():
        out = f.node({'op': 'policy', 'file': str(policy), 'revision': 'replace-with-approved-spec-revision'})
        expect(out['publication'] == {'snapshot_retention_days': 30}, out)
    check('retention.variable-in-control-policy', shipped_variable)

    capsule = b'HFSN0001 unpublished'
    unpublished = {'snapshot_id': str(uuid.uuid4()), 'checkpoint_digest': sha(capsule)}
    (f.checkpoints / (unpublished['checkpoint_digest'][7:] + '.hfs')).write_bytes(capsule)
    snaps = [{'snapshot_id': f.snap[n]['id'], 'checkpoint_digest': f.snap[n]['checkpoint'], 'adoptable': n == 'C1'} for n in ['A1', 'B1', 'B2', 'C1', 'D1', 'E1']]
    snaps.append(dict(unpublished, adoptable=False))
    prune_request = lambda dry, file=policy: {'policy_file': str(file), 'origin_path': str(f.origin), 'target_ref': TARGET, 'run_base': f.base,
                                              'checkpoint_directory': str(f.checkpoints), 'snapshots': snaps, 'dry_run': dry}
    capsule_of = lambda s: f.checkpoints / (s['checkpoint_digest'][7:] + '.hfs')
    by_name = {n: f.snap[n]['id'] for n in f.snap}

    def unset():
        bare = json.loads(example.read_text())
        bare.pop('publication')
        path = f.root / 'control-unset.json'
        path.write_text(json.dumps(bare))
        code, out = f.cli('artifacts/retention.js', '--prune-snapshots', prune_request(False, path))
        expect(code == 1 and out['code'] == 'RETENTION_SNAPSHOT_DAYS_UNSET', out)
        expect(all(capsule_of(s).exists() for s in snaps), 'an unset variable pruned')
    check('retention.refuses-without-variable', unset)

    def schedule():
        code, out = f.cli('artifacts/retention.js', '--prune-snapshots', prune_request(True))
        expect(code == 0 and out['result']['retention_days'] == 30 and out['result']['pruned'] is None, out)
        rows = {r['snapshot_id']: r for r in out['result']['schedule']}
        after4 = (iso_ms(release4) + datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        after5 = (iso_ms(release5) + datetime.timedelta(days=30)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
        for n in ['A1', 'B1', 'B2', 'D1']:
            expect((rows[by_name[n]]['action'], rows[by_name[n]]['reason'], rows[by_name[n]]['prune_after']) == ('PRUNE', 'PUBLISHED_RETENTION_ELAPSED', after4), rows[by_name[n]])
        expect((rows[by_name['C1']]['action'], rows[by_name['C1']]['reason']) == ('KEEP', 'ADOPTABLE_CHECKPOINT'), rows[by_name['C1']])
        expect((rows[by_name['E1']]['action'], rows[by_name['E1']]['reason'], rows[by_name['E1']]['prune_after']) == ('KEEP', 'WITHIN_RETENTION', after5), rows[by_name['E1']])
        expect((rows[unpublished['snapshot_id']]['action'], rows[unpublished['snapshot_id']]['reason'], rows[unpublished['snapshot_id']]['published_at']) == ('KEEP', 'UNPUBLISHED', None), rows)
        expect(all(capsule_of(s).exists() for s in snaps), 'a dry run pruned')
    check('retention.schedule-n-days-after-publication', schedule)

    def prune():
        head = origin_head()
        code, out = f.cli('artifacts/retention.js', '--prune-snapshots', prune_request(False))
        expect(code == 0, out)
        pruned = out['result']['pruned']
        expect(sorted(pruned['pruned']) == sorted(by_name[n] for n in ['A1', 'B1', 'B2', 'D1']) and pruned['absent'] == [], pruned)
        for s in snaps:
            gone = s['snapshot_id'] in pruned['pruned']
            expect(capsule_of(s).exists() is not gone, ('capsule state wrong', s))
        expect(origin_head() == head and git(f.origin, 'cat-file', '-t', head) == 'commit', 'pruning touched the publication')
        code, out = f.cli('artifacts/retention.js', '--prune-snapshots', prune_request(False))
        expect(code == 0 and out['result']['pruned']['pruned'] == [] and len(out['result']['pruned']['absent']) == 4, out)
    check('retention.prunes-published-keeps-adoptable', prune)


def main():
    for tool in ('git', 'node'):
        if shutil.which(tool) is None:
            skip(tool + ' is required')
    if not (SERVICE / 'node_modules').exists():
        skip('core/control-plane/node_modules is not installed')
    stamp = subprocess.run(['node', str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(SERVICE)], cwd=ROOT, capture_output=True, text=True)
    if stamp.returncode:
        build_run = subprocess.run(['npm', '--prefix', str(SERVICE), 'run', 'build'], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if build_run.returncode:
            print('service build failed: ' + (build_run.stderr + build_run.stdout)[-1500:], file=sys.stderr)
            return 1
    root = pathlib.Path(tempfile.mkdtemp(prefix='hf-5-5-'))
    try:
        f = Fixture(root)
        build(f)
        scenario(f)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        FAILED.append('setup')
    finally:
        shutil.rmtree(root, ignore_errors=True)
    closed = not root.exists()
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'fixture-repositories', 'status': 'deleted' if closed else 'unknown', 'observed_absent': closed}],
                      'complete': closed}), flush=True)
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
