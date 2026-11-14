#!/usr/bin/env python3
"""Execute the integrated signed-worker, CLI, browser and Git source journey."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import re
import uuid
import subprocess
from urllib.parse import urlparse
import sys
import time

ROOT = Path(__file__).resolve().parents[4]
IDS = [
 'assignment-workspace-binding', 'durable-checkpoint-lineage',
 'checkpoint-and-submission-distinct', 'unknown-submission-reconciles-once',
 'replacement-keeps-prior-history', 'independent-qualification-before-task-release',
 'dependent-consumes-accepted-source', 'forged-qualified-dependency-refused', 'plain-sql-qualification-snapshot', 'queue-preserves-qualified-dependencies', 'replacement-reaches-qualified-acceptance', 'sparse-edit-materializes-only-scope', 'source-diff-matches-checkpoint', 'signed-cli-revision-read',
 'signed-cli-history-without-checkout', 'ui-shows-exact-fleet-accepted-source',
 'ui-conflict-resolution-preserves-source', 'ui-desktop-tablet-mobile', 'ui-publication-has-explicit-durable-status',
 'independent-git-readback-matches-native', 'genuine-native-source-capture',
]

def verify_journey_steps(value, expected):
    steps, snapshots = value.get('steps'), value.get('snapshots')
    if not isinstance(steps, list) or [row.get('id') for row in steps] != expected:
        raise RuntimeError('Every asserted journey step needs an ordered source snapshot and provider')
    names = ['baseline', 'checkpoint_one', 'checkpoint_two', 'selected_submission', 'accepted', 'sparse_checkpoint']
    if not isinstance(snapshots, dict) or set(snapshots) != set(names):
        raise RuntimeError('Complete journey source snapshot inventory required')
    for snapshot in snapshots.values():
        if not isinstance(snapshot, dict) or set(snapshot) != {'revision_id', 'root_tree_id'} or any(
                not isinstance(item, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', item) is None
                for item in snapshot.values()):
            raise RuntimeError('Exact native revision/root identity required for each journey snapshot')
    source = value['source']
    if snapshots['accepted'] != {key: source[key] for key in ('revision_id', 'root_tree_id')}:
        raise RuntimeError('Accepted journey source differs from its snapshot')
    providers = {}
    for index, step in enumerate(steps):
        name = IDS[index]
        snapshot = 'accepted'
        assignment = value['replacement']['submission']['assignment_id']
        if index <= IDS.index('independent-qualification-before-task-release'):
            snapshot = 'baseline' if index == 0 else 'checkpoint_two'
            assignment = value['assignment']
        elif name == 'dependent-consumes-accepted-source':
            snapshot, assignment = 'selected_submission', value['selected_assignment']
        elif name in ('sparse-edit-materializes-only-scope', 'source-diff-matches-checkpoint'):
            snapshot = 'sparse_checkpoint'
        if step.get('source') != {'scope': source['scope'], **snapshots[snapshot]} or step.get('assignment_id') != assignment:
            raise RuntimeError('Journey step source or assignment differs: ' + name)
        provider = step.get('provider')
        fields = {'provider', 'pool_id', 'profile_id', 'account_key', 'environment_key', 'region', 'sandbox_id', 'boot_generation'}
        if not isinstance(provider, dict) or set(provider) != fields or any(
                not isinstance(item, str) or not item.strip() for item in provider.values()):
            raise RuntimeError('Complete actual provider identity required: ' + name)
        for field in ('pool_id', 'profile_id', 'sandbox_id'):
            if str(uuid.UUID(provider[field])) != provider[field]:
                raise RuntimeError('Canonical provider identity required: ' + name)
        if re.fullmatch(r'[1-9][0-9]*', provider['boot_generation']) is None:
            raise RuntimeError('Positive provider boot generation required: ' + name)
        if assignment in providers and providers[assignment] != provider:
            raise RuntimeError('Provider identity changed within one assignment')
        providers[assignment] = provider
    diff = value.get('source_diff', {})
    checkpoint = value.get('sparse_checkpoint', {})
    if (diff.get('before') != snapshots['accepted'] or diff.get('after') != snapshots['sparse_checkpoint']
            or checkpoint.get('revision_id') != snapshots['sparse_checkpoint']['revision_id']
            or checkpoint.get('workspace', {}).get('root_tree_id') != snapshots['sparse_checkpoint']['root_tree_id']
            or diff.get('workspace_id') != checkpoint.get('workspace', {}).get('workspace_id')):
        raise RuntimeError('Source diff does not identify the exact sparse checkpoint')
    api, cli = diff.get('api', {}), diff.get('cli', {})
    if (not api or api.get('entries') != cli.get('entries') or len(api.get('entries', [])) != 1
            or api['entries'][0].get('path') != 'main.txt' or api['entries'][0].get('kind') != 'MODIFIED'):
        raise RuntimeError('API and CLI must observe the one scoped checkpoint edit')
    for observed in (api, cli):
        if (observed.get('coverage', {}).get('state') != 'COMPLETE' or observed.get('next_cursor') is not None
                or observed.get('before_revision_id') != snapshots['accepted']['revision_id']
                or observed.get('after_revision_id') != snapshots['sparse_checkpoint']['revision_id']):
            raise RuntimeError('Source diff coverage or pinned revision differs')

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
    verify_journey_steps(value, expected)
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
