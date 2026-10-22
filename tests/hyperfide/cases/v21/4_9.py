#!/usr/bin/env python3
"""hyperfide-v21 4.9: the internal trunk is the only advancing ref.

On an owned throwaway PostgreSQL cluster (the v21/4_8.py pattern) the control service runs in HTTPS mode with the
17.1 watchers, the 19.1-queue integrator and the 18.1 finding registry. A local bare repository stands in for the
GitHub origin and carries the real publication gateway hook (integration/publication.ts installGatewayHook); nothing
is pushed to a real remote. The case asserts: a watcher observes an internal fold on refs/hyperfide/trunk/<run>
before any publication exists while the origin's protected ref stays at the run base; a GitHub-tracking ref is
refused as a discovery source and an origin-only commit is never discovered; a finding is recorded against the
trunk commit and refused against the origin-only commit; a direct push of the trunk to the protected ref, and any
push of an internal ref, is refused by the gateway. Prints SKIP and exits 77 without PostgreSQL or root.
"""
import hashlib, importlib.util, json, os, pathlib, pwd, shutil, struct, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
GIT_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'HOME': '/nonexistent', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
           'GIT_AUTHOR_NAME': 'Fixture', 'GIT_AUTHOR_EMAIL': 'fixture@example.invalid', 'GIT_COMMITTER_NAME': 'Fixture',
           'GIT_COMMITTER_EMAIL': 'fixture@example.invalid'}
REQUALIFIER = r"""
import {appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
export async function requalify(input){
 appendFileSync(LOG,JSON.stringify(input.snapshot_ids)+'\n');
 return {outcome:'PASS',receipt_digest:'sha256:'+createHash('sha256').update(input.commit).digest('hex')};
}
"""
SEED = r"""
const fs=require('fs'),{createRequire}=require('module'),pg=createRequire(process.cwd()+'/services/hyperfide/package.json')('pg');
(async()=>{const rows=JSON.parse(fs.readFileSync(0,'utf8')),c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
 try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role=replica");for(const [sql,values] of rows)await c.query(sql,values);await c.query('COMMIT');}
 catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}})().catch(e=>{process.stderr.write(String(e.message));process.exitCode=1;});
"""
INSTALL_HOOK = "import {installGatewayHook} from './services/hyperfide/dist/integration/publication.js';await installGatewayHook(process.argv[1],process.argv[2]);"
WATCHERS = 10


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
    print(json.dumps({'type': 'assertion', 'id': 'trunk.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run_git(repo, *args, data=None):
    return subprocess.run(['git', '-C', str(repo), *args], env=GIT_ENV, input=data, capture_output=True, timeout=120)


def git(repo, *args, data=None):
    p = run_git(repo, *args, data=data)
    expect(p.returncode == 0, 'git ' + ' '.join(args) + ': ' + p.stderr.decode('utf8', 'replace')[-800:])
    return p.stdout


def text(repo, *args):
    return git(repo, *args).decode().strip()


def refs(repo):
    return text(repo, 'for-each-ref', '--format=%(objectname) %(refname)')


def edits(k):
    return {'src/%d.txt' % k: 'line one\nchange %d\n' % k}


def objects(repo, tree):
    return set(text(repo, 'rev-list', '--objects', '--no-object-names', tree).split())


def build_repositories(f):
    root = pathlib.Path(os.path.realpath(f.path / 'integration'))
    (root / 'checkpoints').mkdir(parents=True)
    work = f.path / 'work'
    work.mkdir()
    git(work, 'init', '-q', '-b', 'main')
    for k in (1, 2):
        (work / 'src').mkdir(exist_ok=True)
        (work / 'src' / ('%d.txt' % k)).write_text('line one\n')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'base')
    base = text(work, 'rev-parse', 'HEAD')
    base_tree = text(work, 'rev-parse', 'HEAD^{tree}')
    # A commit that exists only on the GitHub stand-in: the trunk never folds it, so no watcher or finding may read it.
    git(work, 'checkout', '-q', '-b', 'upstream')
    (work / 'src/1.txt').write_text('line one\nedited on GitHub\n')
    git(work, 'commit', '-q', '-am', 'origin-only change')
    upstream = text(work, 'rev-parse', 'HEAD')
    git(work, 'checkout', '-q', 'main')
    origin = root / 'origin.git'
    subprocess.run(['git', 'clone', '-q', '--bare', str(work), str(origin)], env=GIT_ENV, check=True, capture_output=True)
    repo = root / 'repo.git'
    subprocess.run(['git', 'clone', '-q', '--bare', str(origin), str(repo)], env=GIT_ENV, check=True, capture_output=True)
    base_objects = objects(work, base_tree)
    snapshots = []
    for k in (1, 2):
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
        snapshots.append({'k': k, 'tree': tree, 'checkpoint': checkpoint})
    return {'root': root, 'origin': origin, 'repo': repo, 'work': work, 'base': base, 'base_tree': base_tree, 'upstream': upstream, 'snapshots': snapshots}


def setup(f, t18):
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    q = f.queue = build_repositories(f)
    i['repository'] = uid()
    digest = 'sha256:' + 'c' * 64
    rows = [["INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES($1,$2,$3,'trunk-fixture','https://example.invalid/trunk-fixture.git')", [o, i['repository'], i['project']]],
            ["INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES($1,$2,$3,$4,'refs/heads/main')", [o, r, i['repository'], q['base']]]]
    for value in (q['base'], q['upstream']):
        rows.append(["INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,'commit')", [o, i['repository'], value]])
    f.entries = []
    for s in q['snapshots']:
        t, a, c, n = uid(), uid(), uid(), uid()
        rows.append(["INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave,state,current_custody_id) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',4,'QUALIFIED',$8)",
                     [o, r, t, '4.9.%d' % s['k'], uid(), i['spec'], digest, c]])
        rows.append(['INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest) VALUES($1,$2,$3,$4,1,$5,$6)', [o, r, a, t, i['epoch'], digest]])
        rows.append(["INSERT INTO hyperfide.submission_custodies(organisation_id,run_id,id,task_id,source_attempt_id,source_generation,custody_generation,authority_epoch,repository_id,source_object_id,source_manifest_digest,evidence_manifest_digest,criteria_digest,qualification_outcome) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$9,$9,'PASS')",
                     [o, r, c, t, a, i['epoch'], i['repository'], q['base'], digest]])
        rows.append(["INSERT INTO hyperfide.source_snapshots(organisation_id,run_id,id,task_id,attempt_id,attempt_generation,repository_id,base_commit,base_tree,result_tree,slice_digest,checkpoint_digest,checkpoint_receipt,files_changed,insertions,deletions,binary_files,created_by_credential_id) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,1,1,1,0,$13)",
                     [o, r, n, t, a, i['repository'], q['base'], q['base_tree'], s['tree'], digest, s['checkpoint'],
                      json.dumps({'checkpoint_digest': s['checkpoint'], 'format': 'HFSN0001', 'authority': 'NONE'}), uid()]])
        rows.append(['INSERT INTO hyperfide.assurance_submissions(organisation_id,run_id,custody_id,request_id,request_digest,manifest,policy,source_artifact_id,evidence_artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
                     [o, r, c, uid(), digest, json.dumps({'snapshot_id': n, 'snapshot_tree_id': s['tree']}), '{}', uid(), uid()]])
        f.entries.append({'k': s['k'], 'custody': c, 'snapshot': n})
    i['watchers'] = [uid() for _ in range(WATCHERS)]
    for n, session in enumerate(i['watchers']):
        rows.append(["INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES($1,$2,$3,'COMMIT_WATCHER','fixture','fixture',$4,'RUNNING')", [o, r, session, 'watcher-%d' % n]])
    seeded = subprocess.run(['node', '--input-type=commonjs', '-e', SEED], input=json.dumps(rows), text=True, cwd=ROOT,
                            env=dict(f.env, DATABASE_URL=f.url), capture_output=True, timeout=60)
    expect(seeded.returncode == 0, 'seed failed: ' + seeded.stderr[-1500:])
    seed_finding_origin(f, t18)

    log = f.path / 'requalify.log'
    module = f.path / 'requalifier.mjs'
    module.write_bytes(('const LOG=' + json.dumps(str(log)) + ';' + REQUALIFIER).encode())
    config = {'version': 1, 'organisation_id': o, 'root': str(q['root']), 'closure': {},
              'repositories': [{'repository_id': i['repository'], 'path': str(q['repo']), 'receive_path': str(q['origin']), 'target_ref': 'refs/heads/main',
                                'required_graph': False, 'review_policy_digest': digest, 'review_rubrics': [digest],
                                'gates': [{'id': 'trunk-gate', 'kind': 'test', 'argv': ['true'], 'timeout_ms': 1000,
                                           'proof': {'manifest_path': 'm', 'manifest_digest': digest, 'registry_path': 'r', 'registry_digest': digest,
                                                     'expected_assertion_ids': ['trunk.gate'], 'case_ids': ['V-048']}}]}]}
    integration = f.path / 'integration.json'
    integration.write_text(json.dumps(config))
    # The GitHub stand-in carries the real publication gateway: a private server config and a 32-byte permit key.
    key = f.path / 'gateway.key'
    key.write_bytes(os.urandom(32))
    key.chmod(0o600)
    server = f.path / 'gateway-server.json'
    server.write_text(json.dumps({'HYPERFIDE_INTEGRATION_CONFIG': str(integration), 'HYPERFIDE_GATEWAY_KEY_FILE': str(key)}))
    server.chmod(0o600)
    installed = subprocess.run(['node', '--input-type=module', '-e', INSTALL_HOOK, str(q['origin']), str(server)], cwd=ROOT, env=GIT_ENV | {'PATH': os.environ['PATH']},
                               capture_output=True, text=True, timeout=60)
    expect(installed.returncode == 0, 'gateway hook install failed: ' + installed.stderr[-1500:])
    f.env.update({'HYPERFIDE_INTEGRATION_CONFIG': str(integration), 'HYPERFIDE_QUEUE_REQUALIFIER_MODULE': str(module),
                  'HYPERFIDE_QUEUE_REQUALIFIER_DIGEST': sha(module.read_bytes()), 'HYPERFIDE_REVIEW_ALLOWED_ROOT': str(q['root']),
                  'HYPERFIDE_REVIEW_REPOSITORIES': json.dumps({i['repository']: {'path': str(q['repo'])}})})


def seed_finding_origin(f, t18):
    """The 18.1 accepted-proof origin a finding resolves against (tests/hyperfide/cases/tasks/18_1.py seed, bound to this repository)."""
    i, q = f.ids, f.queue
    f.x = {'repository': i['repository'], 'package': uid(), 'manager': uid(), 'task': uid(), 'attempt': uid(), 'artifact': uid(), 'upstream_evidence': uid()}
    x = f.x
    t18.OID = q['base']
    t18.insert(f, 'agent_sessions', t18.scoped(f, id=x['manager'], role='FEATURE_MANAGER', connector='fixture', account_key='fixture', native_session_id='fixture-manager', state='RUNNING'))
    t18.insert(f, 'feature_packages', t18.scoped(f, id=x['package'], package_key='fixture-package', wave=1, manager_session_id=x['manager']))
    t18.insert(f, 'hierarchy_packages', t18.scoped(f, package_id=x['package'], feature_key='fixture-package', allocation_policy='FEATURE_STABLE', state='ACTIVE'))
    executable = pathlib.Path(subprocess.check_output(['node', '-p', 'process.execPath'], text=True).strip()).resolve(strict=True)
    proof_check = {'id': 'finding.repaired', 'argv': [str(executable), '--version'], 'executable_digest': sha(executable.read_bytes()), 'timeout_ms': 1000,
                   'required_artifacts': ['fixture/stdout.log'], 'input_keys': ['source', 'dependency', 'toolchain', 'configuration', 'graph', 'contract']}
    accepted, definition = t18.accept_spec(f, proof_check)
    t18.insert(f, 'tasks', t18.scoped(f, id=x['task'], task_key='18.fixture.origin', feature_package_id=x['package'], spec_revision_id=accepted, spec_generation='2', criteria_digest=t18.D, definition=definition, wave=1))
    policy = {'schema_version': 1, 'criteria_digest': t18.D, 'spec_revision_id': accepted, 'spec_generation': '2', 'repository_id': x['repository'], 'source_object_id': q['base'], 'rubric_digest': t18.RUBRIC,
              'checks': [proof_check, dict(proof_check, id='finding.other')], 'clauses': [{'id': '18.1', 'mode': 'EXECUTABLE', 'acceptance_ids': ['V-032'], 'checks': ['finding.repaired', 'finding.other']}],
              'inputs': {name: sha(('fixture-' + name).encode()) for name in ('source', 'dependency', 'toolchain', 'configuration', 'graph', 'contract')}, 'contract_digests': []}
    t18.insert(f, 'proof_registries', t18.scoped(f, task_id=x['task'], spec_generation='2', spec_revision_id=accepted, criteria_digest=t18.D, registry_digest=sha(json.dumps(policy, sort_keys=True, separators=(',', ':')).encode()), policy=policy))
    t18.insert(f, 'attempts', t18.scoped(f, id=x['attempt'], task_id=x['task'], generation='1', authority_epoch=i['epoch'], input_packet_digest=sha(b'fixture-input'), execution_state='SUBMITTED', compute_authority='RELEASED'))
    t18.insert(f, 'artifacts', t18.scoped(f, id=x['artifact'], digest=sha(b'fixture-artifact'), size_bytes='1', storage_backend='fixture', storage_key='finding-evidence', status='COMPLETE', retention_class='RUN'))
    t18.insert(f, 'evidence', t18.scoped(f, id=x['upstream_evidence'], attempt_id=x['attempt'], attempt_generation='1', repository_id=x['repository'], source_object_id=q['upstream'], criteria_digest=t18.D, manifest_digest=sha(b'upstream-manifest'), artifact_id=x['artifact'], admission_state='ADMITTED'))


def observation(f, t18, source, evidence):
    """A watcher's FINDINGS receipt on a discovered obligation for source, and its observation (the 18_1 receipt shape)."""
    i, x = f.ids, f.x
    obligation = f.sql("SELECT o.id,o.watcher_id,w.reviewer_session_id FROM hyperfide.review_obligations o JOIN hyperfide.review_watchers w USING(organisation_id,run_id,policy_digest,watcher_id) WHERE o.organisation_id=$1 AND o.run_id=$2 AND o.source_object_id=$3 ORDER BY o.watcher_id LIMIT 1",
                       [i['organisation'], i['run'], source])
    expect(len(obligation) == 1, 'no watcher obligation for ' + source)
    ob = obligation[0]
    inputs, candidate, receipt = sha(b'trunk-review-inputs' + source.encode()), sha(b'trunk-review-candidate' + source.encode()), uid()
    t18.insert(f, 'review_obligation_inputs', t18.scoped(f, obligation_id=ob['id'], generation='1', input_manifest_digest=inputs, candidate_digest=candidate, snapshot={}))
    t18.insert(f, 'review_receipts', t18.scoped(f, id=receipt, request_id=uid(), request_digest=sha(receipt.encode()), obligation_id=ob['id'], lease_generation='1', generation='1', reviewer_session_id=ob['reviewer_session_id'],
                                                rubric_digest=t18.RUBRIC, input_manifest_digest=inputs, candidate_digest=candidate, outcome='FINDINGS', limitations=[]))
    t18.insert(f, 'review_receipt_evidence', t18.scoped(f, receipt_id=receipt, evidence_id=evidence))
    value = uid()
    t18.insert(f, 'review_observations', t18.scoped(f, id=value, review_receipt_id=receipt, evidence_id=evidence, observer_session_id=ob['reviewer_session_id'], origin_task_id=x['task'], origin_attempt_id=x['attempt'],
                                                    repository_id=x['repository'], source_object_id=source, failure_fingerprint=sha(source.encode()), summary='Trunk finding', severity='ERROR'))
    return value


def scenario(f, t18):
    i, q = f.ids, f.queue
    scope = {'organisation_id': i['organisation'], 'run_id': i['run']}
    trunk_ref = 'refs/hyperfide/trunk/' + i['run']
    origin_before = refs(q['origin'])

    def call(action, payload, component):
        return f.invoke(action, payload, key='operator', component=component, timeout_seconds=120)[1]

    def ok(action, payload, component):
        response = call(action, payload, component)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:1500])
        return response['result']

    def publications():
        return f.sql('SELECT count(*)::int AS n FROM hyperfide.publication_operations WHERE organisation_id=$1 AND run_id=$2', [i['organisation'], i['run']])[0]['n']

    watcher_policy = {'revision': '1', 'mode': 'ALL_COMMITS', 'watchers': [
        {'watcher_id': 'watcher-%d' % n, 'reviewer_session_id': session, 'rubric_digest': t18.RUBRIC, 'review_class': 'semantic', 'path_prefixes': []}
        for n, session in enumerate(i['watchers'])]}
    check('watchers.policy-configured', lambda: ok('review.policy.configure', dict(scope, policy=watcher_policy), '17.1'))
    discover = dict(scope, repository_id=i['repository'])

    def before_fold():
        r = ok('review.commits.discover', discover, '17.1')
        expect(r['discovered'] == 0 and r['complete'] is True and r['rewrites'] == [], r)
        observed = f.sql('SELECT refs FROM hyperfide.review_head_observations WHERE organisation_id=$1 AND run_id=$2 ORDER BY observed_at DESC LIMIT 1', [i['organisation'], i['run']])
        expect(observed and observed[0]['refs'] == {trunk_ref: q['base']}, ('the watcher did not read the unborn trunk at the run base', observed))
    check('watcher.reads-trunk-at-run-base-before-any-fold', before_fold)

    folded = {}

    def fold():
        r = ok('integration.queue.fold', dict(scope, repository_id=i['repository'], custody_ids=[e['custody'] for e in f.entries], ask_deadline_seconds=86400), '19.1-queue')
        expect(len(r['folded']) == 2 and r['pushed'] is False and r['conflicts'] == [], r)
        folded.update(head=text(q['repo'], 'rev-parse', trunk_ref), commits=[x['commit'] for x in r['folded']])
        expect(folded['head'] == r['trunk_after'] == folded['commits'][-1], r)
    check('integrator.folds-onto-internal-trunk', fold)

    def watcher_observes_fold():
        expect(folded, 'no fold')
        expect(publications() == 0 and refs(q['origin']) == origin_before, 'a publication exists or the origin moved before the watcher read the fold')
        r = ok('review.commits.discover', discover, '17.1')
        expect(r['discovered'] == 2 and r['complete'] is True and r['obligations_created'] == 2 * WATCHERS, r)
        discovered = f.sql('SELECT source_object_id FROM hyperfide.review_commits WHERE organisation_id=$1 AND run_id=$2 ORDER BY discovered_at,source_object_id', [i['organisation'], i['run']])
        expect(sorted(x['source_object_id'] for x in discovered) == sorted(folded['commits']), discovered)
        observed = f.sql('SELECT refs FROM hyperfide.review_head_observations WHERE organisation_id=$1 AND run_id=$2 ORDER BY observed_at DESC LIMIT 1', [i['organisation'], i['run']])
        expect(observed[0]['refs'] == {trunk_ref: folded['head']}, observed)
        expect(publications() == 0 and text(q['origin'], 'rev-parse', 'refs/heads/main') == q['base'], 'the protected ref moved')
    check('watcher.observes-internal-fold-before-any-publication', watcher_observes_fold)

    def origin_only_never_discovered():
        rows = f.sql('SELECT 1 FROM hyperfide.review_commits WHERE organisation_id=$1 AND run_id=$2 AND source_object_id=$3', [i['organisation'], i['run'], q['upstream']])
        expect(rows == [] and text(q['repo'], 'rev-parse', 'refs/heads/upstream') == q['upstream'], 'a GitHub-only commit was discovered')
    check('watcher.never-reads-github-only-commit', origin_only_never_discovered)

    def tracking_ref_refused():
        f.stop()
        saved = f.env['HYPERFIDE_REVIEW_REPOSITORIES']
        f.env['HYPERFIDE_REVIEW_REPOSITORIES'] = json.dumps({i['repository']: {'path': str(q['repo']), 'refs': ['refs/remotes/origin/main']}})
        try:
            f.start()
            response = call('review.commits.discover', discover, '17.1')
            expect(response.get('ok') is False and 'REVIEW_CONFIG_INVALID' in json.dumps(response), response)
        finally:
            f.stop()
            f.env['HYPERFIDE_REVIEW_REPOSITORIES'] = saved
            f.start()
    check('watcher.refuses-github-tracking-ref', tracking_ref_refused)

    def finding_on_trunk():
        expect(folded, 'no fold')
        source = folded['commits'][0]
        evidence = uid()
        t18.insert(f, 'evidence', t18.scoped(f, id=evidence, attempt_id=f.x['attempt'], attempt_generation='1', repository_id=i['repository'], source_object_id=source, criteria_digest=t18.D,
                                             manifest_digest=sha(b'trunk-manifest'), artifact_id=f.x['artifact'], admission_state='ADMITTED'))
        r = ok('finding.report', {'observation_id': observation(f, t18, source, evidence), 'resolution_condition': t18.CONDITION, 'collaborator_package_ids': []}, 'finding-registry')
        row = ok('finding.inspect', {'finding_id': r['finding_id']}, 'finding-registry')['finding']
        expect(row['source_object_id'] == source and row['repository_id'] == i['repository'], row)
    check('finding.reads-trunk-commit', finding_on_trunk)

    def finding_off_trunk():
        obs = observation_off_trunk()
        response = call('finding.report', {'observation_id': obs, 'resolution_condition': t18.CONDITION, 'collaborator_package_ids': []}, 'finding-registry')
        expect(response.get('ok') is False and response.get('error', {}).get('code') == 'FINDING_SOURCE_NOT_ON_TRUNK', response)

    def observation_off_trunk():
        # The watcher policy never created an obligation for the GitHub-only commit, so its receipt rides a trunk obligation.
        x = f.x
        ob = f.sql('SELECT o.id,w.reviewer_session_id FROM hyperfide.review_obligations o JOIN hyperfide.review_watchers w USING(organisation_id,run_id,policy_digest,watcher_id) WHERE o.organisation_id=$1 AND o.run_id=$2 AND o.source_object_id=$3 ORDER BY o.watcher_id DESC LIMIT 1',
                   [i['organisation'], i['run'], folded['commits'][1]])[0]
        inputs, candidate, receipt = sha(b'upstream-inputs'), sha(b'upstream-candidate'), uid()
        t18.insert(f, 'review_obligation_inputs', t18.scoped(f, obligation_id=ob['id'], generation='1', input_manifest_digest=inputs, candidate_digest=candidate, snapshot={}))
        t18.insert(f, 'review_receipts', t18.scoped(f, id=receipt, request_id=uid(), request_digest=sha(receipt.encode()), obligation_id=ob['id'], lease_generation='1', generation='1', reviewer_session_id=ob['reviewer_session_id'],
                                                    rubric_digest=t18.RUBRIC, input_manifest_digest=inputs, candidate_digest=candidate, outcome='FINDINGS', limitations=[]))
        value = uid()
        t18.insert(f, 'review_observations', t18.scoped(f, id=value, review_receipt_id=receipt, evidence_id=x['upstream_evidence'], observer_session_id=ob['reviewer_session_id'], origin_task_id=x['task'], origin_attempt_id=x['attempt'],
                                                        repository_id=i['repository'], source_object_id=q['upstream'], failure_fingerprint=sha(b'upstream'), summary='GitHub-only finding', severity='ERROR'))
        return value
    check('finding.refuses-commit-not-on-trunk', finding_off_trunk)

    def direct_push_refused():
        expect(folded, 'no fold')
        pushed = run_git(q['repo'], 'push', '--porcelain', str(q['origin']), folded['head'] + ':refs/heads/main')
        expect(pushed.returncode != 0 and b'PUBLICATION_PERMIT_REQUIRED' in pushed.stderr, pushed.stderr.decode('utf8', 'replace')[-800:])
        forged = run_git(q['repo'], 'push', '--porcelain', '-o', 'hf-permit=forged', str(q['origin']), folded['head'] + ':refs/heads/main')
        expect(forged.returncode != 0 and b'publication gateway rejected' in forged.stderr, forged.stderr.decode('utf8', 'replace')[-800:])
        expect(text(q['origin'], 'rev-parse', 'refs/heads/main') == q['base'] and refs(q['origin']) == origin_before, 'the protected ref advanced outside publication')
    check('protected-ref.advances-only-through-publication', direct_push_refused)

    def internal_ref_refused():
        expect(folded, 'no fold')
        for options in ([], ['-o', 'hf-permit=forged']):
            pushed = run_git(q['repo'], 'push', '--porcelain', *options, str(q['origin']), trunk_ref + ':' + trunk_ref)
            expect(pushed.returncode != 0 and b'PUBLICATION_INTERNAL_REF' in pushed.stderr, pushed.stderr.decode('utf8', 'replace')[-800:])
        expect(refs(q['origin']) == origin_before and publications() == 0, 'an internal ref reached the protected remote')
    check('protected-ref.never-receives-internal-trunk', internal_ref_refused)


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
    for key in [k for k in os.environ if k == 'DATABASE_URL' or k.startswith('HYPERFIDE_') and k.endswith('_DATABASE_URL')]:
        del os.environ[key]
    cluster, fixture, closed = None, None, False
    try:
        cluster = t27.Cluster(binaries)
        cluster.migrate_template()
        os.environ['DATABASE_URL'] = cluster.url()
        import identity_fixture
        t18 = load('hf_case_18_1', 'tests/hyperfide/cases/tasks/18_1.py')
        for attempt in range(3):
            try:
                fixture = identity_fixture.IdentityFixture(extra_components=('3.1', '6.1', '6.2', '1.2-asks', '17.1', '18.1', '19.1-queue'), extra_setup=lambda f: setup(f, t18))
                break
            except AssertionError as error:
                if 'TX_TIMEOUT' not in str(error) or attempt == 2:
                    raise
        scenario(fixture, t18)
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
