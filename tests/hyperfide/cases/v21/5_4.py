#!/usr/bin/env python3
"""hyperfide-v21 5.4: the three numbers (req 5 ac_3).

On an owned throwaway PostgreSQL cluster (the v21/3_6.py pattern, reusing the 3_2 seeded run) the control service
runs in HTTPS mode with the 23.3 metrics and 1.2-asks registrations. The case reads fleet.metrics.numbers before any
seeding (no answered Ask and no materialisation are UNKNOWN, never zero), then seeds a run with known values:
eight tasks, two proceed-and-flag Asks taken by default through the real human.ask.sweep (a blocking Ask swept with
them adds no decision), human answers with fixed raise-to-answer durations, and slice materialisation records with
known disk bytes on two sandboxes (FK triggers suspended only for that seeding, as in 2_12.py). It asserts the three
numbers exactly and that rows of other runs, org-scoped Asks, unanswered Asks and non-READY materialisations never
count. Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
METRICS = '23.3'
ASKS = '1.2-asks'
ANSWER_SECONDS = (30, 90, 600, 7200)  # human answers; the swept blocking Ask is answered late at 110 s
LATE_SECONDS = 110


def uid():
    return str(uuid.uuid4())


def expect(value, message):
    if not value:
        raise AssertionError(message if isinstance(message, str) else json.dumps(message, default=str)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)[:1500]
        FAILED.append(name)
    print(json.dumps({'type': 'assertion', 'id': 'three-numbers.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def literal(value):
    return 'NULL' if value is None else "'" + str(value).replace("'", "''") + "'"


def scenario(f):
    i = f.ids
    o, r, op = i['organisation'], i['run'], i['operator']
    scope = {'organisation_id': o, 'run_id': r}

    def call(action, payload, component):
        return f.invoke(action, payload, key='operator', component=component)[1]

    def ok(action, payload, component):
        response = call(action, payload, component)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:800])
        return response['result']

    def three():
        return ok('fleet.metrics.numbers', {}, METRICS)['numbers']

    def unseeded():
        n = three()
        d, a, b = n['decisions_by_default_per_hundred_tasks'], n['median_ask_to_answer_seconds'], n['bytes_materialised_per_sandbox']
        expect(d['status'] == 'AVAILABLE' and d['value'] == '0' and d['tasks'] == '1' and d['decisions_by_default'] == '0', d)
        expect(a['status'] == 'UNKNOWN' and a['value'] is None and a['reason'] == 'NO_ANSWERED_ASKS' and a['answered_asks'] == '0', a)
        expect(b['status'] == 'UNKNOWN' and b['value'] is None and b['reason'] == 'NO_MEASURED_MATERIALISATIONS' and b['sandboxes'] == '0', b)
    check('unseeded.unknown-not-zero', unseeded)

    def refuses_input():
        response = call('fleet.metrics.numbers', {'run_id': r}, METRICS)
        expect(response.get('ok') is False and 'OBSERVABILITY_INPUT_INVALID' in json.dumps(response), response)
    check('refuse.unknown-input', refuses_input)

    # ---- seed: eight tasks in the run
    for n in range(7):
        f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$4,$5,$6,$7,'{}',1)",
              [o, r, uid(), '5.4.' + str(n), i['package'], i['spec'], 'sha256:' + 'a' * 64])

    # ---- seed Asks: two proceed-and-flag past their deadline, one blocking past its deadline, one open
    def raise_ask(kind, policy, options, recommended, deadline_sql, raised_sql, run=r):
        ask = uid()
        f.sql('INSERT INTO hyperfide.asks(organisation_id,id,run_id,kind,title,options,recommended,deadline,default_policy,chain,raised_by,raised_at) '
              "VALUES($1,$2,$3,$4,$5,$6::jsonb,$7," + deadline_sql + ",$8,'[\"leader\",\"operator\"]'::jsonb,$9," + raised_sql + ')',
              [o, ask, run, kind, 'Seeded ' + kind, json.dumps(options), recommended, policy, op])
        return ask
    past = "clock_timestamp()-interval '60 seconds'"
    defaulted = [raise_ask('decision', 'proceed-and-flag', ['A', 'B'], 'A', past, "clock_timestamp()-interval '120 seconds'") for _ in range(2)]
    blocked = raise_ask('permission', 'block', ['grant', 'deny'], 'deny', past, "clock_timestamp()-interval '120 seconds'")
    open_ask = raise_ask('question', 'proceed-and-flag', ['yes', 'no'], 'yes', "clock_timestamp()+interval '1 hour'", 'clock_timestamp()')
    ok('outbox.consumer.register', dict(scope, id=uid(), consumer_key='operator:asks', critical=False, state='ACTIVE'), '6.1')

    def sweep():
        result = ok('human.ask.sweep', {'limit': 50}, ASKS)
        expect(sorted(x['ask']['ask_id'] for x in result['expired']) == sorted(defaulted + [blocked]) and result['decided_by_default'] == 2, result)
        rows = f.sql('SELECT ask_id::text FROM hyperfide.ask_default_decisions WHERE organisation_id=$1 AND run_id=$2', [o, r])
        expect(sorted(x['ask_id'] for x in rows) == sorted(defaulted), rows)
    check('seed.sweep-takes-two-defaults', sweep)

    def answer(ask, seconds):
        f.sql("UPDATE hyperfide.asks SET state='ANSWERED',answer=$2,answered_by=$3,answered_at=raised_at+make_interval(secs=>$4),state_version=state_version+1 WHERE id=$1",
              [ask, 'deny' if ask == blocked else 'yes', op, seconds])
    answer(blocked, LATE_SECONDS)
    for seconds in ANSWER_SECONDS:
        answer(raise_ask('question', 'block', ['yes', 'no'], 'yes', 'NULL', "clock_timestamp()-interval '3 hours'"), seconds)
    # An org-scoped Ask answered in one second belongs to no run and must not move the run's median.
    answer(raise_ask('question', 'block', ['yes', 'no'], 'yes', 'NULL', "clock_timestamp()-interval '3 hours'", run=None), 1)

    # ---- seed materialisations: written straight into the 2.12 table with FK triggers suspended (2_12.py pattern)
    s1, s2, slot, other_run = i['sandbox'], uid(), i['slot'], uid()
    slice_digest, head = 'sha256:' + 'b' * 64, 'a' * 40
    ready = [(s1, 1000, 400), (s1, 3000, 1000), (s2, 5000, 2000)]
    rows, first = [], None

    def row(run, sandbox, outcome, evidence, reason=None, released=None):
        mid = uid()
        rows.append('(' + ','.join(literal(v) for v in (o, run, mid, slice_digest, sandbox, slot)) + ',1,' + ','.join(literal(v) for v in (
            outcome, reason, released, head if outcome == 'READY' else None, json.dumps(evidence), 'sha256:' + 'c' * 64, op)) + ')')
        return mid
    for sandbox, disk, worktree in ready:
        mid = row(r, sandbox, 'READY', {'schema_version': 1, 'metrics': {'disk_bytes': disk, 'worktree_bytes': worktree, 'git_dir_bytes': disk - worktree}})
        first = first or mid
    row(r, s2, 'READY', {'schema_version': 1})  # a READY row with no measurement is counted as unmeasured, never as zero bytes
    row(r, s1, 'FAILED', {'schema_version': 1, 'metrics': {'disk_bytes': 777777, 'worktree_bytes': 1}}, reason='SLICE_MATERIALISATION_FAILED')
    row(r, s1, 'RELEASED', {'schema_version': 1, 'metrics': {'disk_bytes': 888888, 'worktree_bytes': 1}}, released=first)
    row(other_run, s2, 'READY', {'schema_version': 1, 'metrics': {'disk_bytes': 999999, 'worktree_bytes': 999999}})
    f.sql("BEGIN; SET LOCAL session_replication_role=replica; INSERT INTO hyperfide.workspace_slice_materialisations(organisation_id,run_id,id,slice_digest,sandbox_id,slot_id,sandbox_boot_generation,"
          "outcome,reason,released_materialisation_id,verified_head,evidence,evidence_digest,created_by_credential_id) VALUES " + ','.join(rows) + '; COMMIT', [], serial=False)

    numbers = {}

    def read():
        numbers.update(three())
    check('seeded.read', read)

    def decisions():
        d = numbers['decisions_by_default_per_hundred_tasks']
        expect(d['status'] == 'AVAILABLE' and d['value'] == '25' and d['decisions_by_default'] == '2' and d['tasks'] == '8', d)
    check('decisions-by-default-per-hundred-tasks', decisions)

    def median():
        a = numbers['median_ask_to_answer_seconds']
        durations = sorted(ANSWER_SECONDS + (LATE_SECONDS,))
        expect(a['status'] == 'AVAILABLE' and a['value'] == str(durations[len(durations) // 2]) and a['answered_asks'] == str(len(durations)), a)
        expect(a['fastest_seconds'] == '30' and a['slowest_seconds'] == '7200' and a['waiting_asks'] == '1' and a['decided_by_default_asks'] == '2', a)
    check('median-ask-to-answer-seconds', median)

    def even_median():
        # A sixth answer makes the count even: the median is the mean of the two middle durations (110 and 600).
        answer(raise_ask('question', 'block', ['yes', 'no'], 'yes', 'NULL', "clock_timestamp()-interval '3 hours'"), 9000)
        a = three()['median_ask_to_answer_seconds']
        expect(a['value'] == '355' and a['answered_asks'] == '6', a)
    check('median-even-count-interpolates', even_median)

    def materialised():
        b = numbers['bytes_materialised_per_sandbox']
        expect(b['status'] == 'AVAILABLE' and b['value'] == '4500' and b['worktree_bytes_per_sandbox'] == '1700' and b['sandboxes'] == '2', b)
        expect(b['materialisations'] == '3' and b['unmeasured_ready_materialisations'] == '1' and b['total_disk_bytes'] == '9000', b)
        per = {x['sandbox_id']: x for x in b['per_sandbox']}
        expect(sorted(per) == sorted([s1, s2]) and per[s1]['disk_bytes'] == '4000' and per[s2]['disk_bytes'] == '5000' and b['per_sandbox_truncated'] is False, b)
    check('bytes-materialised-per-sandbox', materialised)

    def describe():
        d = ok('fleet.metrics.describe', {}, METRICS)
        expect(d['human_numbers'] == ['decisions_by_default_per_hundred_tasks', 'median_ask_to_answer_seconds', 'bytes_materialised_per_sandbox'], d)
    check('describe-lists-the-three', describe)


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
    t32 = load('hf_case_v21_3_2', 'tests/hyperfide/cases/v21/3_2.py')
    stamp = subprocess.run(['node', str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(SERVICE)], cwd=ROOT, capture_output=True, text=True)
    if stamp.returncode:
        build = subprocess.run(['npm', '--prefix', str(SERVICE), 'run', 'build'], cwd=ROOT, capture_output=True, text=True, timeout=900)
        if build.returncode:
            print('service build failed: ' + (build.stderr + build.stdout)[-1500:], file=sys.stderr)
            return 1
    # Only the owned cluster is reachable: never let an inherited database URL redirect the probe.
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
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', ASKS, '23.1', METRICS), extra_setup=t32.setup)
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
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
