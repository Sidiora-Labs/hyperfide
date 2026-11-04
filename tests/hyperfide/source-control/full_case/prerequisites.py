#!/usr/bin/env python3
"""Verify actual prerequisite execution for canonical source-control cases."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('live_prerequisite', ROOT / 'tests/hyperfide/support/fleet_live_qualification.py')
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)
qualifier_spec = importlib.util.spec_from_file_location('prerequisite_qualify', ROOT / 'tests/hyperfide/qualify.py')
qualifier = importlib.util.module_from_spec(qualifier_spec)
qualifier_spec.loader.exec_module(qualifier)


def emit(name):
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': True, 'actual': True}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=['SCM-026', 'SCM-027', 'SCM-028', 'SCM-029'], required=True)
    args = parser.parse_args()
    output = Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR', ROOT / 'build/source-control/full-case' / args.case))
    output.mkdir(parents=True, exist_ok=True)
    config = json.loads((HERE / 'prerequisite_cases.json').read_text())[args.case]
    try:
        if args.case == 'SCM-026':
            command = [sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/0_10.py')]
            record, stdout, stderr = qualifier.run_child(command, ROOT, 120, dict(os.environ))
            (output / 'schema-stdout.log').write_bytes(stdout)
            (output / 'schema-stderr.log').write_bytes(stderr)
            (output / 'schema-command.json').write_text(json.dumps(record, indent=2) + '\n')
            if record['exit_code'] or record['timed_out'] or record.get('remaining_descendants') or record.get('leaked_descendants'):
                raise ValueError('Actual parser and interface-index execution failed')
            schema = json.loads(stdout)
            actual = schema['results']
            if schema.get('status') != 'PASS' or {x['id'] for x in actual} != set(config['schema_checks']) or any(x['outcome'] != 'PASS' for x in actual):
                raise ValueError('Parser/schema assertion inventory or result differs')
            for name in config['schema_checks']:
                emit(args.case + '.schema.' + name)
        evidence_path = os.environ.get('HF_FLEET_QUALIFICATION_EVIDENCE')
        target_path = os.environ.get('HF_FLEET_QUALIFICATION_TARGET')
        if not evidence_path or not target_path:
            raise ValueError('Actual private fleet execution evidence and database target are required')
        evidence = live.private_json(evidence_path)
        target = live.private_json(target_path)
        # Always verify the complete real chain, not a component or archived PASS flag.
        report = live.verify('0.14', evidence, target, Path(evidence_path).parent)
        if report.get('status') != 'PASS' or report.get('qualified') is not True:
            raise ValueError('Complete current fleet chain did not qualify')
        for name in config['live_checks']:
            if name not in report['assertions']:
                raise ValueError('Required actual fleet observation missing: ' + name)
            emit(args.case + '.live.' + name)
        emit(args.case + '.complete-live-authority-chain')
        (output / 'prerequisite-conformance.json').write_text(json.dumps({'schema_version': 1, 'case': args.case, 'status': 'PASS', 'selected_checks': config['live_checks'], 'complete_live_verification': report}, indent=2) + '\n')
        print(json.dumps({'type': 'cleanup', 'complete': True, 'resources': []}))
        return 0
    except (ValueError, OSError, KeyError, live.Refused, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'BLOCKED', 'case': args.case, 'diagnostic': str(error)}))
        return 77


if __name__ == '__main__':
    raise SystemExit(main())
