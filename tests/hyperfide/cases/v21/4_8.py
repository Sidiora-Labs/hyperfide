#!/usr/bin/env python3
"""hyperfide-v21 4.8: the integrator merge queue.

On an owned throwaway PostgreSQL cluster (the v21/3_2.py pattern) the control service runs in HTTPS mode on the real
identity path with the 19.1-queue registration, the 1.2-asks component and the 6.1 outbox. Eight qualified custodies
each carry a recorded source snapshot (3.8) whose objects exist only in its HFSN0001 checkpoint capsule; two of them
(tasks 3 and 7) change the same line of one file. The operator invokes integration.queue.fold and the case asserts:
touch-disjoint batches in queue order, one requalification of the batch head, a bisected failure isolating the
snapshot that breaks the gate, a trunk tree equal to an independent replay of the folded edits, a decision Ask
raised through human.ask.raise with both sides of the conflict, an origin that received nothing, and an idempotent
rerun. Prerequisite rows are seeded with FK triggers suspended. Prints SKIP and exits 77 without PostgreSQL or root.
"""
import hashlib, importlib.util, json, os, pathlib, pwd, shutil, struct, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
GIT_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid', 'GIT_COMMITTER_NAME': 'Fixture',
           'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
# The gate the requalifier runs on a folded head: no file of the tree may contain the marker.
REQUALIFIER = r"""
import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export async function requalify(input){
 let outcome='PASS';
 try{execFileSync('git',['-C',input.repository_path,'grep','-q','-e','BROKEN',input.tree],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}});outcome='FAIL';}
 catch(error){if(error.status!==1)throw error;}
 const record={commit:input.commit,tree:input.tree,snapshot_ids:input.snapshot_ids,outcome};
 appendFileSync(LOG,JSON.stringify(record)+'\n');
 return {outcome,receipt_digest:'sha256:'+createHash('sha256').update(JSON.stringify(record)).digest('hex')};
}
"""
SEED = r"""
const fs=require('fs'),{createRequire}=require('module'),pg=createRequire(process.cwd()+'/services/hyperfide/package.json')('pg');
(async()=>{const rows=JSON.parse(fs.readFileSync(0,'utf8')),c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role=replica");for(const [sql,values] of rows)await c.query(sql,values);await c.query('COMMIT');}
 catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}})().catch(e=>{process.stderr.write(String(e.message));process.exitCode=1;});
"""


def uid():
    return str(uuid.uuid4())


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


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
    print(json.dumps({'type': 'assertion', 'id': 'queue.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def git(repo, *args, data=None):
    p = subprocess.run(['git', '-C', str(repo), *args], env=GIT_ENV, input=data, capture_output=True, timeout=120)
    expect(p.returncode == 0, 'git ' + ' '.join(args) + ': ' + p.stderr.decode('utf8', 'replace')[-800:])
    return p.stdout


def text(repo, *args):
    return git(repo, *args).decode().strip()


def edits(k):
    """The files snapshot k writes over the base. Tasks 3 and 7 change the same line; snapshot 5 breaks the gate."""
    changed = {'src/%d.txt' % k: 'line one\nchange %d%s\n' % (k, ' BROKEN' if k == 5 else '')}
    if k == 3:
        changed['shared/conf.txt'] = 'mode = three\n'
    if k == 7:
        changed['shared/conf.txt'] = 'mode = seven\n'
    return changed


def objects(repo, tree):
    return set(text(repo, 'rev-list', '--objects', '--no-object-names', tree).split())


def build_repositories(f):
    root = pathlib.Path(os.path.realpath(f.path / 'integration'))
    (root / 'checkpoints').mkdir(parents=True)
    origin = f.path / 'origin'
    origin.mkdir()
    git(origin, 'init', '-q', '-b', 'main')
    for k in range(1, 9):
        (origin / 'src').mkdir(exist_ok=True)
        (origin / 'src' / ('%d.txt' % k)).write_text('line one\n')
    (origin / 'shared').mkdir()
    (origin / 'shared/conf.txt').write_text('mode = base\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-q', '-m', 'base')
    base = text(origin, 'rev-parse', 'HEAD')
    base_tree = text(origin, 'rev-parse', 'HEAD^{tree}')
    # The integrator store holds the run base only; snapshot objects arrive in their checkpoint capsules.
    repo = root / 'repo.git'
    subprocess.run(['git', 'clone', '-q', '--bare', str(origin), str(repo)], env=GIT_ENV, check=True, capture_output=True)
    work = f.path / 'work'
    subprocess.run(['git', 'clone', '-q', str(origin), str(work)], env=GIT_ENV, check=True, capture_output=True)
    base_objects = objects(work, base_tree)
    snapshots = []
    for k in range(1, 9):
        git(work, 'checkout', '-q', '-f', base)
        for name, body in edits(k).items():
            (work / name).write_text(body)
        git(work, 'add', '-A')
        tree = text(work, 'write-tree')
        new = sorted(objects(work, tree) - base_objects)
        pack = git(work, 'pack-objects', '-q', '--stdout', data=('\n'.join(new) + '\n').encode())
        meta = json.dumps({'format': 'HFSN0001', 'result_tree_id': tree, 'base_commit': base, 'snapshot': k}).encode()
        capsule = b'HFSN0001' + struct.pack('>QQ', len(meta), len(pack)) + meta + pack
        checkpoint = sha(capsule)
        (root / 'checkpoints' / (checkpoint[7:] + '.hfs')).write_bytes(capsule)
        snapshots.append({'k': k, 'tree': tree, 'checkpoint': checkpoint, 'files': len(edits(k))})
    expect(not subprocess.run(['git', '-C', str(repo), 'cat-file', '-e', snapshots[0]['tree']], env=GIT_ENV, capture_output=True).returncode == 0,
           'integrator store already holds a snapshot tree')
    return root, origin, repo, work, base, base_tree, snapshots


def setup(f):
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    root, origin, repo, work, base, base_tree, snapshots = build_repositories(f)
    f.queue = {'root': root, 'origin': origin, 'repo': repo, 'work': work, 'base': base, 'base_tree': base_tree, 'snapshots': snapshots}
    i['repository'] = uid()
    i['credential'] = uid()
    digest = 'sha256:' + 'c' * 64
    rows = [["INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES($1,$2,$3,$4,'refs/heads/main')", [o, r, i['repository'], base]]]
    f.entries = []

    def task(k, state, outcome, snapshot):
        t, a, c = uid(), uid(), uid()
        rows.append(["INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave,state,current_custody_id) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',4,$8,$9)",
                     [o, r, t, '4.8.%d' % k, uid(), i['spec'], digest, state, c]])
        rows.append(['INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest) VALUES($1,$2,$3,$4,1,$5,$6)', [o, r, a, t, i['epoch'], digest]])
        rows.append(["INSERT INTO hyperfide.submission_custodies(organisation_id,run_id,id,task_id,source_attempt_id,source_generation,custody_generation,authority_epoch,repository_id,source_object_id,source_manifest_digest,evidence_manifest_digest,criteria_digest,qualification_outcome) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$9,$9,$10)",
                     [o, r, c, t, a, i['epoch'], i['repository'], base, digest, outcome]])
        manifest = {}
        n = None
        if snapshot:
            n = uid()
            rows.append(["INSERT INTO hyperfide.source_snapshots(organisation_id,run_id,id,task_id,attempt_id,attempt_generation,repository_id,base_commit,base_tree,result_tree,slice_digest,checkpoint_digest,checkpoint_receipt,files_changed,insertions,deletions,binary_files,created_by_credential_id) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13,0,$14)",
                         [o, r, n, t, a, i['repository'], base, base_tree, snapshot['tree'], digest, snapshot['checkpoint'],
                          json.dumps({'checkpoint_digest': snapshot['checkpoint'], 'format': 'HFSN0001', 'authority': 'NONE'}), snapshot['files'], i['credential']]])
            manifest = {'snapshot_id': n, 'snapshot_tree_id': snapshot['tree']}
        rows.append(['INSERT INTO hyperfide.assurance_submissions(organisation_id,run_id,custody_id,request_id,request_digest,manifest,policy,source_artifact_id,evidence_artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                     [o, r, c, uid(), digest, json.dumps(manifest), '{}', uid(), uid()]])
        return {'k': k, 'task': t, 'attempt': a, 'custody': c, 'snapshot': n}

    for s in snapshots:
        f.entries.append(task(s['k'], 'QUALIFIED', 'PASS', s))
    f.pending = task(9, 'SUBMITTED', 'PENDING', snapshots[0])
    f.unsnapshotted = task(10, 'QUALIFIED', 'PASS', None)
    seeded = subprocess.run(['node', '--input-type=commonjs', '-e', SEED], input=json.dumps(rows), text=True, cwd=ROOT,
                            env=dict(f.env, DATABASE_URL=f.url), capture_output=True, timeout=60)
    expect(seeded.returncode == 0, 'seed failed: ' + seeded.stderr[-1500:])

    log = f.path / 'requalify.log'
    module = f.path / 'requalifier.mjs'
    module.write_bytes(('const LOG=' + json.dumps(str(log)) + ';' + REQUALIFIER).encode())
    f.requalify_log = log
    config = {'version': 1, 'organisation_id': o, 'root': str(root), 'closure': {},
              'repositories': [{'repository_id': i['repository'], 'path': str(repo), 'target_ref': 'refs/heads/main', 'required_graph': False,
                                'review_policy_digest': digest, 'review_rubrics': [digest],
                                'gates': [{'id': 'queue-gate', 'kind': 'test', 'argv': ['true'], 'timeout_ms': 1000,
                                           'proof': {'manifest_path': 'm', 'manifest_digest': digest, 'registry_path': 'r', 'registry_digest': digest,
                                                     'expected_assertion_ids': ['queue.gate'], 'case_ids': ['V-048']}}]}]}
    (f.path / 'integration.json').write_text(json.dumps(config))
    f.env.update({'HYPERFIDE_INTEGRATION_CONFIG': str(f.path / 'integration.json'), 'HYPERFIDE_QUEUE_REQUALIFIER_MODULE': str(module),
                  'HYPERFIDE_QUEUE_REQUALIFIER_DIGEST': sha(module.read_bytes())})


def requalifications(f):
    if not f.requalify_log.exists():
        return []
    return [json.loads(x) for x in f.requalify_log.read_text().splitlines() if x]


def scenario(f):
    i, q = f.ids, f.queue
    scope = {'organisation_id': i['organisation'], 'run_id': i['run']}
    snap = {e['k']: e['snapshot'] for e in f.entries}
    ids = lambda ks: [snap[k] for k in ks]
    origin_refs = text(q['origin'], 'for-each-ref', '--format=%(objectname) %(refname)')
    trunk_ref = 'refs/hyperfide/trunk/' + i['run']

    def call(action, payload, component):
        # A fold runs dozens of Git processes and six requalifications; a loaded host needs more than the 10 s default.
        return f.invoke(action, payload, key='operator', component=component, timeout_seconds=120)[1]

    def ok(action, payload, component):
        response = call(action, payload, component)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:1500])
        return response['result']

    def fold(custodies):
        # A merge conflict raises a decision Ask; its deadline must sit within the decision kind policy (3.6, 14400 s).
        return dict(scope, repository_id=i['repository'], custody_ids=custodies, ask_deadline_seconds=14400)

    queue = [e['custody'] for e in f.entries]

    def refused(custodies, needle):
        response = call('integration.queue.fold', fold(custodies), '19.1-queue')
        expect(response.get('ok') is False and needle in json.dumps(response), 'not refused with ' + needle + ': ' + json.dumps(response)[:800])
        expect(subprocess.run(['git', '-C', str(q['repo']), 'rev-parse', '--verify', '--quiet', trunk_ref], env=GIT_ENV, capture_output=True).returncode != 0,
               'a refused queue moved the trunk')

    check('refuse.unqualified-custody', lambda: refused(queue[:2] + [f.pending['custody']], 'INTEGRATION_CUSTODY_STALE'))
    check('refuse.custody-without-snapshot', lambda: refused(queue[:2] + [f.unsnapshotted['custody']], 'INTEGRATION_QUEUE_SNAPSHOT_REQUIRED'))

    i['operator_consumer'] = uid()
    check('operator-channel.registered', lambda: ok('outbox.consumer.register', dict(scope, id=i['operator_consumer'], consumer_key='operator:asks', critical=False, state='ACTIVE'), '6.1'))

    first = {}
    check('fold.invoked', lambda: first.update(ok('integration.queue.fold', fold(queue), '19.1-queue')))
    report = lambda: (expect(first, 'fold did not run'), first)[1]

    def batches():
        r = report()
        got = [b['snapshot_ids'] for b in r['batches']]
        expect(got == [ids([1, 2, 3, 4, 5, 6, 8]), ids([7])], ('batches are not touch-disjoint in queue order', got))
    check('batches.touch-disjoint', batches)

    def requalified_once_then_bisected():
        log, r = requalifications(f), report()
        expected = [(ids([1, 2, 3, 4, 5, 6, 8]), 'FAIL'), (ids([1, 2, 3, 4]), 'PASS'), (ids([5, 6]), 'FAIL'), (ids([5]), 'FAIL'), (ids([6]), 'PASS'), (ids([8]), 'PASS')]
        expect([(x['snapshot_ids'], x['outcome']) for x in log] == expected, ('requalification sequence', log))
        expect([(x['snapshot_ids'], x['outcome'], x['commit']) for x in r['requalifications']] == [(x['snapshot_ids'], x['outcome'], x['commit']) for x in log],
               'the report differs from what the requalifier observed')
        expect(log[0]['tree'] == text(q['repo'], 'rev-parse', log[0]['commit'] + '^{tree}'), 'requalified tree is not the folded head')
    check('requalify.batch-once-then-bisect', requalified_once_then_bisected)

    def bisected_failure():
        r = report()
        expect([(x['snapshot_id'], x['reason']) for x in r['rejected']] == [(snap[5], 'REQUALIFICATION_FAILED')], r['rejected'])
        expect(r['rejected'][0]['receipt_digest'].startswith('sha256:'), 'rejection carries no requalification receipt')
        expect([x['snapshot_id'] for x in r['folded']] == ids([1, 2, 3, 4, 6, 8]), r['folded'])
    check('bisect.isolates-failing-snapshot', bisected_failure)

    def trunk():
        r = report()
        head = text(q['repo'], 'rev-parse', trunk_ref)
        expect(r['trunk_before'] == q['base'] and r['trunk_after'] == head and r['pushed'] is False, r)
        chain = text(q['repo'], 'rev-list', '--first-parent', q['base'] + '..' + head).split()
        expect(len(chain) == 6 and text(q['repo'], 'rev-list', '--max-parents=1', '--min-parents=1', '--count', q['base'] + '..' + head) == '6', 'trunk is not six linear fold commits')
        trailers = text(q['repo'], 'log', '--reverse', '--format=%(trailers:key=Hyperfide-Snapshot,valueonly)', q['base'] + '..' + head).split()
        expect(trailers == ids([1, 2, 3, 4, 6, 8]), trailers)
        # Independent expectation: the folded snapshots' edits replayed by hand over the base.
        git(q['work'], 'checkout', '-q', '-f', q['base'])
        for k in [1, 2, 3, 4, 6, 8]:
            for name, body in edits(k).items():
                (q['work'] / name).write_text(body)
        git(q['work'], 'add', '-A')
        expect(text(q['repo'], 'rev-parse', head + '^{tree}') == text(q['work'], 'write-tree'), 'trunk tree differs from the replayed edits')
        expect(text(q['repo'], 'show', head + ':shared/conf.txt') == 'mode = three', 'the conflicting side reached the trunk')
    check('trunk.folded-tree-matches-replay', trunk)

    def origin_untouched():
        expect(text(q['origin'], 'for-each-ref', '--format=%(objectname) %(refname)') == origin_refs, 'origin refs changed')
        expect(text(q['repo'], 'rev-parse', 'refs/heads/main') == q['base'], 'the published target ref moved')
    check('trunk.never-pushed', origin_untouched)

    def conflict_ask():
        r = report()
        expect([c['snapshot_id'] for c in r['conflicts']] == ids([7]) and r['conflicts'][0]['paths'][0]['path'] == 'shared/conf.txt', r['conflicts'])
        ask = r['ask']
        expect(ask['status'] == 'RAISED' and r['complete'] is True, ask)
        a = ask['ask']
        seven = next(e for e in f.entries if e['k'] == 7)
        expect(a['kind'] == 'decision' and a['state'] == 'OPEN' and a['task'] == seven['task'] and a['default_policy'] == 'proceed-and-flag', a)
        expect(a['options'] == ['rework-snapshot', 'keep-trunk-side', 'take-snapshot-side'] and a['recommended'] == 'rework-snapshot', a)
        expect('mode = three' in a['body'] and 'mode = seven' in a['body'] and 'trunk side' in a['body'] and 'snapshot side' in a['body'], a['body'])
        rows = f.sql("SELECT id,kind,state FROM hyperfide.asks WHERE organisation_id=$1 AND run_id=$2", [i['organisation'], i['run']])
        expect(rows == [{'id': a['ask_id'], 'kind': 'decision', 'state': 'OPEN'}], rows)
        delivered = f.sql('SELECT consumer_id FROM hyperfide.event_deliveries WHERE event_id=$1', [ask['event_id']])
        expect(delivered == [{'consumer_id': i['operator_consumer']}], delivered)
        listed = ok('human.ask.list', {'state': 'OPEN', 'limit': 10}, '1.2-asks')['asks']
        expect([x['ask_id'] for x in listed] == [a['ask_id']], listed)
    check('conflict.decision-ask-with-both-sides', conflict_ask)

    def rerun():
        head = text(q['repo'], 'rev-parse', trunk_ref)
        before = len(requalifications(f))
        again = ok('integration.queue.fold', fold(queue), '19.1-queue')
        expect(again['skipped'] == ids([1, 2, 3, 4, 6, 8]) and again['folded'] == [], again)
        expect([x['snapshot_id'] for x in again['rejected']] == ids([5]) and again['trunk_after'] == head == text(q['repo'], 'rev-parse', trunk_ref), again)
        expect(len(requalifications(f)) == before + 1, 'rerun requalified more than the one remaining batch')
        expect(again['ask']['replayed'] is True and again['ask']['ask']['ask_id'] == first['ask']['ask']['ask_id'], again['ask'])
        expect(f.sql('SELECT count(*)::int AS n FROM hyperfide.asks WHERE organisation_id=$1', [i['organisation']]) == [{'n': 1}], 'rerun raised a second Ask')
    check('rerun.idempotent', rerun)


def main():
    t27 = load('hf_case_v21_2_7', 'tests/hyperfide/cases/v21/2_7.py')
    binaries = t27.postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        skip('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    if os.geteuid() != 0 or shutil.which('runuser') is None:
        skip('owned cluster needs root and runuser to start PostgreSQL as the postgres user')
    try:
        pwd.getpwnam('postgres')
    except KeyError:
        skip('no postgres system user for the owned cluster')
    for tool in ('git', 'node', 'openssl'):
        if shutil.which(tool) is None:
            skip(tool + ' is required')
    if not (SERVICE / 'node_modules').exists():
        skip('services/hyperfide/node_modules is not installed')
    stamp = subprocess.run(['node', str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(SERVICE)], cwd=ROOT, capture_output=True, text=True)
    if stamp.returncode:
        build = subprocess.run(['npm', '--prefix', str(SERVICE), 'run', 'build'], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if build.returncode:
            print('service build failed: ' + (build.stderr + build.stdout)[-1500:], file=sys.stderr)
            return 1
    # Only the owned cluster is reachable: never let an inherited database URL redirect the case.
    for key in [k for k in os.environ if k == 'DATABASE_URL' or k.startswith('HYPERFIDE_') and k.endswith('_DATABASE_URL')]:
        del os.environ[key]
    cluster, fixture, closed = None, None, False
    try:
        cluster = t27.Cluster(binaries)
        cluster.migrate_template()
        os.environ['DATABASE_URL'] = cluster.url()
        import identity_fixture
        for attempt in range(3):
            try:
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', '1.2-asks', '19.1-queue'), extra_setup=setup)
                break
            except AssertionError as error:
                if 'TX_TIMEOUT' not in str(error) or attempt == 2:
                    raise
        scenario(fixture)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        FAILED.append('setup')
    finally:
        try:
            if fixture:
                fixture.close()
            if cluster:
                cluster.close()
            closed = cluster is not None and not cluster.root.exists()
        except Exception as error:
            print('cleanup failed: ' + str(error), file=sys.stderr)
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'status': 'deleted' if closed else 'unknown', 'observed_absent': closed}],
                      'complete': closed}), flush=True)
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
