#!/usr/bin/env python3
"""Exercise the virtual filesystem component, or Linux FUSE with real S3 by default."""
import argparse
import importlib.util
import os
import shutil
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[4]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--component', action='store_true')
    args = parser.parse_args()
    output = ROOT / 'build/source-control/3.2'
    output.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment['HYPERFIDE_VIRTUAL_RECEIPT'] = str(output / 'receipt.json')
    environment['HYPERFIDE_VIRTUAL_COMPONENT'] = '1' if args.component else '0'
    node = shutil.which(environment.get('HYPERFIDE_NODE_BINARY') or 'node')
    if not node:
        raise RuntimeError('CAPABILITY_MISSING: set HYPERFIDE_NODE_BINARY to an executable Node binary or install node on PATH')
    actor_command = [node, '--conditions=source', '--import', 'tsx', str(ROOT / 'tests/hyperfide/support/native_source_virtual_actor.mjs')]
    if environment.get('HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE'):
        return subprocess.run(actor_command, cwd=ROOT, env=environment).returncode
    specification = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
    fixture = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(fixture)
    return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_virtual_fixture.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0743-source-control-assurance.sql',
        '0747-source-control-virtual-workspaces.sql',
        '0762-source-control-workspace-closure.sql',
        '0763-source-control-workspace-attempts.sql',
    ], timeout=300, actor_env=environment)

if __name__ == '__main__':
    raise SystemExit(main())
