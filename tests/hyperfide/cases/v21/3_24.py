#!/usr/bin/env python3
"""hyperfide-v21 3.24: harness and docs hygiene.

Proves that the names deploy/hyperfide/env/control.env.example and
docs/hyperfide/operations.md document are the names the control service code
reads (in both directions), that the documented commands and script flags
exist, that cases 24_1, 15_1, 29_5 and 13_4 skip honestly (exit 77, one SKIP
line) when their preconditions are absent and that 24_1's sql() connects
through DATABASE_URL to an owned cluster, that runner/bridge.ts bounds the
heartbeat with the placement constant, that runtime_workspace_revision reads
the built-in store's stat cache, and that serve.js keeps no unused method.
"""
import hashlib, json, os, re, shutil, sqlite3, subprocess, sys, tempfile, time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[4]
SRC = ROOT / 'core/control-plane/src'
CG = ROOT / 'cg'
EXAMPLE = ROOT / 'deploy/hyperfide/env/control.env.example'
OPS = ROOT / 'docs/hyperfide/operations.md'
CASES = ROOT / 'tests/hyperfide/cases/tasks'
WITHPG = ROOT / 'tests/hyperfide/support/withpg.py'
NAMED = ('HYPERFIDE_DRAIN_TIMEOUT_MS', 'HYPERFIDE_DRAIN_FALLBACK_MODE',
         'HYPERFIDE_OFFLINE_POLICY', 'HYPERFIDE_MAX_OFFLINE_MS')
FAILED, SKIPPED = [], []

# Names a module mentions without being configuration the operator sets:
# process-supplied (PATH, git's push-option and askpass protocol) and the lock handshake token.
NOT_CONFIGURATION = {'PATH', 'HF_LOCK_READY'}
# The 26.3 rename table lists CLI variable names to migrate; it reads none of them.
RENAME_TABLE = 'migration/names.ts'

IMPORT = re.compile(r"""(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)""", re.S)
READ = re.compile(r"""\b(?:env|ENV|environment)\s*(?:\?\.|\.)\s*([A-Z][A-Z0-9_]*[A-Z0-9])\b(?!\s*=(?!=))"""
                  r"""|\b(?:env|ENV|environment)\s*\[\s*['"]([A-Z][A-Z0-9_]*[A-Z0-9])['"]\s*\]""")
TOKEN = re.compile(r"""['"`]((?:HYPERFIDE|HF)_[A-Z0-9_]*[A-Z0-9]|DATABASE_URL)['"`]""")
PREFIXED = re.compile(r"""prefix\s*\+\s*'(_[A-Z0-9_]+)'""")
NAME = re.compile(r"""\b((?:HYPERFIDE|HF|CG)_[A-Z0-9_]*[A-Z0-9]|DATABASE_URL)\b""")


def check(name, fn):
    try:
        outcome = fn()
        actual = 'skipped' if outcome == 'SKIP' else 'observed'
        if outcome == 'SKIP':
            SKIPPED.append(name)
    except Exception as error:
        FAILED.append(name)
        actual = type(error).__name__ + ': ' + str(error)[:600]
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': 'observed', 'actual': actual}), flush=True)


def expect(ok, message):
    if not ok:
        raise AssertionError(message)


def control_modules(root):
    """service.ts plus every module a control-role component registers, closed over relative imports."""
    src = root / 'core/control-plane/src'
    todo = [src / 'components/service.ts']
    for f in (root / 'core/control-plane/components').glob('*.json'):
        v = json.loads(f.read_text())
        if 'control' in v.get('roles', []) and v.get('module'):
            todo.append((src / v['module']).with_suffix('.ts'))
    seen = set()
    while todo:
        f = todo.pop()
        if f in seen or not f.is_file():
            continue
        seen.add(f)
        for m in IMPORT.finditer(f.read_text()):
            t = (f.parent / (m.group(1) or m.group(2))).resolve()
            todo.append(t.with_suffix('.ts') if t.suffix == '.js' else t)
    return seen


def control_env_names(root):
    """Every environment name the control service reads, mapped to the modules that read it."""
    src = (root / 'core/control-plane/src').resolve()
    names = {}
    for f in control_modules(root):
        rel = str(f.resolve().relative_to(src))
        text = f.read_text()
        found = {m.group(1) or m.group(2) for m in READ.finditer(text)}
        if rel != RENAME_TABLE:
            found |= {m.group(1) for m in TOKEN.finditer(text)}
        found |= {'HYPERFIDE_CONTROL' + m.group(1) for m in PREFIXED.finditer(text)}
        for n in found:
            if n in NOT_CONFIGURATION or n.startswith('GIT_'):
                continue
            names.setdefault(n, set()).add(rel)
    return names


def documented_names(text):
    return {m.group(1) for m in NAME.finditer(text)}


def run(argv, env=None, timeout=300, cwd=ROOT):
    return subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items()
           if not (k == 'DATABASE_URL' or k.startswith('PG') or k.endswith('_DATABASE_URL'))}
    env.update(extra)
    return env


def skipped_honestly(p, needle):
    lines = [l for l in p.stdout.splitlines() + p.stderr.splitlines() if l.startswith('SKIP:')]
    expect(p.returncode == 77, 'exit %d, not 77: %s' % (p.returncode, (p.stdout + p.stderr)[-400:]))
    expect(len(lines) == 1 and needle in lines[0], 'one SKIP line naming %r expected: %r' % (needle, lines))


# ---------------------------------------------------------------- names
def env_checks():
    read = control_env_names(ROOT)
    example = EXAMPLE.read_text()
    documented = documented_names(example)

    def complete():
        missing = sorted(set(read) - documented)
        expect(len(read) > 50, 'control scan found only %d names' % len(read))
        expect(not missing, 'control.env.example misses names the control service reads: ' + ', '.join(missing))

    def complete_negative():
        # The same check must name a read variable whose line is dropped.
        victim = 'HYPERFIDE_DRAIN_TIMEOUT_MS'
        pruned = '\n'.join(l for l in example.splitlines() if victim not in l)
        expect(victim in set(read) - documented_names(pruned), 'dropping a documented name went unnoticed')

    def no_stale():
        unit = (ROOT / 'deploy/hyperfide/control.service').read_text()
        preflight = (ROOT / 'deploy/hyperfide/bootstrap-host.mjs').read_text()
        known = set(read) | documented_names(unit) | documented_names(preflight)
        stale = sorted(documented - known)
        expect(not stale, 'control.env.example names variables nothing reads: ' + ', '.join(stale))

    def no_values():
        for line in example.splitlines():
            if line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            if re.search(r'SECRET|TOKEN|PASSWORD|_KEY$|DATABASE_URL', key):
                expect(value.startswith('REPLACE_WITH_'), key + ' carries a value, not a placeholder')

    def named_documented():
        ops = OPS.read_text()
        for n in NAMED:
            expect(n in documented and n in read, n + ' missing from control.env.example or not read')
            expect(n in ops, n + ' missing from operations.md')

    def ops_names_real():
        corpus = []
        for base, pattern in ((SRC, '**/*.ts'), (ROOT / 'deploy/hyperfide', '**/*'), (ROOT / 'tests/hyperfide', '*.py'),
                              (ROOT / 'core/native/src', '**/*.[ch]'), (ROOT / 'tools/repository', '*')):
            corpus += [p.read_text(errors='replace') for p in base.glob(pattern)
                       if p.is_file() and 'node_modules' not in p.relative_to(ROOT).parts]
        text = '\n'.join(corpus)
        unknown = []
        for n in sorted(documented_names(OPS.read_text())):
            role = re.sub(r'^HYPERFIDE_(?:ROLE|CONTROL|PROVISIONER|DISPATCH)_', '', n)
            if n in text or (role != n and "_" + role in text):
                continue
            unknown.append(n)
        expect(not unknown, 'operations.md names variables no code reads: ' + ', '.join(unknown))

    check('env.control-example-complete', complete)
    check('env.control-example-complete-negative', complete_negative)
    check('env.control-example-no-stale-names', no_stale)
    check('env.control-example-no-secret-values', no_values)
    check('env.drain-offline-documented', named_documented)
    check('env.operations-names-read-by-code', ops_names_real)


# ---------------------------------------------------------------- commands
def command_checks():
    ops = OPS.read_text()

    def cli_table():
        rows = re.findall(r'^\| hyperfide ([a-z]+(?: [a-z]+)?) ([^|]*)\|', ops, re.M)
        expect(rows, 'no CLI rows found in operations.md')
        for command, rest in rows:
            words = command.split()
            p = run([str(CG), 'help', *words[:1]] if len(words) == 1 else [str(CG), *words, '--help'])
            usage = p.stdout + p.stderr
            for sub in re.findall(r'([a-z][a-z-]+)', rest.replace('\\|', ' ')):
                if sub in ('seconds', 'drain', 'wait', 'run'):
                    continue
                expect(re.search(r'\b' + re.escape(sub) + r'\b', usage), 'hyperfide %s has no %s' % (command, sub))
            for flag in re.findall(r'(--[a-z-]+)', rest):
                expect(flag in usage, 'hyperfide %s has no %s' % (command, flag))

    def script_flags():
        scripts = {'bootstrap-host.mjs': 'deploy/hyperfide/bootstrap-host.mjs',
                   'bootstrap-fence.mjs': 'deploy/hyperfide/bootstrap-fence.mjs',
                   'migrate.mjs': 'deploy/hyperfide/migrate.mjs',
                   'install-service.mjs': 'deploy/hyperfide/install-service.mjs',
                   'qualify.py': 'tests/hyperfide/qualify.py',
                   'publish-evidence.py': 'tests/hyperfide/publish-evidence.py',
                   'check-evidence.py': 'tests/hyperfide/check-evidence.py',
                   '29_5.py': 'tests/hyperfide/cases/tasks/29_5.py'}
        seen = 0
        named = re.compile('|'.join(re.escape(n) for n in scripts))
        for line in ops.splitlines():
            # A flag belongs to the script named last before it on the line.
            for flag in re.finditer(r'(?<![\w-])(--[a-z][a-z0-9-]+)', line):
                owners = named.findall(line[:flag.start()])
                if not owners:
                    continue
                path = scripts[owners[-1]]
                seen += 1
                expect(flag.group(1) in (ROOT / path).read_text(), '%s does not take %s' % (path, flag.group(1)))
        expect(seen > 10, 'too few script flags matched (%d)' % seen)

    check('docs.cli-commands-shipped', cli_table)
    check('docs.script-flags-shipped', script_flags)


# ---------------------------------------------------------------- cases
def case_checks():
    work = Path(tempfile.mkdtemp(prefix='hf-324-'))
    try:
        def c24_skip():
            p = run([sys.executable, str(CASES / '24_1.py')], clean_env(HYPERFIDE_CAMPAIGN_DIR=str(work / 'c24')))
            skipped_honestly(p, 'DATABASE_URL')

        def c24_cleanup():
            p = run([sys.executable, str(CASES / '24_1.py'), '--cleanup'], clean_env(HYPERFIDE_CAMPAIGN_DIR=str(work / 'c24c')))
            events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
            expect(p.returncode == 0 and events == [{'type': 'cleanup', 'complete': True, 'resources': []}],
                   'cleanup without DATABASE_URL: %d %r' % (p.returncode, p.stdout + p.stderr[-300:]))

        def c24_no_unread_map():
            text = (CASES / '24_1.py').read_text()
            expect(not re.search(r'^ACTIONS\s*=', text, re.M), '24_1.py keeps an ACTIONS map nothing reads')

        def c15_skip():
            p = run([sys.executable, str(CASES / '15_1.py')], clean_env(HYPERFIDE_CAMPAIGN_DIR=str(work / 'c15')))
            skipped_honestly(p, 'DATABASE_URL')

        def c15_cleanup():
            p = run([sys.executable, str(CASES / '15_1.py'), '--cleanup'], clean_env(HYPERFIDE_CAMPAIGN_DIR=str(work / 'c15c')))
            events = [json.loads(l) for l in p.stdout.splitlines() if l.startswith('{')]
            expect(p.returncode == 0 and events == [{'type': 'cleanup', 'complete': True, 'resources': []}],
                   'cleanup without DATABASE_URL: %d %r' % (p.returncode, p.stdout + p.stderr[-300:]))

        def c29_pick():
            fake = work / 'pg'
            for major, server in (('14', True), ('16', True), ('18', False)):
                (fake / major / 'bin').mkdir(parents=True)
                (fake / major / 'bin' / 'psql').write_text('')
                if server:
                    (fake / major / 'bin' / 'initdb').write_text('')
            probe = ('import importlib.util,sys;from pathlib import Path\n'
                     's=importlib.util.spec_from_file_location("t",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
                     'print(m.server_bins(Path(sys.argv[2]))[-1].parent.name)')
            p = run([sys.executable, '-c', probe, str(CASES / '29_5.py'), str(fake)], clean_env())
            expect(p.returncode == 0 and p.stdout.strip() == '16', 'picked %r, not the newest with initdb' % (p.stdout + p.stderr))

        def c29_skip():
            client = work / 'client-only' / 'bin'
            client.mkdir(parents=True)
            p = run([sys.executable, str(CASES / '29_5.py')], clean_env(HYPERFIDE_PG_BIN=str(client)))
            skipped_honestly(p, 'HYPERFIDE_PG_BIN has no initdb')

        def c13_skip():
            bare = work / 'bare-bin'
            bare.mkdir()
            for tool in ('node', 'psql', 'git'):
                found = shutil.which(tool)
                if found:
                    (bare / tool).symlink_to(found)
            env = clean_env(PATH=str(bare))
            env.pop('HF_TEST_NATIVE_CODEX_BINARY', None)
            p = run([sys.executable, str(CASES / '13_4.py')], env)
            skipped_honestly(p, 'codex is not on PATH')

        def c13_locates():
            pkg = work / 'npm' / '@openai' / 'codex'
            (pkg / 'bin').mkdir(parents=True)
            (pkg / 'bin' / 'codex.js').write_text('#!/usr/bin/env node\n')
            (pkg / 'bin' / 'codex.js').chmod(0o755)
            native = pkg / 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'
            native.parent.mkdir(parents=True)
            native.write_bytes(b'\x7fELF' + b'\0' * 60)
            shim = work / 'shim-bin'
            shim.mkdir()
            (shim / 'codex').symlink_to(pkg / 'bin' / 'codex.js')
            probe = ('import importlib.util,sys\n'
                     's=importlib.util.spec_from_file_location("t",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n'
                     'print(m.CODEX_ELF)')
            env = clean_env(PATH=str(shim) + ':' + os.environ.get('PATH', ''))
            env.pop('HF_TEST_NATIVE_CODEX_BINARY', None)
            p = run([sys.executable, '-c', probe, str(CASES / '13_4.py')], env)
            expect(p.returncode == 0 and p.stdout.strip() == str(native.resolve()), 'shim payload not found: %r' % (p.stdout + p.stderr[-300:]))
            env['HF_TEST_NATIVE_CODEX_BINARY'] = str(work / 'absent-codex')
            p = run([sys.executable, '-c', probe, str(CASES / '13_4.py')], env)
            expect(p.returncode == 0 and p.stdout.strip() == 'None', 'an explicit absent binary was not refused: %r' % p.stdout)
            expect('/root/.local/share/mise' not in (CASES / '13_4.py').read_text(), '13_4.py still pins a host path')

        def c24_sql_over_url():
            if not os.environ.get('HF_324_PROBE'):
                p = run([sys.executable, str(WITHPG), '--', sys.executable, str(Path(__file__).resolve()), '--probe-24-1-sql'],
                        clean_env(HF_324_PROBE='1'), timeout=600)
                if p.returncode == 77:
                    print('withpg: ' + (p.stdout + p.stderr).strip()[-200:], file=sys.stderr)
                    return 'SKIP'
                expect(p.returncode == 0 and 'socket-match' in p.stdout, 'owned-cluster probe: ' + (p.stdout + p.stderr)[-600:])

        check('case.24_1.skips-without-database-url', c24_skip)
        check('case.24_1.cleanup-without-database-url', c24_cleanup)
        check('case.24_1.no-unread-actions-map', c24_no_unread_map)
        check('case.24_1.sql-connects-through-database-url', c24_sql_over_url)
        check('case.15_1.skips-without-database-url', c15_skip)
        check('case.15_1.cleanup-without-database-url', c15_cleanup)
        check('case.29_5.postgres-bin-ships-initdb', c29_pick)
        check('case.29_5.skips-client-only-bin', c29_skip)
        check('case.13_4.skips-without-codex', c13_skip)
        check('case.13_4.locates-codex-through-path', c13_locates)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def probe_24_1_sql():
    """Run inside withpg.py: 24_1's sql() must reach the owned cluster DATABASE_URL names."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('hf_case_24_1', CASES / '24_1.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    wanted = parse_qs(urlsplit(os.environ['DATABASE_URL']).query)['host'][0]
    got = module.sql('SHOW unix_socket_directories;', 'postgres')
    print(('socket-match ' if got == wanted else 'socket-mismatch ') + got, flush=True)
    return 0 if got == wanted else 1


# ---------------------------------------------------------------- bridge, runtime, serve
def code_checks():
    def bridge_bound():
        bridge = (SRC / 'runner/bridge.ts').read_text()
        placement = (SRC / 'providers/placement.ts').read_text()
        m = re.search(r'export const RUNNER_HEARTBEAT_MAX_AGE_SECONDS\s*=\s*(\d+)\s*;', placement)
        expect(m and m.group(1) == '90', 'placement constant absent')
        expect(re.search(r"import \{[^}]*\bRUNNER_HEARTBEAT_MAX_AGE_SECONDS\b[^}]*\} from '\.\./providers/placement\.js'", bridge),
               'bridge.ts does not import the placement constant')
        expect("interval '${RUNNER_HEARTBEAT_MAX_AGE_SECONDS} seconds'" in bridge, 'SQL heartbeat bound is not the constant')
        expect('RUNNER_HEARTBEAT_MAX_AGE_SECONDS*1000' in bridge, 'JS heartbeat bound is not the constant')
        expect(not re.search(r"interval '\d+ seconds'|getTime\(\)\+\d{4,}", bridge), 'bridge.ts repeats a literal heartbeat bound')

    def runtime_uses_stat_cache():
        text = (ROOT / 'core/native/src/runtime.c').read_text()
        body = text[text.index('void runtime_workspace_revision('):]
        body = body[:body.index('\n}\n')]
        expect('vcs_worktree_files(' in body, 'runtime_workspace_revision does not read the store manifest')
        expect('read_entire_file' not in body and 'sha256_hex(data' not in body and 'mtime_ns ==' not in body,
               'runtime_workspace_revision still hashes files through its own cache')
        expect(os.access(CG, os.X_OK), 'no cg binary; run make cg')
        project = Path(tempfile.mkdtemp(prefix='hf-324-rt-'))
        try:
            (project / 'a.c').write_text('int a;\n')
            old = time.time() - 30
            os.utime(project / 'a.c', (old, old))
            expect(run([str(CG), 'init'], cwd=project).returncode == 0, 'cg init failed')

            def revision(session):
                event = json.dumps({'hook_event_name': 'PostToolUse', 'session_id': session, 'tool_name': 'Bash'})
                p = subprocess.run([str(CG), 'event', 'ingest', '--source', 'claude'], cwd=project, input=event,
                                   text=True, capture_output=True, timeout=120)
                expect(p.returncode == 0, 'event ingest: ' + p.stderr)
                rows = json.loads(run([str(CG), 'event', 'history', '--json'], cwd=project).stdout)['events']
                return [r for r in rows if r['session'] == session][0]['workspace_revision']

            first = revision('s1')
            expect(revision('s2') == first, 'an unchanged tree changed revision')
            cache = list((project / '.codegraph/statcache').iterdir())
            expect(len(cache) == 1, 'no stat cache written for the tree')
            digest = hashlib.sha256(b'int a;\n').hexdigest()
            expect(any(l.startswith(digest + ' ') and l.endswith('\ta.c') for l in cache[0].read_text().splitlines()),
                   'stat cache lacks a.c')
            # A forged entry with matching size and mtime is believed, so the revision reads the store's cache.
            forged = '0' * 64
            cache[0].write_text(cache[0].read_text().replace(digest + ' ', forged + ' '))
            vouched = revision('s3')
            db = sqlite3.connect(str(project / '.codegraph/graph.db'))
            row = db.execute("SELECT hash,mtime_ns,ctime_ns FROM runtime_files WHERE path='a.c'").fetchone()
            db.close()
            expect(vouched != first and row == (forged, 0, 0), 'runtime manifest did not come from the stat cache: %r' % (row,))
            (project / 'a.c').write_text('int b;\n')
            expect(revision('s4') not in (first, vouched), 'an edited file did not change the revision')
        finally:
            shutil.rmtree(project, ignore_errors=True)

    def serve_methods():
        serve = (ROOT / 'extensions/vscode/serve.js').read_text()
        expect(not re.search(r'^\s*async cancel\(', serve, re.M), 'serve.js keeps an unused cancel()')
        if re.search(r'^\s*async tool\(', serve, re.M):
            users = [p for p in list((ROOT / 'extensions/vscode').glob('*.js')) + [ROOT / 'tests/integration/14_vscode.sh']
                     if p.name != 'serve.js' and re.search(r'\.tool\(', p.read_text())]
            expect(users, 'serve.js keeps tool() with no caller')

    check('bridge.heartbeat-bound-is-placement-constant', bridge_bound)
    check('runtime.workspace-revision-uses-vcs-stat-cache', runtime_uses_stat_cache)
    check('serve.no-unused-methods', serve_methods)


def main():
    if '--probe-24-1-sql' in sys.argv:
        return probe_24_1_sql()
    env_checks()
    command_checks()
    case_checks()
    code_checks()
    print(json.dumps({'type': 'summary', 'failed': FAILED, 'skipped': SKIPPED}), flush=True)
    if FAILED:
        return 1
    if SKIPPED:
        print('SKIP: ' + ', '.join(SKIPPED) + ' needs an owned PostgreSQL cluster', flush=True)
        return 77
    return 0


if __name__ == '__main__':
    sys.exit(main())
