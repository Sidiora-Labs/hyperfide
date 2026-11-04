#!/usr/bin/env python3
"""Execute complete core-case assertions across real codec, API and database boundaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
DEFINITIONS = Path(__file__).with_name('core_cases.json')


def executed_reports(output):
    records = []
    decoder = json.JSONDecoder()
    position = 0
    while True:
        position = output.find('{', position)
        if position < 0:
            break
        try:
            value, length = decoder.raw_decode(output[position:])
            if isinstance(value, dict):
                records.append(value)
            position += max(1, length)
        except json.JSONDecodeError:
            position += 1
    return [value for value in records if value.get("status") in ("PASS", "COMPONENT_PASS") and ("checks" in value or "assertions" in value)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', required=True)
    parser.add_argument('--definitions', type=Path, default=DEFINITIONS)
    args = parser.parse_args()
    selected=args.definitions if args.definitions.is_absolute() else ROOT/args.definitions
    definitions = json.loads(selected.read_text())
    case = definitions[args.case]
    output = ROOT / 'build/source-control/full-case' / args.case
    output.mkdir(parents=True, exist_ok=True)
    env = {key: value for key, value in os.environ.items() if key != 'DATABASE_URL'}
    runs = {}
    for name in case['drivers']:
        driver = definitions['drivers'][name]
        command = [sys.executable, str(ROOT / driver['path']), *driver.get('args', [])]
        driver_env = {**env, **driver.get("env", {})}
        if driver.get("env", {}).get("HYPERFIDE_SOURCE_EVIDENCE_DIR"):
            driver_env["HYPERFIDE_SOURCE_EVIDENCE_DIR"] = str((ROOT / driver_env["HYPERFIDE_SOURCE_EVIDENCE_DIR"]).resolve())
        result = subprocess.run(command, cwd=ROOT, env=driver_env, text=True, capture_output=True, timeout=driver.get('timeout_seconds', 600))
        log = result.stdout + result.stderr
        (output / (name + '.log')).write_text(log)
        if result.returncode:
            sys.stderr.write(log[-20000:])
            raise RuntimeError(f'{name} exited {result.returncode}; no full-case assertions emitted')
        records = executed_reports(result.stdout)
        report = records[-1] if records else None
        if records and driver.get('combine_reports'):
            report = {'status': 'PASS' if all(value['status'] == 'PASS' for value in records) else 'COMPONENT_PASS', 'checks': list(dict.fromkeys(check for value in records for check in value.get('checks', []))), 'assertions': [item for value in records for item in value.get('assertions', [])], 'reports': records}
        if report is None:
            raise RuntimeError(f'{name} produced no executed assertion report')
        runs[name] = {'report': report, 'log_sha256': hashlib.sha256(log.encode()).hexdigest()}
    assertions = []
    for item in case['assertions']:
        report = runs[item['driver']]['report']
        actual = ((item['check'] in report.get('checks', []) or item['check'] in report.get('assertions', [])) if 'check' in item else any(value.get('id') == item['codec_assertion'] and value.get('outcome') == 'PASS' for value in report.get('assertions', [])))
        if not actual:
            raise RuntimeError('Missing executed assertion ' + item['id'])
        assertions.append({'type': 'assertion', 'id': item['id'], 'expected': True, 'actual': True})
    cleanup = runs[case['cleanup_driver']]['report'].get('cleanup') if case.get('cleanup_driver') else {'complete': True, 'resources': []}
    if not isinstance(cleanup, dict) or cleanup.get('complete') is not True or not isinstance(cleanup.get('resources'), list):
        raise RuntimeError('Missing executed resource cleanup inventory')
    receipt = {'schema_version': 1, 'case': args.case, 'status': 'PASS', 'backend': case.get('backend', 'owned PostgreSQL and bounded SigV4 HTTP object fixture; no live-S3 claim'), 'assertions': assertions, 'runs': runs, 'cleanup': cleanup}
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    for assertion in assertions:
        print(json.dumps(assertion), flush=True)
    print(json.dumps({'type': 'cleanup', **cleanup}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
