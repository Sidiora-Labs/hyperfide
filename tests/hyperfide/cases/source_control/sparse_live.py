#!/usr/bin/env python3
"""Run the sparse live proof and the admitted source-control campaign cases."""
import importlib.util
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "tests/hyperfide/support"))
from source_control_live_campaign import owned_sparse_processes, run_campaign, store_environment


def run_sparse_actor():
    environment, missing = store_environment(os.environ)
    if missing:
        print("SKIP: missing " + ", ".join(missing), file=sys.stderr)
        return 77
    os.environ.update(environment)
    spec = importlib.util.spec_from_file_location(
        "native_source_fixture", ROOT / "tests/hyperfide/support/native_source_fixture.py"
    )
    fixture = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture)
    with owned_sparse_processes():
        return fixture.run_source_actor(
            ROOT / "tests/hyperfide/support/native_source_sparse_fixture.mjs",
            migrations=[
                "0736-source-control-storage.sql",
                "0737-source-control-metadata.sql",
                "0738-source-control-capabilities.sql",
                "0739-source-control-workspaces.sql",
                "0740-source-control-transformations.sql",
                "0741-source-control-acceptance.sql",
                "0743-source-control-assurance.sql",
            ],
            timeout=360,
        )


if __name__ == "__main__":
    if sys.argv[1:] == ["--actor"] or os.environ.get("HF_SOURCE_LIVE_CAMPAIGN_CHILD") == "1":
        raise SystemExit(run_sparse_actor())
    if sys.argv[1:]:
        raise SystemExit("usage: sparse_live.py [--actor]")
    raise SystemExit(run_campaign())
