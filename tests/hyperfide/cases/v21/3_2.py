#!/usr/bin/env python3
"""hyperfide-v21 3.2: raise and answer Asks for operators.

On an owned throwaway PostgreSQL cluster (the v21/2_7.py pattern) the control service runs in HTTPS mode on the
real identity path with the 1.2-asks registration. A WORKER principal delegated by an enrolled runner raises Asks;
the operator lists and answers them; every change is delivered to the run's operator consumer (operator:asks) and
not to the leader's session consumer; the leader sees the same Asks through human.ask.list. Expiry takes the
recommended default for proceed-and-flag and keeps a blocking Ask waiting for a late answer. Prints SKIP and
exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, time, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
ASK_ACTIONS = ['human.ask.answer', 'human.ask.expire', 'human.ask.list', 'human.ask.raise']
FAILED = []
COMPONENT = '1.2-asks'


def uid():
    return str(uuid.uuid4())


def expect(value, message):
    if not value:
        raise AssertionError(message)


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        actual = type(error).__name__ + ': ' + str(error)[:1500]
        FAILED.append(name)
    print(json.dumps({'type': 'assertion', 'id': 'ask.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setup(f):
    """Seed a task with a current implementation attempt in the fixture sandbox, its WORKER session, and a LEADER."""
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    for key in ('package', 'task', 'slot', 'attempt', 'worker_session', 'leader'):
        i[key] = uid()
    digest = 'sha256:' + 'a' * 64
    f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'asks',1)", [o, r, i['package']])
    f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,'3.2',$4,$5,$6,'{}',1)",
          [o, r, i['task'], i['package'], i['spec'], digest])
    f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind) VALUES($1,$2,$3,'asks',1,'AGENT')", [o, i['slot'], i['sandbox']])
    f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) "
          "VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '30 minutes')",
          [o, r, i['attempt'], i['task'], i['epoch'], digest, i['sandbox'], i['slot']])
    f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,state) VALUES($1,$2,$3,'LEADER','fixture','fixture','native-leader','RUNNING')",
          [o, r, i['leader']])
    f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) "
          "VALUES($1,$2,$3,'WORKER',$4,'fixture','fixture','native-worker',$5,$6,1,$7,'RUNNING')",
          [o, r, i['worker_session'], i['leader'], i['slot'], i['sandbox'], i['attempt']])
    path = f.path / 'leader.pem'
    subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(path)], check=True, capture_output=True)
    path.chmod(0o600)
    public = subprocess.check_output(['openssl', 'pkey', '-in', str(path), '-pubout', '-outform', 'DER'], stderr=subprocess.DEVNULL)
    import identity_fixture
    f.keys['leader'] = {'path': path, 'public_key_b64': identity_fixture.b64(public[-32:])}
    identity = json.loads(f.identity_config.read_text())
    record = dict(identity['principals'][0], credential_id=i['leader'], actor_id=i['leader'], role='LEADER', public_key_b64=f.keys['leader']['public_key_b64'])
    f.seed_fixture_principal(record)
    identity['principals'].append(record)
    f.identity_config.write_text(json.dumps(identity))
    # The leader's private session consumer exists so the case can prove Asks do not ride on it.
    i['leader_consumer'] = uid()
    f.sql('INSERT INTO hyperfide.event_consumers(organisation_id,run_id,id,consumer_key) VALUES($1,$2,$3,$4)', [o, r, i['leader_consumer'], 'session:' + i['leader'] + ':human_intent'])


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

    def ask(kind, options, recommended, deadline, key='worker', chain=('leader', 'operator')):
        return {'idempotency_key': uid(), 'kind': kind, 'title': 'Need a ' + kind, 'body': 'The ' + kind + ' the task cannot derive.',
                'options': options, 'recommended': recommended, 'deadline_seconds': deadline, 'chain': list(chain), 'task_id': None}

    def deliveries(event):
        return [r['consumer_id'] for r in f.sql('SELECT consumer_id FROM hyperfide.event_deliveries WHERE event_id=$1 ORDER BY consumer_id', [event])]

    def listed(key, state=None):
        return {a['ask_id']: a for a in ok('human.ask.list', {'state': state, 'limit': 100}, key=key)['asks']}

    def shipped():
        for role in ('control', 'dispatch', 'provisioner'):
            allowed = json.loads((ROOT / 'deploy/hyperfide/policies' / (role + '.example.json')).read_text())['allowed_actions']
            expect(all(a in allowed for a in ASK_ACTIONS), role + ' policy lacks the ask actions')
    check('policy.every-shipped-policy', shipped)

    # Before the operator channel exists a raise is refused rather than parked unseen.
    def no_channel():
        f.bootstrap_runner()
        f.delegate_principal('worker', i['worker_session'])
        refused('human.ask.raise', ask('question', ['yes', 'no'], 'yes', 3600), 'ASK_OPERATOR_CONSUMER_REQUIRED', key='worker')
    check('raise.refused-without-operator-channel', no_channel)

    i['operator_consumer'] = uid()
    check('operator-channel.leader-cannot-register', lambda: refused('outbox.consumer.register', dict(scope, id=uid(), consumer_key='operator:asks', critical=False, state='BUFFERING'), 'AUTH_ROLE_DENIED', key='leader', component='6.1'))
    # The run has produced no events yet, so 6.1 admits the operator channel ACTIVE without a snapshot bootstrap.
    check('operator-channel.registered', lambda: ok('outbox.consumer.register', dict(scope, id=i['operator_consumer'], consumer_key='operator:asks', critical=False, state='ACTIVE'), component='6.1'))

    request = ask('question', ['yes', 'no'], 'yes', 3600)
    raised = {}

    def raise_from_worker():
        result = ok('human.ask.raise', request, key='worker')
        raised['question'] = result
        a = result['ask']
        worker = f.ids['worker']
        expect(result['status'] == 'RAISED' and a['state'] == 'OPEN' and a['state_version'] == '1' and a['default_policy'] == 'proceed-and-flag', result)
        expect(a['task'] == i['task'] and a['attempt'] == i['attempt'] and a['session'] == i['worker_session'] and a['sandbox'] == i['sandbox']
               and a['raised_by'] == worker and a['chain'] == ['leader', 'operator'] and a['deadline'], 'worker references not derived: ' + json.dumps(a))
    check('raise.worker-attributed', raise_from_worker)
    check('raise.idempotent-replay', lambda: expect(ok('human.ask.raise', request, key='worker')['ask']['ask_id'] == raised['question']['ask']['ask_id'], 'replay raised a second Ask'))
    check('raise.conflicting-replay', lambda: refused('human.ask.raise', dict(request, title='changed'), 'already bound', key='worker'))

    def operator_delivery():
        event = raised['question']['event_id']
        expect(raised['question']['operator_consumer_id'] == i['operator_consumer'], 'wrong operator consumer')
        expect(deliveries(event) == [i['operator_consumer']], 'ask.raised not delivered only to the operator consumer: ' + json.dumps(deliveries(event)))
        claimed = ok('outbox.claim', dict(scope, consumer_id=i['operator_consumer'], limit=64, lease_ms=60000), component='6.1')
        mine = [c for c in claimed if c['id'] == event]
        expect(len(mine) == 1 and mine[0]['event_type'] == 'ask.raised' and mine[0]['aggregate_type'] == 'ask'
               and mine[0]['payload']['ask']['ask_id'] == raised['question']['ask']['ask_id'], 'operator claim missed the Ask: ' + json.dumps(claimed)[:800])
    check('delivery.operator-consumer', operator_delivery)
    check('delivery.not-leader-consumer', lambda: expect(not f.sql('SELECT 1 FROM hyperfide.event_deliveries WHERE consumer_id=$1', [i['leader_consumer']]), 'an Ask rode on the leader session consumer'))

    for kind, options, recommended, deadline in (('variable', ['1800', '3600'], '3600', None), ('secret', [], None, None),
                                                 ('decision', ['RETAIN', 'DELETE'], 'RETAIN', 2), ('permission', ['grant', 'deny'], 'deny', 2)):
        def raise_kind(kind=kind, options=options, recommended=recommended, deadline=deadline):
            result = ok('human.ask.raise', ask(kind, options, recommended, deadline), key='worker')
            expect(result['ask']['default_policy'] == ('proceed-and-flag' if kind == 'decision' else 'block'), result)
            raised[kind] = result
        check('raise.' + kind, raise_kind)
    # 3.6: the deadline now comes from the kind's policy table, so a proceed-and-flag Ask is refused only without a recommended option.
    check('refuse.proceed-without-recommended', lambda: refused('human.ask.raise', ask('decision', [], None, None), 'needs a recommended option', key='worker'))
    check('refuse.unknown-kind', lambda: refused('human.ask.raise', ask('wish', [], None, None), 'kind is unknown', key='worker'))
    check('refuse.caller-default-policy', lambda: refused('human.ask.raise', dict(ask('secret', [], None, None), default_policy='proceed-and-flag'), 'fields are invalid', key='worker'))
    check('refuse.recommended-outside-options', lambda: refused('human.ask.raise', ask('decision', ['a', 'b'], 'c', 60), 'recommended', key='worker'))
    check('refuse.foreign-task', lambda: refused('human.ask.raise', dict(ask('question', ['y'], 'y', 60), task_id=uid()), "attempt's task", key='worker'))

    leader_ask = {}
    check('raise.leader', lambda: leader_ask.update(ok('human.ask.raise', ask('question', ['go', 'wait'], 'go', 3600), key='leader')))

    def operator_list():
        rows = listed('operator', 'OPEN')
        ids = {raised[k]['ask']['ask_id'] for k in raised} | {leader_ask['ask']['ask_id']}
        expect(ids <= set(rows) and all(rows[x]['state'] == 'OPEN' for x in ids), 'operator list missed open Asks')
    check('list.operator-sees-run', operator_list)
    check('list.leader-view', lambda: expect(raised['question']['ask']['ask_id'] in listed('leader'), "the leader's view lacks the worker Ask"))
    check('list.worker-own-only', lambda: expect(raised['question']['ask']['ask_id'] in listed('worker') and leader_ask['ask']['ask_id'] not in listed('worker'), 'worker list not scoped to its own Asks'))

    def answer(kind, value, key='operator', version='1'):
        return {'ask_id': raised[kind]['ask']['ask_id'], 'expected_state_version': version, 'answer': value}

    check('refuse.worker-answers', lambda: refused('human.ask.answer', answer('variable', '1800'), 'cannot answer', key='worker'))
    check('refuse.leader-answers-variable', lambda: refused('human.ask.answer', answer('variable', '1800'), 'cannot answer', key='leader'))
    check('refuse.stale-version', lambda: refused('human.ask.answer', answer('variable', '1800', version='2'), 'changed since it was read'))
    check('refuse.secret-value', lambda: refused('human.ask.answer', answer('secret', 'hunter2'), 'secret-ref'))
    check('refuse.choice-outside-options', lambda: refused('human.ask.answer', answer('permission', 'maybe'), 'one of the offered options'))

    def operator_answers():
        result = ok('human.ask.answer', answer('variable', '1800'))
        a = result['ask']
        expect(a['state'] == 'ANSWERED' and a['answer'] == '1800' and a['answered_by'] == i['operator'] and a['state_version'] == '2', result)
        expect(deliveries(result['event_id']) == [i['operator_consumer']], 'ask.answered not delivered to the operator consumer')
        event = f.sql('SELECT event_type,aggregate_version::text v FROM hyperfide.outbox_events WHERE id=$1', [result['event_id']])
        expect(event == [{'event_type': 'ask.answered', 'v': '2'}], event)
        seen = listed('leader')[a['ask_id']]
        expect(seen['state'] == 'ANSWERED' and seen['answer'] == '1800', "the leader's view did not see the answer")
        history = f.sql('SELECT event_type,actor FROM hyperfide.ask_events WHERE ask_id=$1 ORDER BY state_version', [a['ask_id']])
        expect(history == [{'event_type': 'RAISED', 'actor': f.ids['worker']}, {'event_type': 'ANSWERED', 'actor': i['operator']}], history)
    check('answer.operator-delivered-and-leader-view', operator_answers)
    check('refuse.reanswer', lambda: refused('human.ask.answer', answer('variable', '3600', version='2'), 'already answered'))
    check('answer.secret-ref', lambda: expect(ok('human.ask.answer', answer('secret', 'secret-ref:railway.token'))['ask']['answer'] == 'secret-ref:railway.token', 'secret ref not stored'))
    check('answer.leader-question', lambda: expect(ok('human.ask.answer', {'ask_id': leader_ask['ask']['ask_id'], 'expected_state_version': '1', 'answer': 'wait'}, key='leader')['ask']['answered_by'] == i['leader'], 'leader could not settle a question'))

    def expire(kind, key='operator'):
        return ok('human.ask.expire', {'ask_id': raised[kind]['ask']['ask_id'], 'expected_state_version': '1'}, key=key)

    check('refuse.early-expiry', lambda: refused('human.ask.expire', {'ask_id': raised['question']['ask']['ask_id'], 'expected_state_version': '1'}, 'deadline has not passed'))
    check('refuse.worker-expires', lambda: refused('human.ask.expire', {'ask_id': raised['decision']['ask']['ask_id'], 'expected_state_version': '1'}, 'cannot perform', key='worker'))
    for _ in range(100):
        due = f.sql('SELECT count(*)::int AS n FROM hyperfide.asks WHERE id = ANY($1::uuid[]) AND clock_timestamp()>=deadline',
                    [[raised['decision']['ask']['ask_id'], raised['permission']['ask']['ask_id']]])
        if due[0]['n'] == 2:
            break
        time.sleep(0.1)

    def default_taken():
        result = expire('decision')
        a = result['ask']
        expect(result['decided_by_default'] is True and a['state'] == 'EXPIRED' and a['answer'] == 'RETAIN' and a['answered_by'] is None, result)
        expect(deliveries(result['event_id']) == [i['operator_consumer']], 'ask.expired not delivered to the operator consumer')
        refused('human.ask.answer', {'ask_id': a['ask_id'], 'expected_state_version': '2', 'answer': 'DELETE'}, 'default was taken')
    check('expire.proceed-and-flag-takes-default', default_taken)

    def blocking_waits():
        result = expire('permission', key='leader')
        a = result['ask']
        expect(result['decided_by_default'] is False and a['state'] == 'EXPIRED' and a['answer'] is None, result)
        late = ok('human.ask.answer', {'ask_id': a['ask_id'], 'expected_state_version': '2', 'answer': 'grant'})
        expect(late['ask']['state'] == 'ANSWERED' and late['ask']['answer'] == 'grant' and late['ask']['state_version'] == '3' and late['ask']['expired_at'], late)
    check('expire.blocking-answered-late', blocking_waits)

    def history_complete():
        mine = f.sql("SELECT count(*)::int AS n FROM hyperfide.outbox_events WHERE aggregate_type='ask'")[0]['n']
        versions = f.sql('SELECT coalesce(sum(state_version),0)::int AS n FROM hyperfide.asks')[0]['n']
        expect(mine == versions, 'every Ask state_version needs exactly one delivered event: %s events, %s versions' % (mine, versions))
    check('delivery.one-event-per-version', history_complete)


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
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', COMPONENT), extra_setup=setup)
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
