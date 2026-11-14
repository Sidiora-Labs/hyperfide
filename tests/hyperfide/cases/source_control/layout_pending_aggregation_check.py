#!/usr/bin/env python3
"""Require layout aggregation to be waiting only for its five runtime drivers."""
from pathlib import Path
import importlib.util
import json
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[4]
INPUTS = ROOT / 'spec/hyperfide-source-control/layout-aggregation-input.json'
RECEIPT = 'build/layout/0.9/receipt.json'
PENDING_TASKS = frozenset({'0.4', '0.5', '0.6', '0.7', '0.8'})


def validate_pending_aggregation(summary, report, returncode):
    if not isinstance(summary, dict):
        raise ValueError('Aggregation summary must be an object')
    expected = {
        'task': '0.9', 'status': report['status'], 'checks': len(report['checks']),
        'missing_evidence': len(report['missing_evidence']),
        'missing_evidence_kinds': [item['kind'] for item in report['missing_evidence']],
        'regressions': len(report['regressions']), 'receipt': RECEIPT,
    }
    if summary != expected:
        raise ValueError('Aggregation summary differs from its recorded receipt')
    if summary['regressions'] != 0:
        raise ValueError('Layout regression: ' + report['regressions'][0])
    for item in report['missing_evidence']:
        if item['kind'] != 'task-runtime-receipt' or item.get('task') not in PENDING_TASKS:
            raise ValueError('Unexpected missing evidence: ' + json.dumps(item, sort_keys=True))
    if not report['checks']:
        raise ValueError('No layout checks were recorded')
    for check in report['checks']:
        if check['status'] != 'PASS':
            raise ValueError('Layout check failed: ' + check['id'])
    expected_status = 'BLOCKED' if report['missing_evidence'] else 'PASS'
    if report['status'] != expected_status or returncode != (2 if expected_status == 'BLOCKED' else 0):
        raise ValueError('Aggregation status or process exit differs from its recorded evidence')


def main():
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('0_9.py')),
                                 '--inputs', str(INPUTS)], cwd=ROOT, text=True, capture_output=True)
        sys.stderr.write(result.stderr)
        lines = result.stdout.splitlines()
        if not lines:
            raise ValueError('Aggregation emitted no final JSON summary')
        summary = json.loads(lines[-1])
        print(json.dumps(summary), flush=True)
        spec = importlib.util.spec_from_file_location('layout_pending_producer', Path(__file__).with_name('0_9.py'))
        producer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(producer)
        report = producer.document(ROOT / RECEIPT)
        producer.validate_layout_receipt(report)
        validate_pending_aggregation(summary, report, result.returncode)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('Pending layout aggregation refused: ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
