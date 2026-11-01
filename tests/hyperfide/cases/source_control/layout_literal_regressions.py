#!/usr/bin/env python3
"""One consumer gate for the reviewed historical literal-prefix regressions."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import time

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/layout/0.9'
SELF = Path(__file__).resolve()
SUPPORT = SELF.parent / 'support/layout_literal_consumers.mjs'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    review = json.loads((OUT / 'reviewed-source-dispositions.json').read_text())
    nodes = sorted((ROOT / 'build/fleet/seed').glob('*/payload/opt/hyperfide/runtime/node'))
    node = str(nodes[0]) if nodes else '/usr/local/bin/node'
    args = [node, '--conditions=source', '--import', 'tsx', str(SUPPORT)]
    started = time.monotonic()
    result = subprocess.run(args, cwd=ROOT, env={'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(OUT), 'NO_COLOR': '1'}, capture_output=True, text=True, timeout=150)
    log = OUT / 'source-literal-regressions.log'
    log.write_text(result.stdout + result.stderr)
    report = {'schema_version': 1, 'status': 'FAIL', 'scope': 'actual public consumers and historical production blob regression checks; no application/native package qualification', 'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(), 'commands': [], 'assertions': []}
    paths = [SELF, SUPPORT, SUPPORT.parent / 'layout_metro_consumer.mjs', SELF.parent / '0_9.py', OUT / 'reviewed-source-dispositions.json', *[ROOT / row['target'] for row in review['flagged_rewrites']]]
    report['commands'].append({'id': 'literal-consumers', 'command': args, 'exit_code': result.returncode, 'duration_ms': int((time.monotonic() - started) * 1000), 'log': str(log.relative_to(ROOT)), 'log_sha256': sha(log), 'inputs': {str(path.relative_to(ROOT)): sha(path) for path in paths}})
    if result.returncode == 0:
        data = json.loads(result.stdout.strip().splitlines()[-1])
        if data.get('status') == 'PASS':
            report['status'] = 'PASS'
            report['assertions'] = [dict(row, command_id='literal-consumers') for row in data['assertions']]
    (OUT / 'source-literal-regressions-receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'exit_code': result.returncode, 'assertions': len(report['assertions']), 'log': str(log.relative_to(ROOT))}))
    return 0 if report['status'] == 'PASS' else 1


if __name__ == '__main__':
    raise SystemExit(main())
