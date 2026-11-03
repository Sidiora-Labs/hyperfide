#!/usr/bin/env python3
"""Exercise Linux FUSE through the native source service and real S3 by default."""
import argparse
import importlib.util
import json
import os
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
    node = environment.get('HYPERFIDE_NODE_BINARY', '/root/.nvm/versions/node/v24.22.0/bin/node')
    if environment.get('HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE'):
        return subprocess.run([node, '--import', 'tsx', str(ROOT / 'tests/hyperfide/support/native_source_virtual_actor.mjs')], cwd=ROOT, env=environment).returncode
    probe = subprocess.run([node, '--import', 'tsx', str(ROOT / 'tests/hyperfide/support/native_source_virtual_actor.mjs')], cwd=ROOT, env=environment, text=True, capture_output=True)
    if probe.returncode != 2:
        print(probe.stdout, end='')
        print(probe.stderr, end='')
        return probe.returncode
    capability = json.loads(probe.stdout)
    if not capability['capabilities']['available']:
        print(probe.stdout, end='')
        return 2
    specification = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
    fixture = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(fixture)
    environment['HYPERFIDE_VIRTUAL_COMPONENT'] = '1' if args.component else '0'
    return fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_virtual_fixture.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
        '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql',
        '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0743-source-control-assurance.sql',
        '0747-source-control-virtual-workspaces.sql',
    ], timeout=300, actor_env=environment)

if __name__ == '__main__':
    raise SystemExit(main())
