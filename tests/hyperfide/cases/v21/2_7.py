#!/usr/bin/env python3
"""hyperfide-v21 2.7: stdio mode with the identity component (14.1) loaded refuses at start
and names the configuration, instead of answering every call with AUTH_REQUIRED.

Runs against an owned PostgreSQL cluster (the tests/hyperfide/cases/tasks/29_5.py pattern) so the
identity configuration is real: the same policy, registrations and environment serve a signed read
over HTTPS, and a registration set without 14.1 serves the same read over stdio."""
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[4]
SERVICE = ROOT / 'services/hyperfide'
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
FAILED = []
SUPERUSER = 'hf_superuser'
ROLES = ('control', 'provisioner', 'dispatch')


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
    print(json.dumps({'type': 'assertion', 'id': 'stdio.identity.' + name, 'expected': 'observed', 'actual': actual}), flush=True)


def skip(reason):
    print('SKIP: ' + reason, flush=True)
    raise SystemExit(77)


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    # Client-only packages also create /usr/lib/postgresql/N/bin, so take the newest version that ships a server.
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin') if (path / 'initdb').exists()),
                       key=lambda path: int(path.parent.name))
    return installed[-1] if installed else None


class Cluster:
    """Owned single-node cluster reachable only through its private socket directory."""

    def __init__(self, binaries):
        self.bin = binaries
        Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='hf-v21-2-7-', dir='/tmp/hyperfide'))
        owner = pwd.getpwnam('postgres')
        os.chown(self.root, owner.pw_uid, owner.pw_gid)
        self.data = self.root / 'data'
        self.process = None
        self.server('initdb', '-D', self.data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (self.data / 'postgresql.conf').open('a') as conf:
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(self.root) + "'\n")
            # The cluster is discarded at exit, so durability settings only cost time on a loaded host.
            conf.write("fsync=off\nfull_page_writes=off\n")
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
        p = subprocess.run(['runuser', '-u', 'postgres', '--', str(self.bin / program), *map(str, args)],
                           cwd=ROOT, text=True, capture_output=True, timeout=120)
        if p.returncode:
            raise AssertionError(program + ' failed: ' + p.stderr[:800])
        return p

    def url(self, database='postgres'):
        return 'postgresql://' + quote(SUPERUSER) + '@localhost:5432/' + database + '?host=' + quote(str(self.root), safe='')

    def migrate_template(self):
        # IdentityFixture creates its database from template1 and applies the release migrations within a fixed
        # 30 s deadline, which a loaded fleet host can exceed. Applying the same migrations to template1 first
        # (each committed migration persists, so a deadline-cut run resumes on retry) leaves the fixture's own
        # apply a real checksum verification of an already-current schema.
        script = ("import {createResourceContainer} from './services/hyperfide/dist/storage/runtime.js';"
                  "import {MigrationCoordinator} from './services/hyperfide/dist/storage/durability.js';"
                  "const signal=new AbortController().signal;"
                  "const r=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:process.env.DATABASE_URL},signal});"
                  "try{await new MigrationCoordinator(r).apply({timeoutMs:30000,signal});}finally{await r.close();}")
        env = dict(os.environ, DATABASE_URL=self.url('template1'), HYPERFIDE_PG_STATEMENT_TIMEOUT_MS='30000',
                   HYPERFIDE_PG_LOCK_TIMEOUT_MS='30000', HYPERFIDE_PG_CONNECT_TIMEOUT_MS='30000')
        for _ in range(12):
            p = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, env=env, text=True, capture_output=True, timeout=60)
            if p.returncode == 0:
                return
        raise AssertionError('template migration did not complete: ' + p.stderr[:1200])

    def close(self):
        if self.process and self.process.poll() is None:
            self.server('pg_ctl', '-D', self.data, '-m', 'fast', '-w', '-t', '60', 'stop')
        if self.process:
            self.process.wait(timeout=60)
        shutil.rmtree(self.root, ignore_errors=True)


def service(role, policy, components, env, frames, mode='stdio'):
    argv = ['node', str(SERVICE / 'dist' / (role + '.js')), '--policy', str(policy), '--spec-revision', 'fixture-identity-v1',
            '--components', str(components), '--module-root', str(SERVICE / 'dist'), '--mode', mode]
    child = subprocess.run(argv, input=''.join(json.dumps(frame) + '\n' for frame in frames), text=True,
                           cwd=ROOT, env=env, capture_output=True, timeout=60)
    rows = [json.loads(line) for line in child.stdout.splitlines() if line.startswith('{')]
    errors = [json.loads(line) for line in child.stderr.splitlines() if line.startswith('{')]
    return child, rows, errors


def refused(role, policy, components, env):
    frame = {'id': 'stdio-identity-' + role, 'component': '4.4', 'action': 'storage.migrations.inspect', 'input': {}}
    child, rows, errors = service(role, policy, components, env, [frame])
    detail = json.dumps({'exit': child.returncode, 'stdout': rows, 'stderr': child.stderr[:600]})
    expect(child.returncode == 1, 'stdio start with 14.1 did not exit 1: ' + detail)
    expect(not rows, 'stdio with 14.1 answered a request instead of refusing at start: ' + detail)
    expect(not any(e.get('error', {}).get('code') == 'AUTH_REQUIRED' for e in errors), 'refusal is still AUTH_REQUIRED: ' + detail)
    refusal = [e['error'] for e in errors if e.get('error', {}).get('code') == 'TRANSPORT_CONFIG']
    expect(len(refusal) == 1, 'no single TRANSPORT_CONFIG refusal: ' + detail)
    message = refusal[0]['message']
    for token in ('stdio', role, str(components), '14.1', '--mode https', 'HF_IDENTITY_CONFIG_FILE', '--components'):
        expect(token in message, 'refusal does not name ' + token + ': ' + message)


def main():
    stamp = subprocess.run(['node', str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(SERVICE)],
                           text=True, capture_output=True, timeout=120)
    if stamp.returncode:
        print(json.dumps({'type': 'assertion', 'id': 'stdio.identity.dist-current', 'expected': 'observed',
                          'actual': 'dist does not match source; run npm --prefix services/hyperfide run build: ' + (stamp.stdout + stamp.stderr)[:400]}))
        return 1
    binaries = postgres_bin()
    if binaries is None or not (binaries / 'initdb').exists():
        skip('no PostgreSQL server binaries; set HYPERFIDE_PG_BIN')
    if os.geteuid() != 0 or shutil.which('runuser') is None:
        skip('owned cluster needs root and runuser to start PostgreSQL as the postgres user')
    try:
        pwd.getpwnam('postgres')
    except KeyError:
        skip('no postgres system user for the owned cluster')

    cluster = Cluster(binaries)
    fixture = None
    try:
        cluster.migrate_template()
        os.environ['DATABASE_URL'] = cluster.url()
        import identity_fixture
        # Starts control in HTTPS mode on the real identity path; construction fails if it never becomes ready.
        # Its setup steps carry fixed storage deadlines, so a loaded host gets two more attempts on TX_TIMEOUT only.
        for attempt in range(3):
            try:
                fixture = identity_fixture.IdentityFixture()
                break
            except AssertionError as error:
                if 'TX_TIMEOUT' not in str(error) or attempt == 2:
                    raise

        def https_signed_read():
            status, response = fixture.request(fixture.operation('4.4', 'storage.migrations.inspect', {}))
            expect(status == 200 and response.get('ok') is True,
                   'signed HTTPS read failed with the same configuration: ' + json.dumps(response)[:600])
        check('https-serves-same-configuration', https_signed_read)

        check('stdio-refuses-at-start', lambda: refused('control', fixture.policy, fixture.components, fixture.env))

        def refused_before_factories():
            # With no reachable database and no identity file, any factory that ran would fail as COMPONENT_LOAD_FAILED.
            env = dict(fixture.env)
            dead = 'postgresql://nobody@localhost:5432/none?host=' + quote(str(fixture.path / 'no-socket'), safe='')
            for key in [k for k in env if k.endswith('DATABASE_URL')]:
                env[key] = dead
            env.pop('HF_IDENTITY_CONFIG_FILE', None)
            for role in ROLES:
                refused(role, fixture.policy, fixture.components, env)
        check('stdio-refuses-before-any-component-loads', refused_before_factories)

        def stdio_without_identity_serves():
            components = fixture.path / 'components-without-identity'
            components.mkdir()
            for registration in fixture.components.glob('*.json'):
                if registration.name != '14.1.json':
                    shutil.copyfile(registration, components / registration.name)
            frames = [{'id': 'describe', 'component': 'system', 'action': 'system.describe', 'input': {}},
                      {'id': 'read', 'component': '4.4', 'action': 'storage.migrations.inspect', 'input': {}}]
            child, rows, _ = service('control', fixture.policy, components, fixture.env, frames)
            detail = json.dumps({'exit': child.returncode, 'stdout': rows, 'stderr': child.stderr[:600]})[:1200]
            expect(child.returncode == 0 and len(rows) == 2 and all(row.get('ok') is True for row in rows),
                   'stdio without 14.1 did not serve the read: ' + detail)
            loaded = [component['id'] for component in rows[0]['result']['components']]
            expect('14.1' not in loaded and '4.4' in loaded, 'unexpected component set: ' + detail)
        check('stdio-without-identity-serves-read', stdio_without_identity_serves)
    finally:
        # The fixture's database and runtime role live only in the owned cluster, so discarding the cluster
        # replaces the per-object DROPs that a loaded host can time out.
        try:
            if fixture:
                fixture.stop()
        finally:
            try:
                cluster.close()
            finally:
                if fixture:
                    fixture.database_created = fixture.runtime_role_created = False
                    fixture.folder.cleanup()
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 1 if FAILED else 0


if __name__ == '__main__':
    raise SystemExit(main())
