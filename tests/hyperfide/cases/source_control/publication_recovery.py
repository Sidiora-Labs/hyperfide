#!/usr/bin/env python3
"""Verify owner-preserving publication reconciliation with a current recovery operator."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

if __name__ == '__main__':
    raise SystemExit(fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_publication_recovery.mjs', migrations=[
        '0001-authority.sql', '0004-durability.sql',
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql',
        '0752-source-control-recovery.sql', '0757-source-control-candidate-queue.sql',
    ], timeout=180))
