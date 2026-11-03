#!/usr/bin/env python3
"""Exercise the qualification registry, native capture and independent checker."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[4]

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

def main():
    q = load('source_qualification', ROOT / 'tests/hyperfide/qualify.py')
    passed = []
    def check(name, operation):
        operation()
        passed.append(name)
        print(json.dumps({'type': 'assertion', 'id': name, 'expected': True, 'actual': True}), flush=True)
    def refused(operation):
        try:
            operation()
        except (q.GateError, ValueError):
            return
        raise AssertionError('Expected native qualification refusal')
    legacy, _ = q.load_registry(ROOT / 'tests/hyperfide/registry.json')
    registry, variants = q.load_registry(ROOT / 'tests/hyperfide/source-control/registry.json')
    check('source-harness.registry.namespaces', lambda: (len(registry['cases']) == 29 and set(registry['cases']).isdisjoint(legacy['cases'])) or (_ for _ in ()).throw(AssertionError('namespace collision')))
    check('source-harness.registry.future-cases', lambda: all(case['status'] == 'UNRUN' and case['prerequisites'] for case in registry['cases'].values()) or (_ for _ in ()).throw(AssertionError('case lacks prerequisites')))
    with tempfile.TemporaryDirectory(prefix='hf-native-qualification-') as temporary:
        root = Path(temporary)
        fixture = load('native_campaign_fixture', ROOT / 'tests/hyperfide/source-control/campaign_fixture.py')
        native, registration, manifest, isolated_registry = fixture.create_campaign(root, q)
        evidence = ROOT / 'build/source-control/0.2'
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / 'native-manifest.json').write_bytes(q.canonical(manifest))
        check('source-harness.native.capture', lambda: q.native_capture(root, native, ['native.bytes']))
        for field, value in [('root_tree_id', 'sha256:' + 'c' * 64), ('authority_epoch', str(uuid.uuid4())), ('test_inventory_sha256', '0' * 64)]:
            altered = {**native, field: value}
            check('source-harness.refuse.' + field, lambda value=altered: refused(lambda: q.native_capture(root, value, ['native.bytes'])))
        altered = copy.deepcopy(native); altered['readiness_receipt']['sha256'] = '0' * 64
        check('source-harness.refuse.forged-receipt', lambda: refused(lambda: q.native_capture(root, altered, ['native.bytes'])))
        altered = copy.deepcopy(manifest); altered['case_ids'] = ['V-001']
        check('source-harness.refuse.mixed-cases', lambda: refused(lambda: q.validate_manifest(altered, registration, isolated_registry)))
        altered = copy.deepcopy(manifest); altered['schema_version'] = 3
        check('source-harness.refuse.version', lambda: refused(lambda: q.validate_manifest(altered, registration, isolated_registry)))
        altered = copy.deepcopy(native); altered['readiness_receipt']['path'] = 'missing.json'
        check('source-harness.refuse.missing-receipt', lambda: refused(lambda: q.native_capture(root, altered, ['native.bytes'])))
        duplicate = root / 'registrations/duplicate.json'
        duplicate.write_bytes(q.canonical(registration))
        check('source-harness.refuse.duplicate-variant', lambda: refused(lambda: q.load_registry(root / 'registry.json')))
        duplicate.unlink()
        def campaign_namespace():
            campaign = {**registration, 'task': '6.2', 'campaign': 'growth', 'variant': 'campaign:hyperfide-source-control/6.2/growth'}
            target = root / 'registrations/campaign.json'
            try:
                target.write_bytes(q.canonical(campaign))
                q.load_registry(root / 'registry.json')
                target.write_bytes(q.canonical({**campaign, 'variant': 'campaign:other/6.2/growth'}))
                refused(lambda: q.load_registry(root / 'registry.json'))
                target.write_bytes(q.canonical({**campaign, 'campaign': 'invented'}))
                refused(lambda: q.load_registry(root / 'registry.json'))
            finally:
                target.unlink(missing_ok=True)
        check('source-harness.native.campaign-registration', campaign_namespace)
        def case_namespace():
            case = {**registration, 'task': '6.3', 'scope': 'full-case', 'case_variant': 'api-cli-ui', 'variant': 'case:hyperfide-source-control/SCM-024/api-cli-ui'}
            target = root / 'registrations/case.json'
            try:
                target.write_bytes(q.canonical(case))
                q.load_registry(root / 'registry.json')
                target.write_bytes(q.canonical({**case, 'variant': 'case:hyperfide-source-control/SCM-023/api-cli-ui'}))
                refused(lambda: q.load_registry(root / 'registry.json'))
                full_registry=copy.deepcopy(isolated_registry)
                full_registry['cases']['SCM-024']['full_assertion_ids']=['native.bytes']
                full_manifest={**manifest, 'scope':'full-case', 'policy':{'source_variant':'api-cli-ui'}}
                q.validate_manifest(full_manifest,case,full_registry)
                refused(lambda:q.validate_manifest({**full_manifest,'policy':{'source_variant':'other'}},case,full_registry))
            finally:
                target.unlink(missing_ok=True)
        check('source-harness.native.full-case-registration', case_namespace)
        proc = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/qualify.py'), '--root', str(root), '--registry', str(root / 'registry.json'), '--manifest', str(root / 'manifest.json'), '--task', 'hyperfide-source-control/0.2'], cwd=root, text=True, capture_output=True, timeout=60)
        if proc.returncode:
            raise AssertionError(proc.stdout + proc.stderr)
        summary = json.loads(proc.stdout.splitlines()[-1])
        check('source-harness.native.independent-checker', lambda: summary['status'] == 'PASS' or (_ for _ in ()).throw(AssertionError(summary)))
        receipt_path = Path(summary['campaign_dir']) / 'receipts' / (summary['receipt_id'] + '.json')
        receipt = json.loads(receipt_path.read_text())
        check('source-harness.native.no-git-identity', lambda: receipt['source']['commit'] is None and receipt['source']['backend'] == 'native' and receipt['source']['native'] == native or (_ for _ in ()).throw(AssertionError(receipt['source'])))
        check('source-harness.native.campaign-namespace', lambda: q.evidence_store.task_of_campaign(Path(summary['campaign_dir'])) == (root, 'hyperfide-source-control/0.2') or (_ for _ in ()).throw(AssertionError('Native campaign did not retain its namespace')))
        publisher = load('native_evidence_publisher', ROOT / 'tests/hyperfide/publish-evidence.py')
        rows = publisher.plan(root, ['hyperfide-source-control/0.2'])
        check('source-harness.native.namespaced-bundle', lambda: len(rows) == 1 and rows[0]['task'] == 'hyperfide-source-control/0.2' and rows[0]['commits'] == {} and 'error' not in rows[0] or (_ for _ in ()).throw(AssertionError(rows)))
        try:
            q.evidence_store.resolve(root, 'hyperfide-source-control/0.2', True)
        except q.evidence_store.EvidenceUnavailable as error:
            check('source-harness.native.required-store-refusal', lambda: 'hyperfide-source-control/0.2' in str(error) and 'no receipt' in str(error) or (_ for _ in ()).throw(AssertionError(str(error))))
        else:
            raise AssertionError('Missing native receipt was accepted as required evidence')
        legacy_registration = {k: v for k, v in registration.items() if k != 'feature'}
        legacy_registration.update(schema_version=1, variant='task:0.2', cases=['V-001'])
        legacy_manifest = {k: v for k, v in manifest.items() if k not in ('native_source', 'feature')}
        legacy_manifest.update(schema_version=1, campaign_id='legacy-harness', registered_variant='task:0.2', case_ids=['V-001'])
        legacy_registry = {'schema_version': 1, 'cases': {'V-001': {'full_assertion_ids': []}}, 'suites': {}, 'registration_glob': 'registrations/legacy.json'}
        for name, value in [('legacy-registry.json', legacy_registry), ('legacy-manifest.json', legacy_manifest), ('registrations/legacy.json', legacy_registration)]:
            (root / name).write_bytes(q.canonical(value))
        legacy_proc = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/qualify.py'), '--root', str(root), '--registry', str(root / 'legacy-registry.json'), '--manifest', str(root / 'legacy-manifest.json'), '--task', '0.2'], cwd=root, text=True, capture_output=True, timeout=60)
        check('source-harness.legacy.independent-checker', lambda: legacy_proc.returncode == 0 or (_ for _ in ()).throw(AssertionError(legacy_proc.stdout + legacy_proc.stderr)))

    print(json.dumps({'type': 'cleanup', 'complete': True, 'resources': []}))
    evidence = ROOT / 'build/source-control/0.2'
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / 'receipt.json').write_text(json.dumps({'status': 'PASS', 'checks': passed}, indent=2) + '\n')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
