#!/usr/bin/env python3
"""hyperfide-v21 4.7: seed Asks from open decisions and from the attestation, fence permit and drain observers.

On an owned throwaway PostgreSQL cluster (the v21/3_2.py pattern) the control service runs in HTTPS mode with the
1.2-asks registration. An operator invokes human.ask.seed: one decision Ask per open item of
spec/hyperfide/decisions.md with that register's options, a renewal Ask per expiring or lapsed capacity attestation,
one for the signed fence permit this host holds, and a drain-deadline decision per draining control. Re-seeding
replays every Ask without a new row, history entry or delivery; only a newly observed item is raised. Prints SKIP and
exits 77 when no PostgreSQL server or root is available.
"""
import importlib.util, json, os, pathlib, pwd, re, shutil, subprocess, sys, time, traceback, uuid

ROOT = pathlib.Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
COMPONENT = '1.2-asks'
DAY = 86400
DECISION_DEADLINE = 14 * DAY


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
    print(json.dumps({'type': 'assertion', 'id': 'ask-seed.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def register():
    """The 'Seeded Ask options' table of spec/hyperfide/decisions.md: id -> options, recommended first."""
    text = (ROOT / 'spec/hyperfide/decisions.md').read_text()
    section = text.split('## Seeded Ask options', 1)[1].split('\n## ', 1)[0]
    rows = re.findall(r'^\| ([OE]-\d\d) \| ([^|]+) \|$', section, re.M)
    return {item: [o.strip() for o in options.split(';')] for item, options in rows}


def open_items():
    """Every O-nn of section 3 and E-nn of the run-policy exceptions, read from their own tables."""
    text = (ROOT / 'spec/hyperfide/decisions.md').read_text()
    gates = text.split('## 3. Open qualification and decision gates', 1)[1].split('## Seeded Ask options', 1)[0]
    return set(re.findall(r'^\| ([OE]-\d\d) \|', gates, re.M))


def setup(f):
    """A trusted permit issuer and the paths the service observes; the permit itself is written mid-case."""
    key = f.path / 'permit-issuer.pem'
    subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(key)], check=True, capture_output=True)
    key.chmod(0o600)
    public = subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout', '-outform', 'DER'], stderr=subprocess.DEVNULL)
    import identity_fixture
    verifier = f.path / 'permit-verifier.json'
    verifier.write_text(json.dumps({'schema_version': 1, 'issuers': [{'key_id': 'fixture-issuer', 'public_key_b64': identity_fixture.b64(public[-32:])}]}))
    verifier.chmod(0o600)
    f.permit_key, f.permit_file = key, f.path / 'isolation-permit.json'
    f.env['HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE'] = str(verifier)
    f.env['HYPERFIDE_ISOLATION_PERMIT_FILE'] = str(f.permit_file)


def issue_permit(f, ttl):
    script = ("import {issueIsolationPermit} from './services/hyperfide/dist/identity/credentials.js';"
              "const [deployment,organisation,run,key,ttl]=process.argv.slice(1);const now=Date.now();"
              "const claims={schema_version:1,purpose:'EXTERNAL_WRITER_ISOLATION_ONLY',deployment_id:deployment,operation_id:crypto.randomUUID(),"
              "organisation_id:organisation,run_id:run,source_epoch:null,topology_digest:'sha256:'+'c'.repeat(64),resources:[],"
              "issued_at:new Date(now).toISOString(),expires_at:new Date(now+Number(ttl)*1000).toISOString(),nonce:crypto.randomUUID(),scope:'GREENFIELD'};"
              "process.stdout.write(JSON.stringify({claims,envelope:await issueIsolationPermit(claims,{key_id:'fixture-issuer',private_key_file:key})}));")
    out = subprocess.run(['node', '--input-type=module', '-e', script, f.ids['deployment'], f.ids['organisation'], f.ids['run'], str(f.permit_key), str(ttl)],
                         cwd=ROOT, check=True, capture_output=True, text=True, timeout=60)
    issued = json.loads(out.stdout)
    f.permit_file.write_text(issued['envelope'])
    f.permit_file.chmod(0o600)
    return issued['claims']


def scenario(f):
    i = f.ids
    o, r = i['organisation'], i['run']
    scope = {'organisation_id': o, 'run_id': r}

    def call(action, payload, key='operator', component=COMPONENT):
        return f.invoke(action, payload, key=key, component=component)[1]

    def ok(action, payload, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is True, action + ' failed: ' + json.dumps(response)[:800])
        return response['result']

    def refused(action, payload, needle, **kw):
        response = call(action, payload, **kw)
        expect(response.get('ok') is False and needle in json.dumps(response), action + ' was not refused with ' + needle + ': ' + json.dumps(response)[:800])

    def seed():
        return ok('human.ask.seed', {'decision_deadline_seconds': DECISION_DEADLINE})

    def asks():
        return f.sql("SELECT id::text,kind,title,options,recommended,default_policy,chain,state,raised_by::text,"
                     "floor(extract(epoch FROM deadline-raised_at))::bigint AS window,deadline FROM hyperfide.asks WHERE organisation_id=$1 ORDER BY raised_at,id", [o])

    def totals():
        return f.sql("SELECT (SELECT count(*) FROM hyperfide.asks)::int AS asks,(SELECT count(*) FROM hyperfide.ask_events)::int AS history,"
                     "(SELECT count(*) FROM hyperfide.outbox_events WHERE aggregate_type='ask')::int AS events,"
                     "(SELECT count(*) FROM hyperfide.event_deliveries d JOIN hyperfide.outbox_events e ON e.id=d.event_id WHERE e.aggregate_type='ask')::int AS deliveries")[0]

    check('policy.every-shipped-policy', lambda: expect(all('human.ask.seed' in json.loads((ROOT / 'deploy/hyperfide/policies' / (role + '.example.json')).read_text())['allowed_actions']
                                                             for role in ('control', 'dispatch', 'provisioner')), 'a shipped policy lacks human.ask.seed'))
    check('register.covers-every-open-item', lambda: expect(set(register()) == open_items() and len(open_items()) == 13,
                                                            'decisions.md option table differs from its open items: %s vs %s' % (sorted(register()), sorted(open_items()))))

    # Observed sources: capacity attestations (inside the 7-day window, outside it, lapsed) and drains.
    config = 'sha256:' + 'd' * 64
    f.sql("INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,'{}')", [o, i['pool'], config])
    i['provenance'] = uid()
    f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,1,'COMPONENT_FIXTURE','4.7','COMPLETE',clock_timestamp())",
          [o, r, i['provenance'], 'sha256:' + 'e' * 64])

    def attest(dimension, declared, expires):
        ident = uid()
        f.sql("INSERT INTO hyperfide.provider_capacity_attestations(organisation_id,id,pool_id,configuration_digest,provenance_run_id,provenance_artifact_id,provenance_digest,declaration_digest,declaration,declared_at,expires_at) "
              "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,clock_timestamp()+($10::int*interval '1 second'),clock_timestamp()+($11::int*interval '1 second'))",
              [o, ident, i['pool'], config, r, i['provenance'], 'sha256:' + 'e' * 64, 'sha256:' + uuid.uuid4().hex * 2,
               json.dumps({'scope_kind': 'ACCOUNT', 'scope_key': 'fixture', 'dimension': dimension, 'limit': '20'}), declared, expires])
        return ident
    i['soon'] = attest('SANDBOX', -DAY, 3 * DAY)
    i['outside'] = attest('CPU_MILLIS', -DAY, 10 * DAY)
    i['lapsed'] = attest('MEMORY_BYTES', -5 * DAY, -3600)

    def drain(scope_kind, scope_id, package, seconds, fallback):
        ident = uid()
        f.sql("INSERT INTO hyperfide.execution_controls(organisation_id,run_id,id,scope_kind,scope_id,package_id,mode,deadline_at,fallback_mode) "
              "VALUES($1,$2,$3,$4,$5,$6,'DRAIN',clock_timestamp()+($7::int*interval '1 second'),$8)", [o, r, ident, scope_kind, scope_id, package, seconds, fallback])
        return ident
    i['drain'] = drain('RUN', r, None, 3600, 'PAUSE')

    check('refuse.before-operator-channel', lambda: refused('human.ask.seed', {'decision_deadline_seconds': DECISION_DEADLINE}, 'ASK_OPERATOR_CONSUMER_REQUIRED'))
    check('refuse.nothing-raised-without-channel', lambda: expect(totals()['asks'] == 0, 'a refused seed left Asks behind'))
    i['operator_consumer'] = uid()
    check('operator-channel.registered', lambda: ok('outbox.consumer.register', dict(scope, id=i['operator_consumer'], consumer_key='operator:asks', critical=False, state='ACTIVE'), component='6.1'))
    check('refuse.deadline-required', lambda: refused('human.ask.seed', {}, 'invalid'))
    check('refuse.deadline-bounded', lambda: refused('human.ask.seed', {'decision_deadline_seconds': 31 * DAY}, 'Decision deadline'))
    check('refuse.provisioner-role', lambda: refused('human.ask.seed', {'decision_deadline_seconds': DECISION_DEADLINE}, 'human.ask.seed', key='provisioner'))

    # Without a permit file the observer reports, it does not raise.
    first = {}
    check('seed.first', lambda: first.update(seed()))
    check('seed.permit-missing-reported', lambda: expect([s for s in first['seeds'] if s['source'] == 'fence-permit'] == [{'source': 'fence-permit', 'key': 'configured', 'status': 'SKIPPED', 'reason': 'ENOENT'}],
                                                          [s for s in first['seeds'] if s['source'] == 'fence-permit']))

    def decisions():
        options = register()
        rows = {a['title'].split(':', 1)[0].split(' ', 1)[1]: a for a in asks() if a['title'].startswith('Decision ')}
        expect(set(rows) == set(options), 'decision Asks %s differ from the register %s' % (sorted(rows), sorted(options)))
        for item, row in rows.items():
            expect(row['kind'] == 'decision' and row['default_policy'] == 'proceed-and-flag' and row['state'] == 'OPEN', row)
            expect(row['options'] == options[item] and row['recommended'] == options[item][0], (item, row['options'], options[item]))
            expect(abs(int(row['window']) - DECISION_DEADLINE) <= 2 and row['chain'] == ['operator'] and row['raised_by'] == i['operator'], row)
        expect(sorted(s['key'] for s in first['seeds'] if s['source'] == 'decision' and s['status'] == 'RAISED') == sorted(options), first)
    check('seed.decision-per-open-item-with-register-options', decisions)

    def attestations():
        rows = {a['title'].rsplit(' ', 1)[1]: a for a in asks() if a['title'].startswith('Renew capacity attestation ')}
        expect(set(rows) == {i['soon'], i['lapsed']}, 'attestation Asks are not exactly the expiring and lapsed ones: ' + json.dumps(sorted(rows)))
        soon, lapsed = rows[i['soon']], rows[i['lapsed']]
        expect(soon['kind'] == 'permission' and soon['default_policy'] == 'block' and soon['options'] == ['renew', 'let-lapse'] and soon['recommended'] == 'renew', soon)
        expect(3 * DAY - 120 <= int(soon['window']) <= 3 * DAY, 'expiring attestation deadline is not its expiry: %s' % soon['window'])
        expect(lapsed['deadline'] is None and lapsed['default_policy'] == 'block', 'a lapsed attestation keeps no deadline: ' + json.dumps(lapsed, default=str))
    check('seed.attestations-from-observer', attestations)

    def drains():
        rows = [a for a in asks() if a['title'].startswith('Drain of RUN ' + r)]
        expect(len(rows) == 1, rows)
        a = rows[0]
        expect(a['kind'] == 'decision' and a['options'] == ['apply-pause', 'extend-drain'] and a['recommended'] == 'apply-pause' and 3500 <= int(a['window']) <= 3600, a)
    check('seed.drain-deadline', drains)

    def delivered():
        raised = [s['ask_id'] for s in first['seeds'] if s['status'] == 'RAISED']
        rows = f.sql("SELECT e.aggregate_id::text AS ask,e.event_type,d.consumer_id::text AS consumer FROM hyperfide.outbox_events e JOIN hyperfide.event_deliveries d ON d.event_id=e.id WHERE e.aggregate_type='ask'")
        expect(sorted(x['ask'] for x in rows) == sorted(raised) and all(x['event_type'] == 'ask.raised' and x['consumer'] == i['operator_consumer'] for x in rows), rows)
        expect(first['raised'] == 13 + 2 + 1 == len(raised) and first['replayed'] == 0, first)
    check('seed.delivered-to-operator', delivered)

    before = {}
    check('reseed.snapshot', lambda: before.update(totals()))

    def reseed_replays():
        again = seed()
        expect(again['raised'] == 0 and again['replayed'] == first['raised'], again)
        expect({s['key']: s['ask_id'] for s in again['seeds'] if s['status'] == 'REPLAYED'} == {s['key']: s['ask_id'] for s in first['seeds'] if s['status'] == 'RAISED'}, 'replay returned other Asks')
        expect(totals() == before, 're-seeding wrote rows: %s -> %s' % (before, totals()))
    check('reseed.idempotent', reseed_replays)

    # A decision answered since does not come back, and a permit and a later drain are raised alone.
    def answered_stays_answered():
        target = [a for a in asks() if a['title'].startswith('Decision O-11')][0]
        ok('human.ask.answer', {'ask_id': target['id'], 'expected_state_version': '1', 'answer': 'every-watcher-every-commit'})
        again = seed()
        expect(again['raised'] == 0 and [a['state'] for a in asks() if a['title'].startswith('Decision O-11')] == ['ANSWERED'], again)
    check('reseed.answered-not-reraised', answered_stays_answered)

    claims = {}

    def permit_and_new_drain():
        claims.update(issue_permit(f, 900))
        i['package'] = uid()
        f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'seed',1)", [o, r, i['package']])
        i['drain2'] = drain('PACKAGE', i['package'], i['package'], 7200, 'STOP')
        counts = totals()
        again = seed()
        raised = sorted(((s['source'], s['key']) for s in again['seeds'] if s['status'] == 'RAISED'))
        expect(len(raised) == 2 and raised[0] == ('drain', i['drain2'] + '.1') and raised[1][0] == 'fence-permit' and raised[1][1].startswith('sha256:'), raised)
        expect(totals()['asks'] == counts['asks'] + 2, 'raise count differs from new rows')
        rows = [a for a in asks() if a['title'].startswith('Drain of PACKAGE ' + i['package'])]
        expect(len(rows) == 1 and rows[0]['options'] == ['apply-stop', 'extend-drain'] and rows[0]['recommended'] == 'apply-stop', rows)
    check('reseed.permit-raised', permit_and_new_drain)

    def permit_row():
        rows = [a for a in asks() if a['title'].startswith('Fence permit for operation ' + claims['operation_id'])]
        expect(len(rows) == 1, rows)
        a = rows[0]
        expect(a['kind'] == 'permission' and a['default_policy'] == 'block' and a['options'] == ['re-sign', 'let-expire'] and a['recommended'] == 're-sign' and 880 <= int(a['window']) <= 900, a)
        again = seed()
        expect(again['raised'] == 0 and any(s['source'] == 'fence-permit' and s['status'] == 'REPLAYED' and s['ask_id'] == a['id'] for s in again['seeds']), again)
    check('seed.fence-permit-ttl', permit_row)

    def foreign_permit():
        saved = f.permit_file.read_text()
        f.ids['run'], real = uid(), f.ids['run']
        try:
            issue_permit(f, 600)
        finally:
            f.ids['run'] = real
        again = seed()
        mine = [s for s in again['seeds'] if s['source'] == 'fence-permit']
        expect(len(mine) == 1 and mine[0]['status'] == 'SKIPPED' and mine[0]['reason'] == 'ISOLATION_PERMIT_SCOPE', mine)
        f.permit_file.write_text(saved)
    check('seed.foreign-permit-not-raised', foreign_permit)

    def history_complete():
        n = f.sql("SELECT count(*)::int AS n FROM hyperfide.outbox_events WHERE aggregate_type='ask'")[0]['n']
        versions = f.sql('SELECT coalesce(sum(state_version),0)::int AS n FROM hyperfide.asks')[0]['n']
        expect(n == versions, 'every Ask state_version needs exactly one event: %s events, %s versions' % (n, versions))
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
    if FAILED:
        print('FAILED: ' + ', '.join(FAILED), file=sys.stderr)
    return 0 if closed and not FAILED else 1


if __name__ == '__main__':
    raise SystemExit(main())
