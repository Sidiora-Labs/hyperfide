#!/usr/bin/env python3
"""Opt-in live GitHub adapter canary; requires an explicitly owned private repository."""
import importlib.util
import os
from pathlib import Path
ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
def main():
    if not os.environ.get('HF_CANARY_GITHUB_REPOSITORY') and not os.environ.get('HF_CANARY_INVENTORY'):
        raise SystemExit('HF_CANARY_GITHUB_REPOSITORY or HF_CANARY_INVENTORY must identify an owned disposable private repository')
    return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_github_canary_actor.mjs', migrations=[
        '0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql',
        '0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql','0743-source-control-assurance.sql','0750-source-control-import.sql',
    ], timeout=300)
if __name__ == '__main__':
    raise SystemExit(main())
