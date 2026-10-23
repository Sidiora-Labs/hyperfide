"""Temporary qualification projection until the wave 2-4 plugins land.

QualificationProjection is deliberately confined here for replacement by the
shared platform RPC fixture. Evidence uses the existing closure checker format.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
BUILD = [ROOT / 'platform/apps' / app / 'dist/index.js'
         for app in ('server', 'host-daemon')]


def require_platform_build():
    missing = [str(p.relative_to(ROOT)) for p in BUILD if not p.is_file()]
    if missing:
        print('SKIP 77 platform build absent: ' + ', '.join(missing))
        raise SystemExit(77)


def closure_module():
    spec = importlib.util.spec_from_file_location(
        'hyperfide_closure', ROOT / 'tests/hyperfide/closure_check.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class QualificationProjection:
    """Local adapter for the unmerged qualification and publication RPCs."""

    def __enter__(self):
        require_platform_build()
        self.temp = tempfile.TemporaryDirectory(prefix='hyperfide-platform-')
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.env = dict(os.environ, HYPERFIDE_DATA_DIR=str(self.base / 'data'),
                        GIT_AUTHOR_NAME='Hyperfide', GIT_COMMITTER_NAME='Hyperfide',
                        GIT_AUTHOR_EMAIL='fixture@hyperfide.dev',
                        GIT_COMMITTER_EMAIL='fixture@hyperfide.dev')
        self.processes = []
        self.logs = []
        try:
            for entry, key in zip(BUILD, ('HYPERFIDE_SERVER_PORT', 'HYPERFIDE_HOST_DAEMON_PORT')):
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                self.env[key] = str(port)
            self.env['HYPERFIDE_SERVER_BIND_HOST'] = '127.0.0.1'
            self.env['HYPERFIDE_SERVER_URL'] = 'http://127.0.0.1:' + self.env['HYPERFIDE_SERVER_PORT']
            # Keep catalog traffic local; qualification installs no catalog plugins.
            self.env['HYPERFIDE_MARKETPLACE_URL'] = self.env['HYPERFIDE_SERVER_URL'] + '/fixture-catalog.json'
            for entry, key in zip(BUILD, ('HYPERFIDE_SERVER_PORT', 'HYPERFIDE_HOST_DAEMON_PORT')):
                if key == 'HYPERFIDE_HOST_DAEMON_PORT':
                    request = urllib.request.Request(
                        self.env['HYPERFIDE_SERVER_URL'] + '/internal/hosts/enroll-key',
                        data=b'{}', headers={'Content-Type': 'application/json'})
                    with urllib.request.urlopen(request, timeout=10) as response:
                        enrollment = json.load(response)
                        self.env['HYPERFIDE_HOST_ENROLL_KEY'] = enrollment['enrollKey']
                        self.env['HYPERFIDE_HOST_ID'] = enrollment['hostId']
                log = (self.base / (entry.parent.parent.name + '.log')).open('w+')
                self.logs.append(log)
                proc = subprocess.Popen(['node', str(entry)], cwd=self.base,
                                        env=self.env, stdout=log, stderr=log)
                self.processes.append(proc)
                deadline = time.monotonic() + 45
                while True:
                    if proc.poll() is not None or time.monotonic() > deadline:
                        log.seek(0)
                        raise RuntimeError('platform startup failed: ' + log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', int(self.env[key])), .2):
                            break
                    except OSError:
                        time.sleep(.1)
            self.git('init', '-q', '-b', 'main')
            self.write('.gitignore', '.codegraph/\nartifacts/\n')
            self.write('src/value.txt', 'pending\n')
            self.write('verify.py', "import pathlib\nassert pathlib.Path('src/value.txt').read_text() == 'implemented\\n'\nprint('lane verified')\n")
            self.write('manifest.json', '{}\n')
            self.write('spec/workflow.kvx', '[meta]\nactive_feature = "hyperfide"\n[mode]\nname = "prod"\n')
            self.spec = self.repo / 'spec/hyperfide/spec.kvx'
            self.write('spec/hyperfide/spec.kvx', '[meta]\nfeature = "hyperfide"\n[task.1.1]\ntitle = "Fixture task"\nstatus = "pending"\nwave = 1\nrequires = []\ntouches = ["src/value.txt"]\nverify_cmd = "python3 verify.py --case V-001 --manifest manifest.json"\n')
            self.git('add', '.')
            self.git('commit', '-qm', 'Fixture base')
            self.base_commit = self.git('rev-parse', 'HEAD').stdout.strip()
            self.run([str(ROOT / 'cg'), 'init'])
            self.remote = self.base / 'remote.git'
            self.run(['git', 'init', '--bare', '-q', str(self.remote)])
            self.git('remote', 'add', 'origin', str(self.remote))
            return self
        except BaseException:
            for log in self.logs:
                log.flush()
                log.seek(0)
                print(log.read()[-8000:])
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *args):
        for proc in reversed(self.processes):
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for log in self.logs:
            log.close()
        self.temp.cleanup()

    def run(self, argv, check=True):
        result = subprocess.run(argv, cwd=self.repo, env=self.env,
                                text=True, capture_output=True, timeout=90)
        if check and result.returncode:
            raise RuntimeError(f'{argv}: {result.returncode}\n{result.stdout}{result.stderr}')
        return result

    def git(self, *args):
        return self.run(['git', *args])

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def status(self, value):
        self.spec.write_text(re.sub(r'^status = .*$', 'status = ' + json.dumps(value),
                                   self.spec.read_text(), flags=re.M))

    def implement(self):
        self.run([str(ROOT / 'cg'), 'spec', 'start', '1.1'])
        self.write('src/value.txt', 'implemented\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Implement fixture value')
        self.run([str(ROOT / 'cg'), 'spec', 'implemented', '1.1'])
        self.git('add', '.')
        self.git('commit', '-qm', 'Record implementation')

    def qualify(self):
        closure = closure_module()
        started = time.monotonic()
        lane = self.run(['python3', 'verify.py', '--case', 'V-001', '--manifest', 'manifest.json'])
        self.lane = dict(state='passed', exit=lane.returncode,
                         duration=time.monotonic() - started)
        campaign = 'artifacts/hyperfide/tasks/1.1/campaigns/qualification'
        self.write(campaign + '/lane.log', lane.stdout + lane.stderr)
        # Independent checker process reruns verification and inspects the diff.
        diff = self.git('diff', self.base_commit, 'HEAD', '--', 'src/value.txt').stdout
        assert '+implemented' in diff
        checker = self.run(['python3', '-I', 'verify.py'])
        self.checker = dict(provider='hyperfide-checker', worker='hyperfide-worker',
                            verdict='pass', exit=checker.returncode)
        self.status('done')
        commit = self.git('rev-parse', 'HEAD').stdout.strip()
        receipt = dict(receipt_id='qualification', task='1.1', selected_case_ids=['V-001'],
                       outcome='PASS', diagnostics=[], source={'commit': commit},
                       manifest_sha256=closure.sha((self.repo / 'manifest.json').read_bytes()),
                       inputs=[dict(original_path=name, sha256=closure.sha((self.repo / name).read_bytes()))
                               for name in ('src/value.txt', 'verify.py')],
                       verify_cmd='python3 verify.py --case V-001 --manifest manifest.json',
                       evidence_paths=[campaign + '/lane.log', campaign + '/checks/qualification.json'],
                       toolchain={'python': self.run(['python3', '--version']).stdout.strip(),
                                  'node': self.run(['node', '--version']).stdout.strip()},
                       **{'exit': 0, 'duration': self.lane['duration']})
        receipt['seal'] = closure.sha(closure.canonical(receipt))
        self.receipt_path = self.write(campaign + '/receipts/qualification.json',
                                       closure.canonical(receipt).decode() + '\n')
        self.write(campaign + '/checks/qualification.json', json.dumps(dict(
            status='PASS', receipt_sha256=closure.sha(self.receipt_path.read_bytes()), **self.checker)))
        self.write('artifacts/hyperfide/tasks/1.1/evidence-index.json', json.dumps(dict(
            task='1.1', commit=commit, requalified_on=commit, exit_code=0)))
        return receipt

    def closure(self):
        return self.run([sys.executable, str(Path(__file__).resolve()),
                         '--closure-json', str(self.repo)]).stdout

    def close_wave(self):
        if any(proc.poll() is not None for proc in self.processes):
            raise RuntimeError('platform exited during qualification')
        result = json.loads(self.closure())
        if result['failures'] or self.lane['state'] != 'passed' or self.checker['verdict'] != 'pass':
            raise RuntimeError('wave closure blocked')
        self.closed = True
        self.run([str(ROOT / 'cg'), 'ask', 'raise', 'permission',
                  'Publish fixture wave to local remote?', '--task', '1.1'])
        listing = self.run([str(ROOT / 'cg'), 'ask', 'list', '--json']).stdout
        self.ask_listing = listing
        asks = json.loads(listing)['asks']
        if len(asks) != 1 or asks[0]['kind'] != 'permission' or asks[0]['state'] != 'open':
            raise RuntimeError('permission Ask id missing: ' + listing)
        self.ask_id = str(asks[0]['id'])

    def publish(self):
        listing = self.run([str(ROOT / 'cg'), 'ask', 'list', '--all', '--json']).stdout
        # Require the answer recorded in the actual Ask store.
        records = json.loads(listing)
        if isinstance(records, dict):
            records = records.get('asks', [])
        ask = next(a for a in records if str(a['id']) == self.ask_id)
        if ask.get('answer') != 'approve' or ask.get('state') != 'answered':
            raise PermissionError('publication permission unanswered')
        assert self.closed
        self.git('add', '.')
        self.git('commit', '-qm', 'Record qualification')
        self.git('checkout', '-qb', 'publication', self.base_commit)
        self.git('merge', '--squash', 'main')
        self.git('commit', '-qm', 'Publish fixture task [spec:hyperfide/1.1]')
        self.git('push', 'origin', 'publication')
        return self.git('rev-parse', 'HEAD').stdout.strip()


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != '--closure-json':
        raise SystemExit('usage: platform_fixture.py --closure-json ROOT')
    root = Path(sys.argv[2])
    failures = closure_module().check_task(
        root, (root / 'spec/hyperfide/spec.kvx').read_text(),
        root / 'artifacts/hyperfide/tasks', '1.1')
    print(json.dumps(dict(task='1.1', status='FAIL' if failures else 'PASS', failures=failures)))
