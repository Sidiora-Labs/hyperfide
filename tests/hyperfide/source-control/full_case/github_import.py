#!/usr/bin/env python3
"""Read-only GitHub canary fetch through the actual native import boundary."""
import importlib.util
import os
import json
import hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
if __name__=='__main__':
    if not os.environ.get('HF_SOURCE_GITHUB_IMPORT_RECEIPT'):
        raise SystemExit('HF_SOURCE_GITHUB_IMPORT_RECEIPT must name the retained owned GitHub canary receipt')
    if os.environ.get('HYPERFIDE_CAMPAIGN_DIR'):
        manifest=json.loads((Path(os.environ['HYPERFIDE_CAMPAIGN_DIR'])/'manifest.json').read_text())
        pin=manifest['policy']['github_receipt'];expected=Path(pin['path']);expected=expected if expected.is_absolute() else ROOT/expected
        actual=Path(os.environ['HF_SOURCE_GITHUB_IMPORT_RECEIPT']).resolve()
        if actual!=expected.resolve() or hashlib.sha256(actual.read_bytes()).hexdigest()!=pin['sha256']:
            raise SystemExit('Live GitHub input differs from the pinned campaign receipt')
    spec=importlib.util.spec_from_file_location('source_fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)
    raise SystemExit(fixture.run_source_actor(Path(__file__).with_suffix('.mjs'),migrations=['0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql','0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0743-source-control-assurance.sql','0750-source-control-import.sql'],timeout=300))
