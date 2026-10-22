#!/usr/bin/env python3
"""hyperfide-v21 2.1: operator resolution of orphans and quarantined intents releases capacity.

Runs the real provisioner service over signed HTTPS against an owned, ephemeral
PostgreSQL cluster. The orphan and the QUARANTINED intent are written with the
same statements reconcile.ts uses when ownership cannot be proven (8_3.py proves
that path end to end with a simulated adapter); everything after that goes
through the operator actions under test.
"""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
SUPERUSER = 'hf_superuser'
FAILED = []
OBSERVED = []


def expect(value, message):
    if not value:
        raise AssertionError(str(message)[:1500])


def check(name, operation):
    try:
        operation()
        actual = 'observed'
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)
    OBSERVED.append({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual})
    print(json.dumps(OBSERVED[-1]), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    sys.exit(77)


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    # A client-only package (no initdb) can sit beside the server version.
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin')
                        if (path / 'initdb').exists() and (path / 'postgres').exists()),
                       key=lambda path: int(path.parent.name))
    return installed[-1] if installed else None


def run(argv, env=None, timeout=600):
    p = subprocess.run(argv, cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
    if p.returncode:
        raise AssertionError(' '.join(map(str, argv)) + ': ' + (p.stderr + p.stdout)[-1500:])
    return p.stdout


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory (pattern of tasks/29_5.py)."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-2-1-', dir='/tmp/hyperfide'))
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

    def url(self, database='postgres'):
        return 'postgresql://' + SUPERUSER + '@localhost:5432/' + database + '?host=' + quote(str(self.root), safe='')

    def close(self):
        if self.process and self.process.poll() is None:
            self.server('pg_ctl', '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop')
        if self.process:
            self.process.wait(timeout=60)
        shutil.rmtree(self.root)
        return not self.root.exists()


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ensure_build():
    stamp = subprocess.run(['node', 'deploy/hyperfide/dist-stamp.mjs', 'check', str(SERVICE)], cwd=ROOT,
                           capture_output=True, text=True)
    if stamp.returncode:
        run(['npm', '--prefix', str(SERVICE), 'run', 'build'])


WINDOW_PROBE = r"""
import assert from 'node:assert/strict';
import {resolutionWindowSeconds} from './services/hyperfide/dist/providers/reconcile.js';
assert.throws(()=>resolutionWindowSeconds({}),e=>e.code==='RESOLUTION_WINDOW_REQUIRED');
assert.throws(()=>resolutionWindowSeconds({HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS:'0'}),e=>e.code==='RESOLUTION_WINDOW_INVALID');
assert.throws(()=>resolutionWindowSeconds({HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS:'1h'}),e=>e.code==='RESOLUTION_WINDOW_INVALID');
assert.equal(resolutionWindowSeconds({HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS:'900'}),900);
"""


def scenario(intents):
    f = None
    try:
        def setup(fixture):
            intents.prepare_provider_intent_fixture(fixture)
            fixture.env['HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS'] = '1'
        f = intents.pools.ProvisionerFixture(extra_components=['8.2', '8.3'], extra_setup=setup)
        org, run_id = f.ids['organisation'], f.ids['run']

        def call(action, payload, key='operator', component='8.3'):
            return f.invoke(action, payload, component=component, key=key)

        def ok(action, payload, key='operator', component='8.3'):
            status, response = call(action, payload, key, component)
            expect(status == 200 and response.get('ok') is True, (action, status, response))
            return response['result']

        def refused(action, payload, code, key='operator'):
            status, response = call(action, payload, key)
            expect(status >= 400 or response.get('ok') is False, (action, 'accepted', response))
            expect(code in json.dumps(response), (action, 'expected ' + code, response))

        def capacity():
            return ok('provider.pools.capacity', {'pool_id': f.pool}, component='8.2')

        def used(report, name):
            return next(d for d in report['dimensions'] if d['name'] == name)['used_pool']

        def intent_row(iid):
            return f.sql('SELECT state,failure_code FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND id=$2', [org, iid])[0]

        def create(reservations):
            request = {'run_id': run_id, 'pool_id': f.pool, 'sandbox_id': str(uuid.uuid4()), 'request_key': str(uuid.uuid4()),
                       'deadline_at': intents.utc(), 'reservation_ids': reservations, 'profile_id': f.profile,
                       'preparation_digest': f.preparation, 'purpose': 'PREPARATION'}
            return request, call('provider.intents.prepare-create', request)

        def quarantine(iid):
            f.sql("UPDATE hyperfide.provisioning_intents SET state='QUARANTINED',failure_code='OWNERSHIP_UNVERIFIED',updated_at=clock_timestamp(),state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [org, iid])

        ok('provider.pools.configure', {}, component='8.2')
        intents.seed_provider_capacity(f)
        first = f.reservations[:]
        request, (status, response) = create(first)
        expect(status == 200 and response.get('ok'), response)
        iid = response['result']['intent']['id']
        quarantine(iid)
        native = 'lost-create-' + iid
        f.sql('INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id,suspected_intent_id) VALUES($1,$2,$3,$4)', [org, f.pool, native, iid])
        orphan = {'pool_id': f.pool, 'native_sandbox_id': native}
        evidence = intents.sha(b'operator-observed-provider-console-absence')

        def unknown():
            report = capacity()
            expect(report['unknown_resource_capacity'] is True, report)
            expect(used(report, 'PROVISIONING') == '1' and used(report, 'SANDBOX') == '2', report)
            _, (status, response) = create(first)
            expect(status >= 400 or response.get('ok') is False, ('admission accepted under unknown capacity', response))
            expect('CAPACITY_UNKNOWN' in json.dumps(response), response)
        check('v21.2.1.capacity-unknown-blocks-admission', unknown)

        check('v21.2.1.window-required', lambda: run(['node', '--input-type=module', '-e', WINDOW_PROBE], f.env))
        check('v21.2.1.non-operator-refused', lambda: refused('provider.orphans.resolve', {**orphan, 'resolution': 'RETAIN', 'reason': 'provisioner may not decide', 'evidence_digest': None}, 'AUTH_SCOPE_DENIED', key='provisioner'))
        check('v21.2.1.invalid-resolution-refused', lambda: refused('provider.orphans.resolve', {**orphan, 'resolution': 'FORGET', 'reason': 'not an option', 'evidence_digest': None}, 'INVALID_REQUEST'))
        check('v21.2.1.delete-needs-evidence', lambda: refused('provider.orphans.resolve', {**orphan, 'resolution': 'DELETE', 'reason': 'no proof given', 'evidence_digest': None}, 'DELETION_EVIDENCE_REQUIRED'))
        check('v21.2.1.unknown-orphan-refused', lambda: refused('provider.orphans.resolve', {'pool_id': f.pool, 'native_sandbox_id': 'never-seen', 'resolution': 'RETAIN', 'reason': 'absent', 'evidence_digest': None}, 'ORPHAN_UNKNOWN'))

        asks = {}

        def escalated():
            time.sleep(1.5)
            result = ok('provider.resolutions.escalate', {})
            keys = {'orphan:' + f.pool + ':' + native, 'intent:' + iid}
            expect(result['window_seconds'] == 1 and set(result['raised']) == keys, result)
            for ask in result['open']:
                expect(ask['kind'] == 'decision' and ask['recommended'] in [o['id'] for o in ask['options']], ask)
                asks[ask['subject_key']] = ask
            expect(set(asks) == keys and asks['intent:' + iid]['recommended'] == 'RELEASE', asks)
            again = ok('provider.resolutions.escalate', {}, key='provisioner')
            expect(again['raised'] == [] and len(again['open']) == 2, ('second escalation duplicated Asks', again))
        check('v21.2.1.overdue-raise-decision-asks', escalated)

        def retained():
            result = ok('provider.orphans.resolve', {**orphan, 'resolution': 'RETAIN', 'reason': 'operator adopts the resource while investigating', 'evidence_digest': None})
            expect(result['resolved'] is True and result['state'] == 'RETAINED', result)
            report = result['capacity']
            expect(report['unknown_resource_capacity'] is False and used(report, 'SANDBOX') == '2', ('retained orphan must stay occupied but known', report))
        check('v21.2.1.orphan-retain-clears-unknown', retained)

        def deleted():
            result = ok('provider.orphans.resolve', {**orphan, 'resolution': 'DELETE', 'reason': 'operator removed the resource in the provider console', 'evidence_digest': evidence})
            expect(result['state'] == 'DELETED' and result['capacity']['unknown_resource_capacity'] is False, result)
            expect(used(result['capacity'], 'SANDBOX') == '1', ('deleted orphan still occupies a sandbox', result['capacity']))
            refused('provider.orphans.resolve', {**orphan, 'resolution': 'RETAIN', 'reason': 'too late', 'evidence_digest': None}, 'RESOLUTION_CONFLICT')
        check('v21.2.1.orphan-delete-frees-sandbox', deleted)

        def released():
            refused('provider.intents.resolve-quarantine', {'intent_id': iid, 'resolution': 'RELEASE', 'reason': 'x', 'evidence_digest': None}, 'AUTH_SCOPE_DENIED', key='provisioner')
            result = ok('provider.intents.resolve-quarantine', {'intent_id': iid, 'resolution': 'RELEASE', 'reason': 'create was lost; abandon it', 'evidence_digest': None})
            expect(result['resolved'] is True and result['released_reservations'] == 4 and result['intent']['state'] == 'REJECTED', result)
            expect(intent_row(iid) == {'state': 'REJECTED', 'failure_code': 'OPERATOR_RELEASED'}, intent_row(iid))
            pending = f.sql("SELECT count(*)::int AS n FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) AND state='RELEASE_PENDING'", [org, run_id, first])[0]['n']
            expect(pending == 4, ('linked reservations not handed to admission', pending))
            report = capacity()
            expect(report['unknown_resource_capacity'] is False and used(report, 'PROVISIONING') == '0', report)
            again = ok('provider.intents.resolve-quarantine', {'intent_id': iid, 'resolution': 'RELEASE', 'reason': 'replay', 'evidence_digest': None})
            expect(again['resolved'] is False, ('replayed release wrote a second decision', again))
            refused('provider.intents.resolve-quarantine', {'intent_id': iid, 'resolution': 'RETRY', 'reason': 'not quarantined', 'evidence_digest': None}, 'INTENT_NOT_QUARANTINED')
        check('v21.2.1.intent-release-returns-capacity', released)

        second = {}

        def admitted():
            intents.seed_provider_capacity(f)
            _, (status, response) = create(f.reservations[4:])
            expect(status == 200 and response.get('ok') is True and response['result']['created'] is True, ('admission still blocked', response))
            second['id'] = response['result']['intent']['id']
        check('v21.2.1.admission-restored', admitted)

        def retried():
            refused('provider.intents.resolve-quarantine', {'intent_id': second['id'], 'resolution': 'RETRY', 'reason': 'still recorded', 'evidence_digest': None}, 'INTENT_NOT_QUARANTINED')
            quarantine(second['id'])
            expect(capacity()['unknown_resource_capacity'] is False, 'a quarantined intent alone is not an unknown resource')
            result = ok('provider.intents.resolve-quarantine', {'intent_id': second['id'], 'resolution': 'RETRY', 'reason': 'ownership probe installed; reconcile again', 'evidence_digest': None})
            expect(result['resolved'] is True and result['intent']['state'] == 'UNKNOWN' and result['released_reservations'] == 0, result)
            expect(intent_row(second['id']) == {'state': 'UNKNOWN', 'failure_code': None}, intent_row(second['id']))
        check('v21.2.1.intent-retry-requeues', retried)

        def audited():
            listing = ok('provider.resolutions.list', {'pool_id': f.pool})
            rows = listing['resolutions']
            expect([r['resolution'] for r in rows] == ['RETAIN', 'DELETE', 'RELEASE', 'RETRY'], rows)
            for r in rows:
                expect(r['decided_by_credential_id'] == f.ids['operator'] and r['decided_by_actor_id'] == f.ids['operator'] and r['decided_by_role'] == 'OPERATOR' and r['reason'], r)
            expect(rows[2]['released_reservations'] == 4 and rows[1]['evidence_digest'] == evidence, rows)
            answered = {a['subject_key']: a for a in listing['asks']}
            expect(all(a['state'] == 'ANSWERED' and a['resolution_id'] for a in answered.values()) and len(answered) == 2, listing['asks'])
            expect(answered['intent:' + iid]['resolution_id'] == rows[2]['id'] and answered['orphan:' + f.pool + ':' + native]['resolution_id'] == rows[0]['id'], answered)
        check('v21.2.1.audit-records-decider', audited)

        def immutable():
            try:
                f.sql("UPDATE hyperfide.provider_resolutions SET reason='rewritten' WHERE organisation_id=$1", [org])
            except AssertionError:
                return
            raise AssertionError('a resolution audit row was rewritten')
        check('v21.2.1.audit-immutable', immutable)
    finally:
        if f is not None:
            f.close()


def main():
    binaries = postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        skip('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    if os.geteuid() != 0:
        skip('the owned cluster runs initdb through runuser postgres, which needs root')
    # Only the owned cluster is reachable: never let an inherited database URL redirect the fixture.
    for key in list(os.environ):
        if key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'):
            del os.environ[key]
    cluster = None
    clean = False
    try:
        ensure_build()
        cluster = Cluster(binaries)
        os.environ['DATABASE_URL'] = cluster.url()
        intents = load('provider_intent_fixture', 'tests/hyperfide/cases/tasks/8_3.py')
        scenario(intents)
    except Exception as error:
        FAILED.append('fixture')
        print('fixture: ' + str(error)[:3000], file=sys.stderr)
    finally:
        try:
            clean = cluster.close() if cluster else False
        except Exception as error:
            print('Cleanup failed: ' + str(error), file=sys.stderr)
        print(json.dumps({'type': 'cleanup', 'resources': [], 'complete': clean}), flush=True)
        campaign = os.environ.get('HYPERFIDE_CAMPAIGN_DIR')
        if campaign:
            Path(campaign).mkdir(parents=True, exist_ok=True)
            (Path(campaign) / 'v21-2-1-observations.json').write_text(
                json.dumps({'assertions': OBSERVED, 'cluster_removed': clean}, indent=2) + '\n')
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
