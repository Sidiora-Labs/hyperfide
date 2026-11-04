#!/usr/bin/env python3
"""Execute the integrated signed-worker, CLI, browser and Git source journey."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
from urllib.parse import urlparse
import sys
import time

ROOT = Path(__file__).resolve().parents[4]
IDS = [
 'assignment-workspace-binding', 'durable-checkpoint-lineage',
 'checkpoint-and-submission-distinct', 'unknown-submission-reconciles-once',
 'replacement-keeps-prior-history', 'independent-qualification-before-task-release',
 'dependent-consumes-accepted-source', 'forged-qualified-dependency-refused', 'plain-sql-qualification-snapshot', 'queue-preserves-qualified-dependencies', 'replacement-reaches-qualified-acceptance', 'signed-cli-revision-read',
 'signed-cli-history-without-checkout', 'ui-shows-exact-fleet-accepted-source',
 'ui-conflict-resolution-preserves-source', 'ui-desktop-tablet-mobile', 'ui-publication-has-explicit-durable-status',
 'independent-git-readback-matches-native', 'genuine-native-source-capture',
]

def main():
    output = ROOT / 'build/source-control/full-case/SCM-023'
    output.mkdir(parents=True, exist_ok=True)
    start = time.time_ns()
    env = {**os.environ, 'HF_SOURCE_FULL_CASE': 'SCM-023'}
    # The invoked fixture creates and tears down its own PostgreSQL and signed
    # control service. Never attach this campaign to a user database.
    env.pop('DATABASE_URL', None)
    with (output / 'execution.log').open('wb') as log:
        result = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/4_2.py')], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, timeout=900)
    if result.returncode:
        raise RuntimeError('Integrated source journey failed; see '+str(output/'execution.log'))
    receipt = output / 'journey.json'
    if not receipt.is_file() or receipt.stat().st_mtime_ns < start:
        raise RuntimeError('Fresh integrated journey receipt is absent')
    value = json.loads(receipt.read_text())
    expected = ['SCM-023.'+name for name in IDS]
    if value.get('status') != 'PASS' or value.get('execution_profile') != 'owned-postgresql-sigv4-local-signed-worker-and-local-git':
        raise RuntimeError('Unexpected source journey profile or outcome')
    assertions = value.get('assertions', [])
    if [row.get('id') for row in assertions] != expected or any(row.get('expected') is not True or row.get('actual') is not True for row in assertions):
        raise RuntimeError('Integrated assertion inventory differs')
    spec = importlib.util.spec_from_file_location('source_qualifier', ROOT/'tests/hyperfide/qualify.py')
    qualifier = importlib.util.module_from_spec(spec); spec.loader.exec_module(qualifier)
    qualifier.native_capture(ROOT, value['native_capture'], expected)
    temporary = value.get('owned_temporary_root')
    if not isinstance(temporary, str) or not temporary.startswith('/tmp/hf-native-fleet-') or Path(temporary).exists():
        raise RuntimeError('Owned fleet temporary files were not removed')
    endpoints=value.get('owned_endpoints')
    if not isinstance(endpoints,list) or len(endpoints)!=4 or len(set(endpoints))!=4:
        raise RuntimeError('Complete owned endpoint inventory required')
    for endpoint in endpoints:
        address=urlparse(endpoint)
        if address.hostname not in ('localhost','127.0.0.1') or not address.port:
            raise RuntimeError('Invalid owned endpoint cleanup receipt')
        with socket.socket() as connection:
            connection.settimeout(2)
            if connection.connect_ex(('127.0.0.1',address.port)) == 0:
                raise RuntimeError('Owned source service still listens after cleanup')
    for row in assertions:
        print(json.dumps({'type':'assertion', **row}), flush=True)
    print(json.dumps({'type':'cleanup', 'complete':True, 'resources':[]}), flush=True)
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'status':'FAIL', 'diagnostics':[str(error)]}))
        raise SystemExit(1)
