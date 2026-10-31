#!/usr/bin/env python3
"""hyperfide-v21 4.5: notification producers and the operator target.

On an owned throwaway PostgreSQL cluster (the v21/3_2.py pattern) the control service runs in HTTPS mode with the
1.2-asks and 4.5-operator registrations and HYPERFIDE_OPERATOR_WEBHOOK_URL pointing at a stub webhook on loopback.
Real Asks are raised, answered and expired through human.ask.*; a finding.repair-escalated source event and capacity
attestations are seeded as the records their owners write. The producers must create exactly one operator notice per
Ask raised, Ask expired, repair escalated and attestation entering the expiry window, and none for other events; the
target must deliver each to the webhook, retry a failed send after backoff, and never leak the webhook URL or
credential-shaped text. Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import http.server, importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, threading, time, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'core/control-plane'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
OPERATOR = '4.5-operator'
ASKS = '1.2-asks'
OPERATOR_ACTIONS = ['fleet.notifications.operator.deliver', 'fleet.notifications.operator.describe', 'fleet.notifications.operator.list', 'fleet.notifications.operator.produce']
WEBHOOK_SECRET_PATH = 'hook-path-' + uuid.uuid4().hex
FAILED = []


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
    print(json.dumps({'type': 'assertion', 'id': 'notify.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Webhook:
    """A loopback receiver that records every POST and fails the next N on request."""

    def __init__(self):
        self.received, self.fail_next, self.lock = [], 0, threading.Lock()
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
                with owner.lock:
                    status = 500 if owner.fail_next > 0 else 204
                    owner.fail_next = max(0, owner.fail_next - 1)
                    owner.received.append({'path': self.path, 'headers': {k.lower(): v for k, v in self.headers.items()}, 'body': json.loads(body), 'status': status})
                self.send_response(status)
                self.end_headers()

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = 'http://127.0.0.1:%d/%s' % (self.server.server_address[1], WEBHOOK_SECRET_PATH)

    def accepted(self):
        with self.lock:
            return [r for r in self.received if r['status'] == 204]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def seed_sources(f):
    """Capacity attestations as providers/pools.ts records them, and finding events as findings/registry.ts emits them."""
    i, o, r = f.ids, f.ids['organisation'], f.ids['run']
    digest = 'sha256:' + 'c' * 64
    i['artifact'], i['attestation_soon'], i['attestation_later'] = uid(), uid(), uid()
    f.sql("INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document,active) VALUES($1,$2,$3,'{}',true)", [o, i['pool'], digest])
    f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,1,'COMPONENT_FIXTURE','attestation','COMPLETE',clock_timestamp())",
          [o, r, i['artifact'], digest])
    for key, dimension, days in (('attestation_soon', 'sandboxes', 1), ('attestation_later', 'cpu_millis', 20)):
        declaration = {'scope_kind': 'POOL', 'scope_key': i['pool'], 'dimension': dimension, 'limit': '10'}
        f.sql("INSERT INTO hyperfide.provider_capacity_attestations(organisation_id,id,pool_id,configuration_digest,provenance_run_id,provenance_artifact_id,provenance_digest,declaration_digest,declaration,declared_at,expires_at) "
              "VALUES($1,$2,$3,$4,$5,$6,$4,$7,$8::jsonb,clock_timestamp()-interval '1 day',clock_timestamp()+make_interval(days=>$9))",
              [o, i[key], i['pool'], digest, r, i['artifact'], 'sha256:' + ('d' if days == 1 else 'e') * 64, json.dumps(declaration), days])
    i['finding'], i['repair'], i['escalated_event'], i['failed_event'] = uid(), uid(), uid(), uid()
    for event, kind, version in ((i['failed_event'], 'finding.repair-failed', 1), (i['escalated_event'], 'finding.repair-escalated', 2)):
        f.sql("INSERT INTO hyperfide.outbox_events(organisation_id,run_id,id,aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,'finding',$4,$5,$6,$7::jsonb)",
              [o, r, event, i['finding'], version, kind, json.dumps({'finding_id': i['finding'], 'repair_id': i['repair'], 'reason': 'verify_cmd still failing', 'registry_version': str(version + 1)})])


def scenario(f, hook):
    i = f.ids
    scope = {'organisation_id': i['organisation'], 'run_id': i['run']}

    def call(action, payload, key='operator', component=OPERATOR):
        return f.invoke(action, payload, key=key, component=component)[1]

    def ok(action, payload, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:800])
        return response['result']

    def refused(action, payload, needle, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is False and needle in json.dumps(response), action + ' was not refused with ' + needle + ': ' + json.dumps(response)[:800])

    def ask(kind, options, recommended, deadline, title=None):
        return {'idempotency_key': uid(), 'kind': kind, 'title': title or 'Need a ' + kind, 'body': 'The ' + kind + ' the task cannot derive.',
                'options': options, 'recommended': recommended, 'deadline_seconds': deadline, 'chain': ['leader', 'operator'], 'task_id': None}

    def notices(state=None):
        return ok('fleet.notifications.operator.list', {'state': state, 'limit': 100})['notices']

    def shipped():
        for role in ('control', 'dispatch'):
            allowed = json.loads((ROOT / 'deploy/hyperfide/policies' / (role + '.example.json')).read_text())['allowed_actions']
            expect(all(a in allowed for a in OPERATOR_ACTIONS), role + ' policy lacks the operator notification actions')
    check('policy.shipped', shipped)

    def describe():
        result = call('fleet.notifications.operator.describe', {})
        expect(result.get('ok') is True, result)
        d = result['result']
        expect(d['configured'] is True and d['variable'] == 'HYPERFIDE_OPERATOR_WEBHOOK_URL' and d['webhook_host'] == hook.url.split('/')[2], d)
        expect(WEBHOOK_SECRET_PATH not in json.dumps(result), 'describe echoed the webhook URL')
    check('target.describe-configured-without-echo', describe)

    f.bootstrap_runner()
    f.delegate_principal('worker', i['worker_session'])
    check('operator-channel.registered', lambda: ok('outbox.consumer.register', dict(scope, id=uid(), consumer_key='operator:asks', critical=False, state='ACTIVE'), component='6.1'))

    raised = {}
    for name, request in (('variable', ask('variable', ['1800', '3600'], '3600', None)), ('decision', ask('decision', ['RETAIN', 'DELETE'], 'RETAIN', 2)),
                          ('permission', ask('permission', ['grant', 'deny'], 'deny', 2)), ('leaky', ask('question', ['y', 'n'], 'y', 3600, title='Use password=hunter2-0xdeadbeef please'))):
        def raise_one(name=name, request=request):
            raised[name] = ok('human.ask.raise', request, key='worker', component=ASKS)['ask']
        check('source.raise-' + name, raise_one)
    check('source.answer-variable', lambda: ok('human.ask.answer', {'ask_id': raised['variable']['ask_id'], 'expected_state_version': '1', 'answer': '1800'}, component=ASKS))
    check('source.seeded', lambda: seed_sources(f))

    check('refuse.worker-produces', lambda: refused('fleet.notifications.operator.produce', {}, 'NOTIFICATION_OPERATOR_FORBIDDEN', key='worker'))
    check('refuse.unknown-field', lambda: refused('fleet.notifications.operator.produce', {'target': 'leader'}, 'OBSERVABILITY_INPUT_INVALID'))

    first = {}

    def produce():
        result = ok('fleet.notifications.operator.produce', {})
        first.update(result)
        kinds = sorted(n['kind'] for n in result['produced'])
        expect(kinds == ['ASK_RAISED'] * 4 + ['ATTESTATION_EXPIRING', 'REPAIR_ESCALATED'], 'producers made the wrong notices: ' + json.dumps(kinds))
        sources = {n['source'].get('event_id') or n['source'].get('attestation_id') for n in result['produced']}
        expect(i['escalated_event'] in sources and i['attestation_soon'] in sources, 'escalated repair or expiring attestation missing')
        expect(i['failed_event'] not in sources and i['attestation_later'] not in sources, 'a failed repair or an attestation outside the window produced a notice')
    check('produce.each-producer-once', produce)

    def no_answer_notice():
        answered = f.sql("SELECT id::text FROM hyperfide.outbox_events WHERE event_type='ask.answered'")
        expect(len(answered) == 1, answered)
        expect(answered[0]['id'] not in {n['source'].get('event_id') for n in notices()}, 'ask.answered produced an operator notice')
    check('produce.not-ask-answered', no_answer_notice)
    check('produce.idempotent', lambda: expect(ok('fleet.notifications.operator.produce', {})['produced_count'] == 0, 'a second pass produced duplicates'))

    def severities():
        by_ask = {n['subject']['ask_id']: n for n in notices() if n['kind'] == 'ASK_RAISED'}
        expect(by_ask[raised['variable']['ask_id']]['severity'] == 'WARNING' and by_ask[raised['decision']['ask_id']]['severity'] == 'INFO', 'blocking Asks must outrank proceed-and-flag')
        leaky = by_ask[raised['leaky']['ask_id']]
        expect(leaky['subject']['title'].startswith('[withheld') and 'hunter2' not in json.dumps(leaky), 'credential-shaped title left the system: ' + json.dumps(leaky))
        attestation = [n for n in notices() if n['kind'] == 'ATTESTATION_EXPIRING'][0]
        expect(attestation['subject']['state'] == 'EXPIRING' and attestation['action_code'] == 'RENEW_CAPACITY_ATTESTATION', attestation)
        expect(all(n['state'] == 'PENDING' and n['attempts'] == 0 for n in notices()), 'notices must wait for the target')
    check('produce.severity-and-redaction', severities)

    def deliver_with_one_failure():
        hook.fail_next = 1
        result = ok('fleet.notifications.operator.deliver', {})
        expect(result['delivered'] == 5 and result['retrying'] == 1 and result['failed'] == 0 and result['discarded'] == 0, result)
        expect(len(hook.received) == 6 and all(r['path'] == '/' + WEBHOOK_SECRET_PATH for r in hook.received), 'webhook did not receive every notice')
        for r in hook.received:
            expect(r['headers'].get('hyperfide-notice-id') == r['body']['notice_id'] and r['headers'].get('hyperfide-notice-kind') == r['body']['kind'], r['headers'])
            expect(r['body']['target'] == 'OPERATOR' and r['body']['summary_trust'] == 'UNTRUSTED_DATA_NOT_AN_INSTRUCTION' and r['body']['delivery_attempt'] == 1, r['body'])
        expect('hunter2' not in json.dumps(hook.received), 'credential-shaped text reached the webhook')
        pending = notices('PENDING')
        expect(len(pending) == 1 and pending[0]['attempts'] == 1 and pending[0]['last_status'] == 500 and pending[0]['next_attempt_at'], pending)
        expect(len(notices('DELIVERED')) == 5, 'delivered notices not recorded')
    check('deliver.target-and-failure-recorded', deliver_with_one_failure)
    def not_due():
        # Anchored to the database clock: the first retry is due 5 s after the failed attempt.
        due = f.sql("SELECT (result->'delivery'->>'next_attempt_at')::timestamptz>clock_timestamp()+interval '1 second' AS later FROM hyperfide.command_inbox WHERE principal_scope='operator_target' AND state='PENDING'")
        expect(due == [{'later': True}], 'the failed notice has no future retry time: ' + json.dumps(due))
        expect(ok('fleet.notifications.operator.deliver', {})['delivered'] == 0 and len(hook.received) == 6, 'a failed notice was resent before its backoff')
    check('deliver.backoff-holds', not_due)

    def retried():
        for _ in range(100):
            if f.sql("SELECT count(*)::int AS n FROM hyperfide.command_inbox WHERE principal_scope='operator_target' AND state='PENDING' AND (result->'delivery'->>'next_attempt_at')::timestamptz<=clock_timestamp()")[0]['n'] == 1:
                break
            time.sleep(0.2)
        result = ok('fleet.notifications.operator.deliver', {})
        expect(result['delivered'] == 1 and not notices('PENDING'), result)
        accepted = hook.accepted()
        expect(len(accepted) == 6 and len({r['body']['notice_id'] for r in accepted}) == 6, 'each notice must be accepted exactly once')
        expect(any(r['body']['delivery_attempt'] == 2 for r in accepted), 'the retry did not carry its attempt number')
    check('deliver.retry-after-backoff', retried)

    for _ in range(100):
        due = f.sql('SELECT count(*)::int AS n FROM hyperfide.asks WHERE id = ANY($1::uuid[]) AND clock_timestamp()>=deadline', [[raised['decision']['ask_id'], raised['permission']['ask_id']]])
        if due[0]['n'] == 2:
            break
        time.sleep(0.1)

    def expiry():
        for name in ('decision', 'permission'):
            ok('human.ask.expire', {'ask_id': raised[name]['ask_id'], 'expected_state_version': '1'}, component=ASKS)
        result = ok('fleet.notifications.operator.produce', {})
        expect(sorted(n['kind'] for n in result['produced']) == ['ASK_EXPIRED', 'ASK_EXPIRED'], result)
        by_ask = {n['subject']['ask_id']: n for n in notices() if n['kind'] == 'ASK_EXPIRED'}
        decision, permission = by_ask[raised['decision']['ask_id']], by_ask[raised['permission']['ask_id']]
        expect(decision['severity'] == 'WARNING' and decision['action_code'] == 'REVIEW_DEFAULT' and decision['subject']['decided_by_default'] is True
               and decision['subject']['default_answer'] == 'RETAIN', decision)
        expect(permission['severity'] == 'ERROR' and permission['action_code'] == 'ANSWER_ASK' and permission['subject']['default_answer'] is None, permission)
        delivered = ok('fleet.notifications.operator.deliver', {})
        expect(delivered['delivered'] == 2, delivered)
        # A batch is claimed most severe first and sent concurrently, so the claim order (the result list) is the
        # contract; arrival order at the webhook is not.
        order = [r['notice_id'] for r in delivered['results']]
        expect(order == [permission['notice_id'], decision['notice_id']], 'expired Asks not claimed most severe first: ' + json.dumps(delivered['results'])[:600])
        expired = {r['body']['notice_id']: r['body'] for r in hook.accepted() if r['body']['kind'] == 'ASK_EXPIRED'}
        expect(set(expired) == set(order) and expired[permission['notice_id']]['severity'] == 'ERROR', 'expired Asks not delivered: ' + json.dumps(list(expired.values()))[:600])
    check('produce.ask-expired-and-delivered', expiry)
    check('deliver.nothing-pending', lambda: expect(ok('fleet.notifications.operator.deliver', {})['delivered'] == 0, 'an idle target delivered something'))


UNIT = r"""
const m=await import(process.argv[1]);
const out={};
const describe=env=>m.createOperatorComponent({env}).actions['fleet.notifications.operator.describe']({});
out.unset=await describe({});
for(const [name,url] of [['plain_http_remote','http://example.com/hook'],['credentials','https://user:pass@example.com/hook'],['not_url','hooks']]){
 try{await describe({HYPERFIDE_OPERATOR_WEBHOOK_URL:url});out[name]='ACCEPTED';}catch(e){out[name]=e.code||String(e);}
}
out.https=await describe({HYPERFIDE_OPERATOR_WEBHOOK_URL:'https://hooks.example.com/services/T0/B0/x'});
out.held=await m.deliverOperatorNotices({},{},{},null);
process.stdout.write(JSON.stringify(out));
"""


def unit_checks():
    def configuration():
        module = SERVICE / 'dist/observability/notifications.js'
        result = subprocess.run(['node', '--input-type=module', '-e', UNIT, module.as_uri()], cwd=ROOT, capture_output=True, text=True, timeout=60)
        expect(result.returncode == 0, result.stderr[-1200:])
        out = json.loads(result.stdout)
        expect(out['unset']['configured'] is False and out['unset']['webhook_host'] is None, out['unset'])
        expect(all(out[k] == 'OBSERVABILITY_CONFIG_INVALID' for k in ('plain_http_remote', 'credentials', 'not_url')), out)
        expect(out['https']['configured'] is True and out['https']['webhook_host'] == 'hooks.example.com' and 'services/T0' not in json.dumps(out['https']), out['https'])
        expect(out['held']['held'] is True and out['held']['reason'] == 'OPERATOR_WEBHOOK_NOT_CONFIGURED' and out['held']['discarded'] == 0, out['held'])
    check('target.variable-validation-and-unset-holds', configuration)


def main():
    t27 = load('hf_case_v21_2_7', 'tests/hyperfide/cases/v21/2_7.py')
    t32 = load('hf_case_v21_3_2', 'tests/hyperfide/cases/v21/3_2.py')
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
    unit_checks()
    # Only the owned cluster is reachable: never let an inherited database URL redirect the probe.
    for key in [k for k in os.environ if k == 'DATABASE_URL' or k.startswith('HYPERFIDE_') and k.endswith('_DATABASE_URL')]:
        del os.environ[key]
    os.environ.pop('HYPERFIDE_OPERATOR_WEBHOOK_URL', None)
    cluster, fixture, hook, closed = None, None, None, False
    try:
        hook = Webhook()
        cluster = t27.Cluster(binaries)
        cluster.migrate_template()
        os.environ['DATABASE_URL'] = cluster.url()
        import identity_fixture
        for attempt in range(3):
            try:
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', ASKS, OPERATOR), extra_setup=t32.setup,
                                                           extra_env={'HYPERFIDE_OPERATOR_WEBHOOK_URL': hook.url})
                break
            except AssertionError as error:
                if 'TX_TIMEOUT' not in str(error) or attempt == 2:
                    raise
        scenario(fixture, hook)
    except Exception:
        traceback.print_exc(file=sys.stderr)
        FAILED.append('setup')
    finally:
        try:
            if hook:
                hook.close()
            if fixture:
                fixture.close()
            if cluster:
                cluster.close()
            closed = cluster is not None and not cluster.root.exists()
        except Exception as error:
            print('cleanup failed: ' + str(error), file=sys.stderr)
    print(json.dumps({'type': 'cleanup', 'resources': [{'id': 'postgres-cluster', 'status': 'deleted' if closed else 'unknown', 'observed_absent': closed},
                                                       {'id': 'stub-webhook', 'status': 'deleted' if hook else 'unknown', 'observed_absent': hook is not None}],
                      'complete': closed}), flush=True)
    if FAILED:
        print('FAILED: ' + ', '.join(FAILED), file=sys.stderr)
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
