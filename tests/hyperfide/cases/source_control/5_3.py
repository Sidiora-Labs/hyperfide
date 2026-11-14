#!/usr/bin/env python3
"""Exercise native consolidation, dirty preservation and process death at commit boundaries."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('native_source_fixture', ROOT / 'tests/hyperfide/support/native_source_fixture.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
CRASH_BOUNDARIES = [
    'before-quiesce-commit', 'after-quiesce-commit',
    'before-activate-commit', 'after-activate-commit', 'after-recover',
]


def test_migration_boundaries_and_deployment_record():
    evidence = Path(os.environ.get('HYPERFIDE_SOURCE_EVIDENCE_DIR', ROOT / 'build/source-control/5.3'))
    result = fixture.run_source_actor(ROOT / 'tests/hyperfide/support/native_source_migration_actor.mjs', migrations=[
        '0736-source-control-storage.sql', '0737-source-control-metadata.sql', '0738-source-control-capabilities.sql',
        '0739-source-control-workspaces.sql', '0740-source-control-transformations.sql', '0741-source-control-acceptance.sql',
        '0742-source-control-publication.sql', '0743-source-control-assurance.sql', '0746-source-control-retention.sql',
        '0748-source-control-graph.sql', '0750-source-control-import.sql', '0751-source-control-cutover.sql',
        '0754-source-control-epoch-adoption.sql', '0755-source-control-final-delta.sql',
    ], timeout=300, actor_env={
        'HYPERFIDE_MIGRATION_CRASH_BOUNDARIES': json.dumps(CRASH_BOUNDARIES),
        'HYPERFIDE_SOURCE_EVIDENCE_DIR': str(evidence),
    })
    if result:
        return result
    receipt = json.loads((evidence / 'receipt.json').read_text())
    assert receipt['status'] == 'PASS'
    assert receipt['deployment_migration'] == 'UNRUN'
    assert receipt['crash_boundaries'] == CRASH_BOUNDARIES
    assert receipt['authority_epoch'] == '3'
    assert receipt['kernel_legacy_write_denied'] is True
    assert receipt['backend_requests'] > 0
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    receipt['revision'] = revision
    receipt['source_task'] = '5.3'
    run_dir, out_dir = os.environ.get('HF_RUN_DIR'), os.environ.get('HF_OUT_DIR')
    if run_dir and out_dir:
        ledger = [json.loads(line) for line in (Path(run_dir) / 'gates.jsonl').read_text().splitlines() if line]
        build = [entry for entry in ledger if entry['kind'] == 'build'][-1]
        assert build['revision'] == revision and build['exit'] == 0
        receipt['build_reference'] = {key: build[key] for key in ('revision', 'command', 'exit', 'log')}
        sequence = 1 + len([entry for entry in ledger if entry['kind'] == 'verify'])
        receipt['verification_reference'] = {
            'revision': revision,
            'command': 'cg spec done 22.37.22 -f layerx-merge --root ' + str(ROOT.parents[1]),
            'log': str(Path(out_dir) / 'logs' / ('verify-' + str(sequence) + '.log')),
        }
    (evidence / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return 0


def run_namespace_init():
    """Reap the case and any orphaned descendants as the namespace's pid 1."""
    case_pid = os.fork()
    if case_pid == 0:
        os.execv(sys.executable, [sys.executable, str(Path(__file__).resolve()), '--isolated'])
    while True:
        try:
            pid, status = os.waitpid(-1, 0)
        except InterruptedError:
            continue
        if pid == case_pid:
            code = os.waitstatus_to_exitcode(status)
            return code if code >= 0 else 128 - code


if __name__ == '__main__':
    if not os.environ.get('DATABASE_URL'):
        raise SystemExit(subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode)
    if '--namespace-init' in sys.argv:
        raise SystemExit(run_namespace_init())
    if '--isolated' not in sys.argv:
        # Root already owns the sandbox authority. A nested user namespace loses
        # visibility into inherited process handles during real isolation scans.
        user_namespace = [] if os.geteuid() == 0 else ['--user', '--map-root-user']
        raise SystemExit(subprocess.run(['unshare', *user_namespace, '--mount', '--pid', '--fork', '--mount-proc', '--propagation', 'private', sys.executable, str(Path(__file__).resolve()), '--namespace-init'], cwd=ROOT).returncode)
    raise SystemExit(test_migration_boundaries_and_deployment_record())
