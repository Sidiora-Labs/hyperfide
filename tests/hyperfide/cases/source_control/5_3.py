#!/usr/bin/env python3
"""Exercise native consolidation and cutover with real isolated legacy storage."""
import importlib.util
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

if __name__ == '__main__':
    if not os.environ.get('DATABASE_URL'):
        raise SystemExit(subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode)
    if '--isolated' not in sys.argv:
        raise SystemExit(subprocess.run(['unshare', '--user', '--map-root-user', '--mount', '--pid', '--fork', '--mount-proc', '--propagation', 'private', sys.executable, str(Path(__file__).resolve()), '--isolated'], cwd=ROOT).returncode)
    raise SystemExit(fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_migration_actor.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql', '0738-source-control-capabilities.sql',
        '0739-source-control-workspaces.sql', '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql', '0746-source-control-retention.sql',
        '0750-source-control-import.sql', '0751-source-control-cutover.sql', '0754-source-control-epoch-adoption.sql', '0755-source-control-final-delta.sql',
    ], timeout=300))
