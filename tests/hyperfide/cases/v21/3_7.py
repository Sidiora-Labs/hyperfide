#!/usr/bin/env python3
"""hyperfide-v21 3.7: the Ask routes in the cg client against a running control service.

The 3.2 fixture (owned PostgreSQL cluster, HTTPS control service with 1.2-asks, a WORKER principal delegated
by an enrolled runner, the operator Ask channel) is reused; every Ask call here goes through the built cg
binary in distributed mode (`cg ask raise|list|answer|expire`), signed with the caller's own key from a
transport configuration. Prints SKIP and exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, pwd, shutil, subprocess, sys, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
CG = pathlib.Path(os.environ.get('CG') or ROOT / 'cg')
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
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
    print(json.dumps({'type': 'assertion', 'id': 'ask-client.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Client:
    """cg in distributed mode, one transport configuration per principal."""

    def __init__(self, f):
        self.f = f
        self.marker = f.path / 'ask-authority.json'
        self.marker.write_text(json.dumps({'schema_version': 1, 'mode': 'distributed', 'authority_epoch': f.ids['epoch']}))
        self.marker.chmod(0o600)
        base = {k: v for k, v in os.environ.items()
                if not k.startswith(('HYPERFIDE_', 'CG_', 'CODIFY_')) and k not in ('DATABASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY')}
        self.base = dict(base, HYPERFIDE_MODE='distributed', HYPERFIDE_AUTHORITY_DESCRIPTOR=str(self.marker))

    def env(self, key):
        config = self.f.path / ('ask-transport-' + key + '.json')
        config.write_text(json.dumps({'origin': self.f.origin, 'ca_file': str(self.f.ca), 'key_path': str(self.f.keys[key]['path']),
                                      'credential_id': self.f.ids[key], 'timeout_ms': 5000}))
        config.chmod(0o600)
        return dict(self.base, HYPERFIDE_TRANSPORT_CONFIG=str(config))

    def run(self, verb, payload, key='operator', identities=True):
        path = self.f.path / ('ask-input-' + uid() + '.json')
        path.write_text(json.dumps(payload))
        args = [str(CG), 'ask', verb, '--input-file', str(path)]
        if identities:
            args += ['--run-id', self.f.ids['run'], '--operation-id', uid(), '--idempotency-key', uid(), '--correlation-id', uid()]
        authority = getattr(self.f, 'authorities', {}).get(key)
        if identities and authority:
            proof = self.f.path / ('ask-proof-' + key + '.json')
            proof.write_text(json.dumps(authority))
            args += ['--authority-file', str(proof)]
        return subprocess.run(args, cwd=self.f.path, env=self.env(key), capture_output=True, text=True, timeout=30)

    def ok(self, verb, payload, key='operator'):
        r = self.run(verb, payload, key)
        expect(r.returncode == 0, 'cg ask %s exited %d: %s %s' % (verb, r.returncode, r.stdout[:600], r.stderr[:600]))
        body = json.loads(r.stdout)
        expect(body.get('ok') is True, 'cg ask %s not ok: %s' % (verb, r.stdout[:800]))
        return body['result']

    def refused(self, verb, payload, needle, key='operator'):
        r = self.run(verb, payload, key)
        expect(r.returncode != 0, 'cg ask %s succeeded where %s was expected' % (verb, needle))
        expect(needle in r.stdout + r.stderr, 'cg ask %s was not refused with %s: %s %s' % (verb, needle, r.stdout[:600], r.stderr[:600]))


def scenario(f):
    i = f.ids
    scope = {'organisation_id': i['organisation'], 'run_id': i['run']}
    cg = Client(f)

    def ask(kind, options, recommended, deadline):
        return {'idempotency_key': uid(), 'kind': kind, 'title': 'Need a ' + kind, 'body': 'The ' + kind + ' the task cannot derive.',
                'options': options, 'recommended': recommended, 'deadline_seconds': deadline, 'chain': ['leader', 'operator'], 'task_id': None}

    f.bootstrap_runner()
    f.delegate_principal('worker', i['worker_session'])
    i['operator_consumer'] = uid()
    registered = f.invoke('outbox.consumer.register', dict(scope, id=i['operator_consumer'], consumer_key='operator:asks', critical=False, state='ACTIVE'), component='6.1')[1]
    expect(registered.get('ok') is True, 'operator channel not registered: ' + json.dumps(registered)[:600])

    check('refuse.without-identities', lambda: expect('OPERATION_ID_REQUIRED' in cg.run('raise', ask('question', ['y'], 'y', 60), key='worker', identities=False).stderr,
                                                      'a raise without operation identities was not refused before the network'))
    raised = {}

    def raise_question():
        result = cg.ok('raise', ask('question', ['yes', 'no'], 'yes', 3600), key='worker')
        a = result['ask']
        expect(result['status'] == 'RAISED' and a['state'] == 'OPEN' and a['raised_by'] == i['worker'] and a['attempt'] == i['attempt'], result)
        row = f.sql('SELECT state,kind FROM hyperfide.asks WHERE id=$1', [a['ask_id']])
        expect(row == [{'state': 'OPEN', 'kind': 'question'}], 'no durable Ask row: ' + json.dumps(row))
        raised['question'] = a
    check('raise.worker-through-cg', raise_question)
    check('raise.decision', lambda: raised.update(decision=cg.ok('raise', ask('decision', ['RETAIN', 'DELETE'], 'RETAIN', 3600), key='worker')['ask']))
    check('refuse.unknown-kind', lambda: cg.refused('raise', ask('wish', [], None, None), 'kind is unknown', key='worker'))

    def operator_lists():
        rows = {a['ask_id']: a for a in cg.ok('list', {'state': 'OPEN', 'limit': 100})['asks']}
        expect({raised['question']['ask_id'], raised['decision']['ask_id']} <= set(rows), 'cg ask list missed the open Asks')
    check('list.operator-through-cg', operator_lists)
    check('list.worker-own', lambda: expect(raised['question']['ask_id'] in {a['ask_id'] for a in cg.ok('list', {'state': None, 'limit': 100}, key='worker')['asks']},
                                            "the worker's own list lacks its Ask"))

    def answer(kind, value, version='1'):
        return {'ask_id': raised[kind]['ask_id'], 'expected_state_version': version, 'answer': value}
    check('refuse.worker-answers', lambda: cg.refused('answer', answer('question', 'yes'), 'cannot answer', key='worker'))
    check('refuse.outside-options', lambda: cg.refused('answer', answer('decision', 'ARCHIVE'), 'one of the offered options'))

    def operator_answers():
        a = cg.ok('answer', answer('question', 'no'))['ask']
        expect(a['state'] == 'ANSWERED' and a['answer'] == 'no' and a['answered_by'] == i['operator'] and a['state_version'] == '2', a)
        row = f.sql('SELECT state,answer FROM hyperfide.asks WHERE id=$1', [a['ask_id']])
        expect(row == [{'state': 'ANSWERED', 'answer': 'no'}], 'answer not durable: ' + json.dumps(row))
    check('answer.operator-through-cg', operator_answers)
    check('refuse.reanswer', lambda: cg.refused('answer', answer('question', 'yes', version='2'), 'already answered'))
    check('refuse.early-expiry', lambda: cg.refused('expire', {'ask_id': raised['decision']['ask_id'], 'expected_state_version': '1'}, 'deadline has not passed'))


def main():
    if not os.access(CG, os.X_OK):
        print('no cg binary at %s; run make cg' % CG, file=sys.stderr)
        return 1
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
                fixture = identity_fixture.IdentityFixture(extra_components=('6.1', '6.2', t32.COMPONENT), extra_setup=t32.setup)
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
