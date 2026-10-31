#!/usr/bin/env python3
"""hyperfide-v21 3.6: per-kind Ask policy and decided-by-default records.

On an owned throwaway PostgreSQL cluster (the v21/3_2.py pattern, reusing its seeded run) the control service runs
in HTTPS mode with the 1.2-asks registration. The case reads the per-kind policy table, proves a raise takes its
kind's deadline and escalation chain and may only tighten them, then raises one short-deadline Ask per kind and
expires them all with one human.ask.sweep. Blocking kinds stay waiting and escalate to the operator;
proceed-and-flag kinds take the recommended option and leave an immutable decision record naming the Ask, the
default taken and who would have answered. Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, time, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
COMPONENT = '1.2-asks'
KINDS = ('secret', 'variable', 'permission', 'decision', 'question')
# D11 fixes the policy per kind; 3.6 sets the deadlines and chains (agents/admission.ts ASK_POLICY).
EXPECTED = {'secret': ('block', 86400, ['operator']), 'variable': ('block', 86400, ['operator']),
            'permission': ('block', 14400, ['operator']), 'decision': ('proceed-and-flag', 14400, ['leader', 'operator']),
            'question': ('proceed-and-flag', 3600, ['leader', 'operator'])}
CHOICES = {'secret': ([], None), 'variable': (['1800', '3600'], '3600'), 'permission': (['grant', 'deny'], 'deny'),
           'decision': (['RETAIN', 'DELETE'], 'RETAIN'), 'question': (['yes', 'no'], 'yes')}


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
    print(json.dumps({'type': 'assertion', 'id': 'ask-policy.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def scenario(f):
    i = f.ids
    scope = {'organisation_id': i['organisation'], 'run_id': i['run']}

    def call(action, payload, key='operator', component=COMPONENT):
        return f.invoke(action, payload, key=key, component=component)[1]

    def ok(action, payload, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:800])
        return response['result']

    def refused(action, payload, needle, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is False and needle in json.dumps(response), action + ' was not refused with ' + needle + ': ' + json.dumps(response)[:800])

    def ask(kind, deadline, chain=None, key='worker'):
        options, recommended = CHOICES[kind]
        return {'idempotency_key': uid(), 'kind': kind, 'title': 'Policy ' + kind, 'body': 'A ' + kind + ' for the policy case.',
                'options': options, 'recommended': recommended, 'deadline_seconds': deadline, 'chain': chain, 'task_id': None}

    def sql_refused(statement, values, needle):
        try:
            f.sql(statement, values)
        except AssertionError as error:
            expect(needle in str(error), 'refused for the wrong reason: ' + str(error)[:600])
            return
        raise AssertionError('statement was accepted: ' + statement[:200])

    f.bootstrap_runner()
    f.delegate_principal('worker', i['worker_session'])
    i['operator_consumer'] = uid()
    ok('outbox.consumer.register', dict(scope, id=i['operator_consumer'], consumer_key='operator:asks', critical=False, state='ACTIVE'), component='6.1')

    def table():
        result = ok('human.ask.policy', {}, key='worker')
        kinds = result['kinds']
        expect(sorted(kinds) == sorted(KINDS) and result['policy_revision'], result)
        for kind, (policy, deadline, chain) in EXPECTED.items():
            k = kinds[kind]
            expect((k['default_policy'], k['deadline_seconds'], k['chain']) == (policy, deadline, chain), kind + ' policy differs: ' + json.dumps(k))
            expect(k['answerers'] == [m.upper() for m in chain] and chain[-1] == 'operator', kind + ' answerers or chain end differ: ' + json.dumps(k))
    check('table.per-kind', table)

    defaults = {}

    def policy_defaults():
        for kind in ('secret', 'decision'):
            a = ok('human.ask.raise', ask(kind, None), key='worker')['ask']
            defaults[kind] = a
            seconds = f.sql('SELECT extract(epoch FROM deadline-raised_at)::int AS s FROM hyperfide.asks WHERE id=$1', [a['ask_id']])[0]['s']
            expect(a['default_policy'] == EXPECTED[kind][0] and a['chain'] == EXPECTED[kind][2] and seconds == EXPECTED[kind][1],
                   kind + ' did not take its policy deadline and chain: ' + json.dumps(a) + ' ' + str(seconds))
    check('raise.takes-policy-deadline-and-chain', policy_defaults)
    check('raise.caller-tightens-deadline', lambda: expect(
        ok('human.ask.raise', ask('question', 60, ['leader', 'operator']), key='worker')['ask']['chain'] == ['leader', 'operator'], 'tightened raise refused'))
    check('refuse.deadline-beyond-policy', lambda: refused('human.ask.raise', ask('question', 3601), 'exceeds the question policy deadline', key='worker'))
    check('refuse.chain-not-ending-at-operator', lambda: refused('human.ask.raise', ask('decision', 60, ['operator', 'leader']), 'must end at the operator', key='worker'))
    check('refuse.chain-unknown-member', lambda: refused('human.ask.raise', ask('decision', 60, ['intern', 'operator']), 'unknown member', key='worker'))
    check('refuse.proceed-without-recommended', lambda: refused('human.ask.raise', dict(ask('question', 60), options=[], recommended=None), 'needs a recommended option', key='worker'))
    check('refuse.leader-answers-secret', lambda: refused('human.ask.answer', {'ask_id': defaults['secret']['ask_id'], 'expected_state_version': '1', 'answer': 'secret-ref:x'}, 'cannot answer', key='leader'))

    raised = {}

    def one_per_kind():
        for kind in KINDS:
            raised[kind] = ok('human.ask.raise', ask(kind, 2), key='worker')['ask']
            expect(raised[kind]['default_policy'] == EXPECTED[kind][0], raised[kind])
    check('raise.one-per-kind', one_per_kind)
    check('refuse.worker-sweeps', lambda: refused('human.ask.sweep', {'limit': 10}, 'cannot perform', key='worker'))
    ids = [raised[k]['ask_id'] for k in KINDS if k in raised]
    for _ in range(100):
        if f.sql('SELECT count(*)::int AS n FROM hyperfide.asks WHERE id = ANY($1::uuid[]) AND clock_timestamp()>=deadline', [ids])[0]['n'] == len(KINDS):
            break
        time.sleep(0.1)

    swept = {}

    def sweep():
        result = ok('human.ask.sweep', {'limit': 50}, key='operator')
        by_id = {item['ask']['ask_id']: item for item in result['expired']}
        expect(sorted(by_id) == sorted(ids) and result['decided_by_default'] == 2 and result['truncated'] is False,
               'sweep did not expire exactly the due Asks: ' + json.dumps(result)[:1200])
        for kind in KINDS:
            swept[kind] = by_id[raised[kind]['ask_id']]
    check('sweep.expires-every-due-ask', sweep)

    def blocking(kind):
        def run():
            item = swept[kind]
            a = item['ask']
            expect(a['state'] == 'EXPIRED' and a['answer'] is None and item['decided_by_default'] is False
                   and item['escalated_to'] == 'operator' and 'decision' not in item, kind + ' blocking outcome wrong: ' + json.dumps(item))
        return run

    def proceeded(kind):
        def run():
            item = swept[kind]
            a, d = item['ask'], item['decision']
            expect(a['state'] == 'EXPIRED' and a['answer'] == CHOICES[kind][1] and item['decided_by_default'] is True, kind + ' default not taken: ' + json.dumps(item))
            expect(d['ask_id'] == a['ask_id'] and d['default_taken'] == CHOICES[kind][1] and d['would_have_answered'] == EXPECTED[kind][2]
                   and d['kind'] == kind and d['options'] == CHOICES[kind][0] and d['task'] == i['task'] and d['attempt'] == i['attempt']
                   and d['ask_state_version'] == '2' and d['decided_by'] == i['operator'], kind + ' decision record wrong: ' + json.dumps(d))
            rows = f.sql('SELECT id::text,default_taken,would_have_answered FROM hyperfide.ask_default_decisions WHERE ask_id=$1', [a['ask_id']])
            expect(rows == [{'id': d['decision_id'], 'default_taken': CHOICES[kind][1], 'would_have_answered': EXPECTED[kind][2]}], rows)
            event = f.sql("SELECT payload FROM hyperfide.outbox_events WHERE id=$1 AND event_type='ask.expired'", [item['event_id']])
            expect(len(event) == 1 and event[0]['payload']['decision']['decision_id'] == d['decision_id'], 'ask.expired did not carry the decision: ' + json.dumps(event)[:600])
        return run

    for kind in KINDS:
        check('expire.' + kind, blocking(kind) if EXPECTED[kind][0] == 'block' else proceeded(kind))
    check('records.only-proceed-and-flag', lambda: expect(
        f.sql('SELECT count(*)::int AS n FROM hyperfide.ask_default_decisions WHERE ask_id = ANY($1::uuid[])', [ids])[0]['n'] == 2, 'blocking Asks left decision records'))
    check('sweep.idempotent', lambda: expect(ok('human.ask.sweep', {'limit': 50})['expired'] == [], 'second sweep expired again'))
    check('open.long-deadlines-untouched', lambda: expect(
        all(a['state'] == 'OPEN' for a in (f.sql('SELECT state FROM hyperfide.asks WHERE id = ANY($1::uuid[])', [[defaults[k]['ask_id'] for k in defaults]]))), 'a not-yet-due Ask expired'))
    check('answer.blocking-late', lambda: expect(ok('human.ask.answer', {'ask_id': raised['variable']['ask_id'], 'expected_state_version': '2', 'answer': '1800'})['ask']['state'] == 'ANSWERED', 'late answer refused'))
    check('refuse.answer-defaulted', lambda: refused('human.ask.answer', {'ask_id': raised['decision']['ask_id'], 'expected_state_version': '2', 'answer': 'DELETE'}, 'default was taken'))
    check('record.immutable', lambda: sql_refused('UPDATE hyperfide.ask_default_decisions SET default_taken=$1 WHERE ask_id=$2', ['DELETE', raised['decision']['ask_id']], 'immutable'))
    check('record.forged-for-blocking-ask', lambda: sql_refused(
        "INSERT INTO hyperfide.ask_default_decisions(organisation_id,run_id,id,ask_id,ask_state_version,kind,title,default_taken,options,would_have_answered,policy_revision,deadline,decided_by) "
        "SELECT organisation_id,run_id,$2,id,state_version,'decision',title,'grant',options,chain,'forged',deadline,$3 FROM hyperfide.asks WHERE id=$1",
        [raised['permission']['ask_id'], uid(), i['operator']], 'must name an Ask that expired by taking that default'))


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
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', COMPONENT), extra_setup=t32.setup)
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
