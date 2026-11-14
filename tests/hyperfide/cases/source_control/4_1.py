#!/usr/bin/env python3
"""Verify candidate qualification and atomic native acceptance on owned PostgreSQL."""
import importlib.util
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def main():
    result = fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_acceptance_actor.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql',
        '0746-source-control-retention.sql', '0757-source-control-candidate-queue.sql',
    ], timeout=300)
    if result or not os.environ.get("DATABASE_URL"):
        return result
    batch_env = {key: value for key, value in os.environ.items() if key != 'DATABASE_URL'}
    result = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/4_1_batches.py')],
                            cwd=ROOT, env=batch_env).returncode
    if result:
        return result
    return subprocess.run([sys.executable, str(ROOT / "tests/hyperfide/cases/source_control/assurance_registration.py")], cwd=ROOT).returncode


if __name__ == '__main__':
    raise SystemExit(main())
