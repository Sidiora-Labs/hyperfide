#!/usr/bin/env python3
"""Exercise indexed queries, isolated admission and subscriptions over the real source API."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def main():
    return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_api_actor.mjs', timeout=180)


if __name__ == '__main__':
    raise SystemExit(main())
