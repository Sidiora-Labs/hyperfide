#!/usr/bin/env python3
"""hyperfide-v21 2.16: the provisioner worker loop escalates unresolved provider uncertainty.

Runs the real provisioner service over signed HTTPS against an owned, ephemeral
PostgreSQL cluster. The orphan is written with the statement reconcile.ts uses when
ownership cannot be proven (2_1.py and 8_3.py prove that path); the worker loop is
started with the provisioner credential and must raise, deduplicate and close the
decision Ask on its own cadence with no operator call to provider.resolutions.escalate.
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
SERVICE = ROOT / 'core/control-plane'
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
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-2-16-', dir='/tmp/hyperfide'))
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


SETTINGS_PROBE = r"""
import assert from 'node:assert/strict';
import {workerSettings} from './core/control-plane/dist/providers/worker.js';
assert.equal(workerSettings({}).escalate_ms,60000);
assert.equal(workerSettings({HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS:'0'}).escalate_ms,0);
assert.equal(workerSettings({HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS:'250'}).escalate_ms,250);
for(const bad of ['50','-1','1m','86400001'])assert.throws(()=>workerSettings({HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS:bad}),e=>e.code==='WORKER_CONFIG_INVALID');
"""

INTERVAL_MS = 200


def scenario(intents):
    f = None
    try:
        def setup(fixture):
            intents.prepare_provider_intent_fixture(fixture)
            fixture.env['HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS'] = '1'
            fixture.env['HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS'] = str(INTERVAL_MS)
        f = intents.pools.ProvisionerFixture(extra_components=['8.2', '8.3'], extra_setup=setup)
        org = f.ids['organisation']

        def call(action, payload, key='operator', component='8.3'):
            return f.invoke(action, payload, component=component, key=key)

        def ok(action, payload, key='operator', component='8.3'):
            status, response = call(action, payload, key, component)
            expect(status == 200 and response.get('ok') is True, (action, status, response))
            return response['result']

        def status():
            return ok('provider.worker.status', {})

        def asks(subject):
            # 3.23: provider Asks live in hyperfide.asks, tied to their subject by provider_resolution_ask_links.
            return f.sql('SELECT a.id,a.kind,a.state,a.recommended,l.resolution_id,a.raised_by AS raised_by_credential_id FROM hyperfide.provider_resolution_ask_links l JOIN hyperfide.asks a ON a.organisation_id=l.organisation_id AND a.id=l.ask_id WHERE l.organisation_id=$1 AND l.subject_key=$2 ORDER BY a.raised_at,a.id', [org, subject])

        def passes_beyond(count, more):
            return intents.wait_for(lambda: (lambda s: s if s['escalation']['passes'] >= count + more else None)(status()),
                                    'worker loop did not complete further escalation passes')

        ok('provider.pools.configure', {}, component='8.2')
        # The run is inserted directly (no spec import), so it registers the operator channel provider Asks need.
        f.sql("INSERT INTO hyperfide.event_consumers(organisation_id,run_id,id,consumer_key,critical,state) VALUES($1,$2,$3,'operator:asks',false,'ACTIVE')", [org, f.ids['run'], str(uuid.uuid4())])
        native = 'unattributed-' + str(uuid.uuid4())
        subject = 'orphan:' + f.pool + ':' + native
        orphan = {'pool_id': f.pool, 'native_sandbox_id': native}

        check('v21.2.16.interval-setting', lambda: run(['node', '--input-type=module', '-e', SETTINGS_PROBE], f.env))

        def started():
            result = ok('provider.worker.start', {}, key='provisioner')
            expect(result['running'] is True and result['settings']['escalate_ms'] == INTERVAL_MS, result)
            # A worker with nothing overdue completes passes and raises nothing.
            s = passes_beyond(0, 2)
            expect(s['escalation']['raised'] == 0 and 'escalate' not in s['errors'], s)
            expect(f.sql('SELECT count(*)::int AS n FROM hyperfide.provider_resolution_ask_links WHERE organisation_id=$1', [org])[0]['n'] == 0, 'Ask raised with nothing overdue')
        check('v21.2.16.loop-runs-without-subjects', started)

        state = {}

        def raised():
            f.sql('INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id) VALUES($1,$2,$3)', [org, f.pool, native])
            rows = intents.wait_for(lambda: asks(subject), 'worker loop never escalated the overdue orphan')
            expect(len(rows) == 1, ('exactly one Ask expected', rows))
            row = rows[0]
            expect(row['kind'] == 'decision' and row['state'] == 'OPEN' and row['recommended'] == 'RETAIN', row)
            expect(row['raised_by_credential_id'] == f.ids['provisioner'], ('Ask not raised by the worker credential', row))
            s = intents.wait_for(lambda: (lambda x: x if x['escalation']['raised'] == 1 else None)(status()), 'worker status does not count the raised Ask')
            expect(s['escalation']['last_at'], s)
            state['passes'] = s['escalation']['passes']
        check('v21.2.16.overdue-orphan-raises-one-ask', raised)

        def deduplicated():
            s = passes_beyond(state['passes'], 3)
            expect(s['escalation']['raised'] == 1 and s['escalation']['last_raised'] == [], ('later pass raised again', s['escalation']))
            expect(len(asks(subject)) == 1, ('second pass duplicated the Ask', asks(subject)))
        check('v21.2.16.second-pass-raises-none', deduplicated)

        def answered():
            result = ok('provider.orphans.resolve', {**orphan, 'resolution': 'RETAIN', 'reason': 'operator adopts the resource after the Ask', 'evidence_digest': None})
            expect(result['resolved'] is True and result['state'] == 'RETAINED', result)
            rows = asks(subject)
            expect(len(rows) == 1 and rows[0]['state'] == 'ANSWERED' and rows[0]['resolution_id'], rows)
            s = passes_beyond(status()['escalation']['passes'], 2)
            expect(s['escalation']['raised'] == 1 and len(asks(subject)) == 1, ('resolved subject escalated again', s['escalation'], asks(subject)))
        check('v21.2.16.resolved-subject-answered', answered)

        def window_required():
            f.stop()
            del f.env['HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS']
            f.start()
            status_code, response = call('provider.resolutions.escalate', {})
            expect((status_code >= 400 or response.get('ok') is False) and 'RESOLUTION_WINDOW_REQUIRED' in json.dumps(response), ('escalate accepted without a window', response))
            ok('provider.worker.start', {}, key='provisioner')
            s = intents.wait_for(lambda: (lambda x: x if x['errors'].get('escalate') == 'RESOLUTION_WINDOW_REQUIRED' else None)(status()),
                                 'worker loop did not surface the missing window')
            expect(s['running'] is True and s['escalation']['passes'] == 0, ('missing window stopped the loop or counted a pass', s))
        check('v21.2.16.window-required', window_required)

        def disabled():
            f.stop()
            f.env['HYPERFIDE_PROVIDER_RESOLUTION_WINDOW_SECONDS'] = '1'
            f.env['HYPERFIDE_RESOLUTION_ESCALATE_INTERVAL_MS'] = '0'
            f.start()
            second = 'unattributed-' + str(uuid.uuid4())
            f.sql('INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id) VALUES($1,$2,$3)', [org, f.pool, second])
            ok('provider.worker.start', {}, key='provisioner')
            time.sleep(2.5)
            s = status()
            expect(s['running'] is True and s['settings']['escalate_ms'] == 0 and s['escalation']['passes'] == 0, s)
            expect(asks('orphan:' + f.pool + ':' + second) == [], 'disabled cadence still escalated')
        check('v21.2.16.zero-interval-disables', disabled)
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
            (Path(campaign) / 'v21-2-16-observations.json').write_text(
                json.dumps({'assertions': OBSERVED, 'cluster_removed': clean}, indent=2) + '\n')
    return 1 if FAILED or not clean else 0


if __name__ == '__main__':
    sys.exit(main())
