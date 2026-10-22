#!/usr/bin/env python3
"""Run one command against an owned throwaway PostgreSQL cluster: withpg.py -- <command...>

The child gets DATABASE_URL for the cluster superuser and HYPERFIDE_PG_BIN for clusters it owns itself.
The cluster is reachable only through a private socket directory and is removed afterwards.
"""
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[3]
SUPERUSER = 'hf_superuser'


def postgres_bin():
    configured = os.environ.get('HYPERFIDE_PG_BIN')
    if configured:
        return Path(configured)
    # A client-only package installs bin/ without the server; only a directory with initdb can own a cluster.
    installed = sorted((path for path in Path('/usr/lib/postgresql').glob('*/bin')
                        if path.parent.name.isdigit() and (path / 'initdb').is_file()),
                       key=lambda path: int(path.parent.name))
    if not installed:
        print('SKIP: no PostgreSQL server binaries; set HYPERFIDE_PG_BIN', file=sys.stderr)
        sys.exit(77)
    return installed[-1]


def as_postgres(binary, *args, **kw):
    return subprocess.run(['runuser', '-u', 'postgres', '--', str(binary), *map(str, args)],
                          check=True, capture_output=True, text=True, timeout=120, **kw)


def main(argv):
    if '--' not in argv or not argv[argv.index('--') + 1:]:
        print('usage: withpg.py -- <command...>', file=sys.stderr)
        return 2
    command = argv[argv.index('--') + 1:]
    binary = postgres_bin()
    Path('/tmp/hyperfide').mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='hf-withpg-', dir='/tmp/hyperfide'))
    owner = pwd.getpwnam('postgres')
    os.chown(root, owner.pw_uid, owner.pw_gid)
    # Case services run under separate role uids and connect over this socket directory; data/ stays 0700.
    root.chmod(0o755)
    data, process, code = root / 'data', None, 1
    try:
        as_postgres(binary / 'initdb', '-D', data, '-U', SUPERUSER, '--auth=trust', '--no-locale', '--encoding=UTF8')
        with (data / 'postgresql.conf').open('a') as conf:
            # Discarded after the run, so crash durability buys nothing; fsync stalls on a loaded host only skew deadlines.
            conf.write("\nlisten_addresses=''\nunix_socket_directories='" + str(root) + "'\n"
                       "fsync=off\nsynchronous_commit=off\n")
        with (root / 'server.log').open('ab') as log:
            process = subprocess.Popen(['runuser', '-u', 'postgres', '--', str(binary / 'postgres'), '-D', str(data)],
                                       stdout=log, stderr=log)
        for _ in range(1200):
            if process.poll() is not None:
                raise RuntimeError('owned PostgreSQL failed to start: ' + (root / 'server.log').read_text()[-2000:])
            if subprocess.run([str(binary / 'pg_isready'), '-q', '-h', str(root), '-p', '5432']).returncode == 0:
                break
            time.sleep(0.05)
        else:
            raise RuntimeError('owned PostgreSQL readiness deadline expired')
        env = {key: value for key, value in os.environ.items()
               if not (key == 'DATABASE_URL' or key.startswith('HYPERFIDE_') and key.endswith('_DATABASE_URL'))}
        env['DATABASE_URL'] = 'postgresql://' + SUPERUSER + '@localhost:5432/postgres?host=' + quote(str(root), safe='')
        env['HYPERFIDE_PG_BIN'] = str(binary)
        code = subprocess.run(command, cwd=ROOT, env=env).returncode
    finally:
        if process and process.poll() is None:
            try:
                as_postgres(binary / 'pg_ctl', '-D', data, '-m', 'fast', '-w', '-t', '60', 'stop')
            except subprocess.SubprocessError:
                process.kill()
            process.wait(timeout=60)
        shutil.rmtree(root, ignore_errors=True)
        if root.exists():
            print('withpg: cluster directory not removed: ' + str(root), file=sys.stderr)
            code = code or 1
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
