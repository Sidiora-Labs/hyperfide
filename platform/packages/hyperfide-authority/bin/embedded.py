#!/usr/bin/env python3
"""Opt-in, single-host authority for a command, using the repository's owned PG helper.

The PostgreSQL cluster is owned by withpg.py; embedded-session.ts checkpoints
plugin state in the private local store across clean session restarts.
"""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]


def main():
    command = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    if not command:
        raise SystemExit('Usage: embedded.py [--cluster-ready] -- command [args...]')
    if os.environ.get('HYPERFIDE_AUTHORITY_URL'):
        return subprocess.run(command, cwd=ROOT).returncode
    if os.environ.get('HYPERFIDE_AUTHORITY_EMBEDDED') != '1':
        raise SystemExit('Embedded authority requires explicit HYPERFIDE_AUTHORITY_EMBEDDED=1')
    if '--cluster-ready' not in sys.argv:
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--',
                               sys.executable, str(Path(__file__).resolve()), '--cluster-ready', '--', *command], cwd=ROOT).returncode
    spec = importlib.util.spec_from_file_location('hyperfide_local_authority', ROOT / 'tests/hyperfide/support/identity_fixture.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    fixture = module.IdentityFixture(extra_components=['platform-authority'])
    try:
        env = os.environ.copy()
        env.update(HYPERFIDE_AUTHORITY_URL=fixture.origin, HYPERFIDE_AUTHORITY_CA_FILE=str(fixture.ca),
                   HYPERFIDE_AUTHORITY_KEY_FILE=str(fixture.keys['operator']['path']),
                   HYPERFIDE_AUTHORITY_CREDENTIAL_ID=fixture.ids['operator'], HYPERFIDE_AUTHORITY_RUN_ID=fixture.ids['run'])
        return subprocess.run(['pnpm', '-C', 'platform', 'exec', 'tsx',
                               'packages/hyperfide-authority/bin/embedded-session.ts', *command], cwd=ROOT, env=env).returncode
    finally:
        fixture.close()


if __name__ == '__main__':
    sys.exit(main())
