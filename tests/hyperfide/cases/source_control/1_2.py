#!/usr/bin/env python3
"""Exercise native metadata transactions, replay and durable delivery with isolated PostgreSQL."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
fixture = ROOT / 'tests/hyperfide/support/native_source_fixture.py'
spec = importlib.util.spec_from_file_location('native_source_fixture', fixture)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

if __name__ == '__main__':
    raise SystemExit(module.run_source_actor(ROOT / 'tests/hyperfide/support/source_metadata_actor.mjs', migrations=['0736-source-control-storage.sql', '0737-source-control-metadata.sql'], timeout=180))
