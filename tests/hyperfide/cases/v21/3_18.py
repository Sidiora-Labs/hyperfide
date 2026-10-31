#!/usr/bin/env python3
"""hyperfide-v21 3.18: load-tolerant suites and honest skips.

Two halves. Under load: N busy workers (one per CPU unless HF_3_18_WORKERS says
otherwise) spin while 14_vscode.sh, 42_journal.sh and 48_plugin.sh run, and each
must pass, so their timing checks measure work or a budget taken from the same
run rather than the host's wall clock. Against broken inputs, with the workers
stopped so a failure cannot be blamed on load: each formerly weak assertion runs
on a mirror of the suite whose code under test is deliberately broken and must
fail on that assertion, and each formerly dishonest skip must say SKIP and exit 77.
"""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
CG = Path(os.environ.get('CG') or ROOT / 'cg').resolve()
FAILED = []


def check(name, ok, detail=''):
    if not ok:
        FAILED.append(name)
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': True, 'actual': bool(ok),
                      **({'detail': str(detail)[-1500:]} if not ok and detail else {})}), flush=True)


def run(cmd, env=None, timeout=1800, cwd=None):
    e = dict(os.environ, CG=str(CG))
    e.update(env or {})
    p = subprocess.run(cmd, cwd=cwd or ROOT, env=e, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                       text=True, timeout=timeout)
    return p.returncode, p.stdout


class Load:
    """Busy workers: each spins one CPU until stopped."""
    def __init__(self, n):
        self.n, self.procs = n, []

    def __enter__(self):
        # PR_SET_PDEATHSIG: a worker dies with this case, even when it is killed
        spin = 'import ctypes\nctypes.CDLL(None).prctl(1, 9)\nwhile True: pass'
        self.procs = [subprocess.Popen([sys.executable, '-c', spin]) for _ in range(self.n)]
        return self

    def __exit__(self, *exc):
        for p in self.procs:
            p.kill()
        for p in self.procs:
            p.wait()
        return False


def mirror(suites):
    """A copy of the suites, tests/lib.sh and extensions/vscode laid out as in the
    repository, so a mutation never touches the real tree."""
    top = Path(tempfile.mkdtemp(prefix='hf-3-18-'))
    (top / 'tests/integration').mkdir(parents=True)
    shutil.copy(ROOT / 'tests/lib.sh', top / 'tests/lib.sh')
    (top / 'tests/fixtures').symlink_to(ROOT / 'tests/fixtures')
    for s in suites:
        shutil.copy(ROOT / 'tests/integration' / s, top / 'tests/integration' / s)
    shutil.copytree(ROOT / 'extensions/vscode', top / 'extensions/vscode', ignore=shutil.ignore_patterns('node_modules'))
    return top


def mutate(path, old, new):
    text = path.read_text()
    if old not in text:
        raise AssertionError('mutation anchor missing in %s: %r' % (path, old[:80]))
    path.write_text(text.replace(old, new, 1))


def broken(name, top, suite, section, expect, env=None):
    cmd = ['bash', str(top / 'tests/integration' / suite)] + ([section] if section else [])
    rc, out = run(cmd, env=env)
    check(name, rc not in (0, 77) and expect in out, 'rc=%d\n%s' % (rc, out))


# A cg whose `serve` sits on every pushed events notification for 2.5 s while it
# answers requests at once: the server that waits for its next poll.
LATE_EVENTS = r'''#!/usr/bin/env python3
import os, subprocess, sys, threading, time
real = os.environ['HF_REAL_CG']
if sys.argv[1:2] != ['serve']:
    os.execv(real, [real] + sys.argv[1:])
p = subprocess.Popen([real] + sys.argv[1:], stdout=subprocess.PIPE)
lock = threading.Lock()
def put(line):
    with lock:
        sys.stdout.buffer.write(line); sys.stdout.buffer.flush()
for line in p.stdout:
    if line.startswith(b'{"jsonrpc":"2.0","method":"events"'):
        threading.Timer(2.5, put, (line,)).start()
    else:
        put(line)
sys.exit(p.wait())
'''


def under_load():
    workers = int(os.environ.get('HF_3_18_WORKERS') or os.cpu_count() or 4)
    before = os.getloadavg()[0]
    with Load(workers):
        time.sleep(3)
        for suite in ['14_vscode.sh', '42_journal.sh', '48_plugin.sh']:
            started = time.monotonic()
            rc, out = run(['bash', str(ROOT / 'tests/integration' / suite)])
            honest = rc == 0 or (rc == 77 and re.search(r'^SKIP: ', out, re.M))
            check('load.%s' % suite, honest, 'rc=%d\n%s' % (rc, out))
            print(json.dumps({'type': 'observation', 'suite': suite, 'rc': rc, 'seconds': round(time.monotonic() - started),
                              'load': round(os.getloadavg()[0], 1), 'workers': workers}), flush=True)
    print(json.dumps({'type': 'observation', 'load_before': round(before, 1)}), flush=True)


def broken_inputs():
    top = mirror(['14_vscode.sh', '42_journal.sh', '48_plugin.sh'])
    ext = top / 'extensions/vscode'
    pristine = {f: (ext / f).read_text() for f in ['agents.js', 'fleet.js', 'serve.js']}
    try:
        # the mirror itself passes, so a failure below is the mutation's
        rc, out = run(['bash', str(top / 'tests/integration/14_vscode.sh'), 'fleetchat'])
        check('mirror.passes', rc == 0, out)

        # a window that re-serialises the transcript on every push
        mutate(ext / 'agents.js', 'this.hidden.push(...gone);',
               'this.hidden = JSON.parse(JSON.stringify(this.hidden.concat(gone)));')
        broken('broken.window-pushes', top, '14_vscode.sh', 'fleetchat', '10000 pushes took')
        (ext / 'agents.js').write_text(pristine['agents.js'])

        # a decoration that does half a second of work
        mutate(ext / 'fleet.js', '    if (!model) return model;\n    const i = input || {};',
               '    if (!model) return model;\n    for (const end = Date.now() + 500; Date.now() < end;) { /* work */ }\n    const i = input || {};')
        broken('broken.decoration', top, '14_vscode.sh', 'start', 'decoration is instant')
        (ext / 'fleet.js').write_text(pristine['fleet.js'])

        # patches that make a round trip, or answer later, before the row is right
        tasks_js = (ext / 'tasks.js').read_text()
        mutate(ext / 'tasks.js', 'function patchRows(rows, feature, applied) {\n',
               "function patchRows(rows, feature, applied) {\n    require('child_process').spawnSync('true');\n")
        broken('broken.row-patch-round-trip', top, '14_vscode.sh', 'serve', 'the patch made a round trip')
        (ext / 'tasks.js').write_text(tasks_js)
        mutate(ext / 'fleet.js', 'function patchSessions(sessions, liveNative, now) {\n',
               'function patchSessions(sessions, liveNative, now) {\n    return Promise.resolve(0);\n')
        broken('broken.session-patch-async', top, '14_vscode.sh', 'fleet', 'the patch returned a promise')
        (ext / 'fleet.js').write_text(pristine['fleet.js'])

        # events that arrive with the server's next poll, not on the write
        late = top / 'late-cg'
        late.write_text(LATE_EVENTS)
        late.chmod(0o755)
        broken('broken.event-push', top, '14_vscode.sh', 'serve', 'event took',
               env={'CG': str(late), 'HF_REAL_CG': str(CG)})

        # a client that decides on stderr without waiting for the stream to close
        # (an old cg can trip it before the delayed one does: same drain)
        mutate(ext / 'serve.js', 'if (proc.exitCode !== null) {', 'if (false) {')
        broken('broken.delayed-old-cg', top, '14_vscode.sh', 'serve', 'cg: reported as unsupported')
        (ext / 'serve.js').write_text(pristine['serve.js'])

        # a lock window that closes before the writes under it are done
        mutate(top / 'tests/integration/42_journal.sh', 'HOLD_CAP_S=600', 'HOLD_CAP_S=0.05')
        broken('broken.journal-window', top, '42_journal.sh', None, 'FAIL:')

        # no claude on PATH: the validate check cannot run, so the suite skips
        path = ':'.join(d for d in os.environ.get('PATH', '').split(':') if d and not os.access(os.path.join(d, 'claude'), os.X_OK))
        rc, out = run(['bash', str(ROOT / 'tests/integration/48_plugin.sh')], env={'PATH': path})
        check('skip.plugin-validate', rc == 77 and re.search(r'^SKIP: claude not on PATH', out, re.M), 'rc=%d\n%s' % (rc, out))
    finally:
        shutil.rmtree(top, ignore_errors=True)

    env = {k: v for k, v in os.environ.items() if k != 'DATABASE_URL'}
    for case in ['29_7.py', '9_4.py', '8_2.py']:
        p = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/cases/tasks' / case)], cwd=ROOT, env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=300)
        check('skip.%s' % case, p.returncode == 77 and p.stdout.startswith('SKIP: DATABASE_URL'), 'rc=%d\n%s' % (p.returncode, p.stdout))

    pointer = ROOT / 'tests/integration/81_workflow_pointer.sh'
    staged = subprocess.run(['git', 'ls-files', '-s', str(pointer)], cwd=ROOT, stdout=subprocess.PIPE, text=True).stdout
    check('pointer.executable', os.access(pointer, os.X_OK) and (not staged or staged.startswith('100755')), staged)

    spec = importlib.util.spec_from_file_location('hf_case_2_8', ROOT / 'tests/hyperfide/cases/v21/2_8.py')
    case = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(case)

    class NoReaper:
        """a kernel that refuses PR_SET_CHILD_SUBREAPER"""
        def prctl(self, *args):
            return -1
    check('fixture-root.fails-without-subreaper', case.fixture_root(NoReaper())[0] is False)
    check('fixture-root.fails-without-root', case.fixture_root(ctypes.CDLL(None, use_errno=True), euid=1000)[0] is False)
    if os.geteuid() == 0:
        ok, detail = case.fixture_root(ctypes.CDLL(None, use_errno=True))
        check('fixture-root.holds-as-root', ok, detail)

    ext = (ROOT / 'extensions/vscode/extension.js').read_text()
    handler = re.search(r"serveClient\.on\('reconnect', \(\) => \{(.*?)\}\);", ext, re.S)
    check('reconnect.no-dead-watch-call', handler and 'watchEvents' not in handler.group(1), handler and handler.group(0))


# What a supervising `cg spec done` hands its verify_cmd: cg exports every alias
# of a variable it was given, so a suite that sets CG_X per command conflicts
# with the inherited HYPERFIDE_X (exit 78) unless it starts the pair unset.
HOST_ENV = {f'{p}_{n}': v for n, v in [('AGENT', 'host-agent'), ('BUSY_TIMEOUT_MS', '5000'),
                                       ('CLAUDE', '/definitely/host/claude')]
            for p in ('CG', 'HYPERFIDE')}


def host_env():
    for suite in ['42_journal.sh', '48_plugin.sh']:
        rc, out = run(['bash', str(ROOT / 'tests/integration' / suite)], env=HOST_ENV)
        honest = rc == 0 or (rc == 77 and re.search(r'^SKIP: ', out, re.M))
        check('host-env.%s' % suite, honest, 'rc=%d\n%s' % (rc, out))
    top = mirror(['42_journal.sh'])
    try:
        suite = top / 'tests/integration/42_journal.sh'
        mutate(suite, 'unset CG_AGENT HYPERFIDE_AGENT CG_BUSY_TIMEOUT_MS HYPERFIDE_BUSY_TIMEOUT_MS\n', '')
        rc, out = run(['bash', str(suite)], env=HOST_ENV)
        check('host-env.broken-without-unset', rc == 78, 'rc=%d\n%s' % (rc, out))
    finally:
        shutil.rmtree(top, ignore_errors=True)


def main():
    if not CG.exists():
        print('assertion failed: build cg first (make -j2 cg) or set CG', file=sys.stderr)
        return 1
    if not shutil.which('node'):
        print('SKIP: node not on PATH', flush=True)
        return 77
    under_load()
    host_env()
    broken_inputs()
    print(json.dumps({'type': 'summary', 'failed': FAILED}), flush=True)
    return 1 if FAILED else 0


if __name__ == '__main__':
    sys.exit(main())
