#!/usr/bin/env python3
"""Canonical verifier conformance and independently consumed layout evidence."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[4]
HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


Q = module('verifier_layout_qualify', ROOT / 'tests/hyperfide/qualify.py')


def require(value, message):
    if not value:
        raise ValueError(message)


def assertion(name, value=True):
    print(json.dumps({'type': 'assertion', 'id': name, 'expected': True, 'actual': value}), flush=True)


def campaign_tests():
    tests = module('release_conformance_tests', HERE.parent / 'release_campaign_test.py')
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(tests.ReleaseCampaignTest)
    identities = [test.id().rsplit('.', 1)[-1] for test in suite]
    result = unittest.TextTestRunner(stream=sys.stderr, verbosity=1).run(suite)
    failed = {test.id().rsplit('.', 1)[-1] for test, _ in result.errors + result.failures}
    for identity in identities:
        assertion('campaign.' + identity, identity not in failed)
    print(json.dumps({'type': 'cleanup', 'complete': result.wasSuccessful(), 'resources': []}))
    return 0 if result.wasSuccessful() else 1


def run_child(argv, output, label, timeout):
    command, stdout, stderr = Q.run_child(argv, ROOT, timeout, dict(os.environ))
    (output / (label + '-stdout.log')).write_bytes(stdout)
    (output / (label + '-stderr.log')).write_bytes(stderr)
    require(command['exit_code'] == 0 and not command['timed_out']
            and not command.get('remaining_descendants') and not command.get('leaked_descendants'),
            label + ' did not complete with owned process cleanup')
    return command, stdout


def verifier(output):
    config = json.loads((HERE / 'verifier_cases.json').read_text())
    observations = []
    for driver in config['drivers']:
        command, stdout = run_child([sys.executable, *driver['argv']], output, driver['id'], 600)
        events = []
        for line in stdout.decode().splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get('type') == 'assertion':
                events.append(event)
        require(len(events) == len(driver['assertions'])
                and {event['id'] for event in events} == set(driver['assertions']),
                'Conformance assertion inventory changed: ' + driver['id'])
        for event in events:
            require(event.get('expected') == event.get('actual'), 'Conformance check failed: ' + event['id'])
            assertion('SCM-024.' + driver['id'] + '.' + event['id'])
        observations.append({'driver': driver['id'], 'command': command, 'assertions': driver['assertions']})
    workflow = ROOT / 'spec/workflow.kvx'
    before = Q.digest(workflow.read_bytes())
    command, stdout = run_child([sys.executable, 'spec/hyperfide-source-control/tools/validate_spec.py'], output, 'authoring', 120)
    authoring = json.loads(stdout)
    require(authoring.get('status') == 'PASS' and authoring.get('scope') == 'specification-authoring'
            and authoring.get('product_qualification') == 'UNRUN', 'Authoring must not self-qualify product cases')
    assertion('SCM-024.authoring-traceability')
    require(Q.digest(workflow.read_bytes()) == before, 'Validation changed active workflow')
    assertion('SCM-024.authoring-preserves-workflow')
    (output / 'verifier-conformance.json').write_text(json.dumps({'schema_version': 1, 'scope': 'verifier protocol conformance, not product release closure', 'drivers': observations, 'authoring': command}, indent=2) + '\n')


def task_dependencies():
    text = (ROOT / 'spec/hyperfide-source-control/spec.kvx').read_text()
    sections = dict(re.findall(r'^\[task\.([^\]]+)\]\n(.*?)(?=^\[|\Z)', text, re.M | re.S))
    def requires(task):
        match = re.search(r'^requires\s*=\s*(\[[^\n]*\])', sections[task], re.M)
        return json.loads(match.group(1))
    require('0.9' in requires('0.10') and '0.14' in requires('0.1'), 'Layout/fleet/native prerequisite ordering changed')
    for task in ['0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9']:
        require(all(value in {'0.3', '0.4', '0.5', '0.6', '0.7', '0.8', '0.9'} for value in requires(task)), 'Layout gained native SCM dependency: ' + task)


def layout(output):
    command, _ = run_child([sys.executable, 'tests/hyperfide/cases/source_control/0_9.py'], output, 'layout', 600)
    record = json.loads((ROOT / 'build/layout/0.9/receipt.json').read_text())
    require(record.get('status') == 'PASS' and record.get('case_qualification') == 'PASS'
            and not record.get('missing_evidence') and not record.get('regressions'), 'Current complete layout evidence is required')
    binding = module('layout_binding', ROOT / 'tests/hyperfide/cases/source_control/0_9.py')
    now = binding.capture_bindings()
    require(record['bindings']['source_snapshot'] == now['source_snapshot'], 'Layout receipt is stale')
    checks = {item['id']: item['status'] for item in record['checks']}
    require(all(value == 'PASS' for value in checks.values()), 'A layout conservation check did not pass')
    for task in ['0.4', '0.5', '0.6', '0.7', '0.8']:
        require(task in record['task_receipts'], 'Missing actual layout runtime receipt ' + task)
    assertion('SCM-025.category-content-mode-conservation')
    assertion('SCM-025.public-identities-preserved')
    assertion('SCM-025.root-workspace-and-dependencies')
    assertion('SCM-025.native-sdk-app-consumers')
    assertion('SCM-025.ci-release-and-prepared-image')
    assertion('SCM-025.current-complete-layout-receipt')
    task_dependencies()
    assertion('SCM-025.layout-fleet-native-ordering')
    mapping = json.loads((ROOT / 'spec/hyperfide-source-control/repository-layout.json').read_text())
    require(record['rollback']['baseline_revision'] == mapping['implementation_baseline']
            and record['rollback']['inverse_inventory'] and record['rollback']['policy'], 'Historical rollback lineage is missing')
    assertion('SCM-025.original-baseline-and-rollback-lineage')
    require(record['bindings']['mapping_sha256'] == binding.digest(ROOT / 'spec/hyperfide-source-control/repository-layout.json'), 'Layout mapping changed')
    assertion('SCM-025.historical-git-evidence-preserved')
    (output / 'layout-conformance.json').write_text(json.dumps({'schema_version': 1, 'command': command, 'layout_receipt_sha256': binding.digest(ROOT / 'build/layout/0.9/receipt.json'), 'scope': 'Current layout evidence with original Git baseline retained'}, indent=2) + '\n')
    (output / 'layout-receipt.json').write_bytes((ROOT / 'build/layout/0.9/receipt.json').read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case', choices=['SCM-024', 'SCM-025'])
    parser.add_argument('--campaign-tests', action='store_true')
    args = parser.parse_args()
    if args.campaign_tests:
        return campaign_tests()
    require(args.case, 'Explicit canonical case required')
    output = Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR', ROOT / 'build/source-control/full-case' / (args.case + '-' + str(uuid.uuid4()))))
    output.mkdir(parents=True, exist_ok=True)
    try:
        (verifier if args.case == 'SCM-024' else layout)(output)
        print(json.dumps({'type': 'cleanup', 'complete': True, 'resources': []}))
        return 0
    except (ValueError, KeyError, OSError) as error:
        print(json.dumps({'status': 'BLOCKED', 'case': args.case, 'diagnostic': str(error)}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
