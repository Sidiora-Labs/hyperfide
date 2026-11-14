#!/usr/bin/env python3
"""Exercise layout receipt production, persistent consumption and vendored Git."""
from datetime import datetime, timezone
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest


def load_driver(name):
    spec = importlib.util.spec_from_file_location('layout_gate_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PRODUCER = load_driver('0_9')
CONSUMER = load_driver('0_10')
PENDING = load_driver('layout_pending_aggregation_check')


class LayoutReceiptGateTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='layout-receipt-')
        self.addCleanup(self.temporary.cleanup)
        self.host = Path(self.temporary.name)
        self.root = self.host / 'tools/hyperfide'
        self.root.mkdir(parents=True)
        self.git('init', '-q')
        self.mapping = copy.deepcopy(PRODUCER.document(PRODUCER.PACK / 'repository-layout.json'))
        self.write('.gitignore', 'build/\n__pycache__/\n')
        self.write('spec/hyperfide-source-control/repository-layout.json', self.mapping)
        self.copy('tests/hyperfide/source-control/layout-receipt.schema.json')
        self.copy('tools/repository/layout-inventory.py')
        self.write('core/runtime.txt', 'runtime source\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Import real layout fixture')
        self.revision = self.git('rev-parse', 'HEAD')
        self.path = self.root / 'build/layout/0.9/receipt.json'
        bindings = PRODUCER.capture_bindings(self.root)
        self.report = {
            'schema_version': 1, 'task': '0.9', 'case': 'SCM-025',
            'checked_at': datetime.now(timezone.utc).isoformat(),
            'bindings': {'baseline_revision': self.revision, **bindings,
                         'worktree_status_sha256': hashlib.sha256(b'').hexdigest(),
                         'source_inventory_sha256': hashlib.sha256(b'inventory').hexdigest(),
                         'layout_revision': self.revision,
                         'layout_inventory_sha256': hashlib.sha256(b'layout').hexdigest()},
            'checks': [{'id': 'fixture.source-binding', 'status': 'PASS', 'evidence': bindings}],
            'missing_evidence': [], 'regressions': [], 'exclusions': [],
            'task_receipts': {task: {} for task in PRODUCER.REQUIRED},
            'required_assertions': PRODUCER.REQUIRED,
            'summary': {}, 'rollback': {}, 'semantic_flags': [],
        }

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Layout Fixture',
                                        '-c', 'user.email=layout@example.invalid',
                                        '-c', 'commit.gpgsign=false', *args], cwd=self.host, text=True).strip()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + '\n' if isinstance(value, dict) else value)
        return path

    def copy(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(PRODUCER.ROOT / name, path)

    def emit(self):
        return PRODUCER.emit_report(self.report, self.path)

    def test_untracked_candidate_files_leave_final_revision_clean(self):
        bindings = self.report['bindings']
        self.assertEqual(PRODUCER.check_final_revision_clean(bindings, self.root)['status'], 'PASS')
        self.assertEqual(bindings['untracked_paths'], [])
        self.assertEqual(bindings['untracked_paths_count'], 0)
        original_digest = bindings['worktree_status_sha256']
        self.write('core/untracked output\nπ.txt', 'generated output\n')
        (self.host / 'untracked-host.txt').write_text('host output\n')
        check = PRODUCER.check_final_revision_clean(bindings, self.root)
        self.assertEqual(check['id'], 'source.final-revision-clean')
        self.assertEqual(check['status'], 'PASS')
        self.assertEqual(bindings['worktree_status_sha256'], original_digest)
        self.assertEqual(bindings['untracked_paths'], [
            'tools/hyperfide/core/untracked output\nπ.txt', 'untracked-host.txt'])
        self.assertEqual(bindings['untracked_paths_count'], 2)
        bindings.update(PRODUCER.capture_bindings(self.root))
        self.report['checks'] = [check]
        self.assertEqual(self.emit(), 0)
        emitted = CONSUMER.require_layout_receipt(self.root)
        self.assertEqual(emitted['bindings']['untracked_paths'], bindings['untracked_paths'])
        self.assertEqual(emitted['bindings']['untracked_paths_count'], 2)

    def test_retained_pass_receipt_rejects_stale_source_bindings(self):
        for name in ['0_9', '0_10']:
            self.copy('tests/hyperfide/cases/source_control/' + name + '.py')
        source = self.root / 'core/runtime.txt'
        obsolete = self.root / 'services/obsolete.txt'
        neighbor = self.host / 'neighbor.txt'
        mapping_path = self.root / 'spec/hyperfide-source-control/repository-layout.json'
        mapping_bytes = mapping_path.read_bytes()
        restart = "import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('consumer', 'tests/hyperfide/cases/source_control/0_10.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.require_layout_receipt(Path.cwd())['status'])"
        mutations = [(kind, state) for kind in ['edit', 'delete', 'mode', 'workspace', 'excluded', 'obsolete']
                     for state in ['unstaged', 'staged', 'committed']
                     if kind != 'obsolete' or state != 'unstaged']
        mutations.extend([('unchanged', 'restart'), ('outside', 'unstaged'),
                          ('outside', 'staged'), ('outside', 'committed'), ('untracked', 'unstaged')])
        for kind, state in mutations:
            with self.subTest(kind=kind, state=state):
                self.write('core/runtime.txt', 'runtime source\n')
                source.chmod(0o644)
                self.write('pnpm-workspace.yaml', 'packages:\n  - core/*\n')
                self.write('tests/tracked.txt', 'tracked test input\n')
                neighbor.write_text('outside source\n')
                if obsolete.exists():
                    obsolete.unlink()
                    obsolete.parent.rmdir()
                self.git('add', '.')
                self.git('commit', '--allow-empty', '-qm', 'Prepare clean receipt candidate')
                bindings = PRODUCER.capture_bindings(self.root)
                check = PRODUCER.check_final_revision_clean(bindings, self.root)
                self.assertEqual(check['status'], 'PASS')
                self.report['bindings'].update(bindings)
                self.report['checks'] = [check]
                self.assertEqual(self.emit(), 0)
                PRODUCER.validate_layout_receipt(PRODUCER.document(self.path))
                accepted = CONSUMER.require_layout_receipt(self.root)
                self.assertEqual(accepted['status'], 'PASS')
                retained = self.path.read_bytes()

                if kind == 'edit':
                    source.write_text('changed runtime source\n')
                elif kind == 'delete':
                    source.unlink()
                elif kind == 'mode':
                    source.chmod(0o755)
                elif kind == 'workspace':
                    self.write('pnpm-workspace.yaml', 'packages:\n  - core/*\n  - apps/*\n')
                elif kind == 'excluded':
                    self.write('tests/tracked.txt', 'changed tracked test input\n')
                elif kind == 'obsolete':
                    self.write('services/obsolete.txt', 'obsolete source container\n')
                elif kind == 'outside':
                    neighbor.write_text('changed outside source\n')
                elif kind == 'untracked':
                    self.write('tests/untracked.txt', 'untracked test output\n')
                if state in ['staged', 'committed']:
                    self.git('add', '-A')
                if state == 'committed':
                    self.git('commit', '-qm', 'Commit candidate mutation')

                self.assertEqual(self.path.read_bytes(), retained)
                self.assertEqual(mapping_path.read_bytes(), mapping_bytes)
                current = PRODUCER.capture_bindings(self.root)
                clean = PRODUCER.check_final_revision_clean(current, self.root)
                if kind in ['unchanged', 'outside', 'untracked']:
                    self.assertEqual(clean['status'], 'PASS')
                    self.assertEqual(CONSUMER.require_layout_receipt(self.root), accepted)
                    if kind == 'outside' and state == 'committed':
                        self.assertNotEqual(current['source_revision'], bindings['source_revision'])
                        self.assertEqual(current['source_tree_id'], bindings['source_tree_id'])
                    result = subprocess.run([sys.executable, '-c', restart], cwd=self.root,
                                            text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), 'PASS')
                else:
                    if state == 'committed':
                        self.assertEqual(clean['status'], 'PASS')
                        self.assertNotEqual(current['source_tree_id'], bindings['source_tree_id'])
                    else:
                        self.assertEqual(clean['status'], 'FAIL')
                    if kind == 'excluded':
                        self.assertEqual(current['source_snapshot'], bindings['source_snapshot'])
                    with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
                        CONSUMER.require_layout_receipt(self.root)
                self.assertEqual(self.path.read_bytes(), retained)

    def test_modified_tracked_candidate_file_fails_final_revision_clean(self):
        bindings = self.report['bindings']
        self.write('core/runtime.txt', 'modified tracked source\n')
        for staged in [False, True]:
            with self.subTest(staged=staged):
                if staged:
                    self.git('add', 'tools/hyperfide/core/runtime.txt')
                check = PRODUCER.check_final_revision_clean(bindings, self.root)
                self.assertEqual(check['id'], 'source.final-revision-clean')
                self.assertEqual(check['status'], 'FAIL')
                self.assertNotEqual(bindings['worktree_status_sha256'], hashlib.sha256(b'').hexdigest())
                self.assertEqual(bindings['untracked_paths'], [])
                self.assertEqual(bindings['untracked_paths_count'], 0)
                self.report['checks'] = [check]
                self.assertEqual(self.emit(), 2)
                emitted = PRODUCER.document(self.path)
                self.assertEqual(emitted['status'], 'BLOCKED')
                self.assertEqual(emitted['case_qualification'], 'UNRUN')
                with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
                    CONSUMER.require_layout_receipt(self.root)
                self.path.unlink()

    def test_modified_tracked_file_outside_layout_root_is_reported_and_passes(self):
        outside = ['.cgignore', 'spec/layerx-merge/spec.kvx', 'neighbor\nπ.txt']
        for name in outside:
            path = self.host / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('original host content\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Track host bookkeeping and neighbor')
        bindings = PRODUCER.capture_bindings(self.root)
        for name in outside:
            (self.host / name).write_text('modified host content\n')
        for staged in [False, True]:
            with self.subTest(staged=staged):
                if staged:
                    self.git('add', '--', *outside)
                check = PRODUCER.check_final_revision_clean(bindings, self.root)
                self.assertEqual(check['status'], 'PASS')
                self.assertEqual(bindings['worktree_status_sha256'], hashlib.sha256(b'').hexdigest())
                self.assertEqual(bindings['outside_root_paths'], sorted(outside))
                self.assertEqual(bindings['outside_root_paths_count'], len(outside))
                self.report['bindings'].update(bindings)
                self.report['checks'] = [check]
                self.assertEqual(self.emit(), 0)
                emitted = CONSUMER.require_layout_receipt(self.root)
                self.assertEqual(emitted['bindings']['outside_root_paths'], sorted(outside))
                self.assertEqual(emitted['bindings']['outside_root_paths_count'], len(outside))
                self.path.unlink()

    def test_modified_tracked_file_under_layout_root_fails_with_outside_changes(self):
        outside = self.host / 'neighbor.txt'
        outside.write_text('original host source\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Track neighboring source')
        bindings = PRODUCER.capture_bindings(self.root)
        outside.write_text('modified host source\n')
        self.write('core/runtime.txt', 'modified project source\n')
        check = PRODUCER.check_final_revision_clean(bindings, self.root)
        self.assertEqual(check['id'], 'source.final-revision-clean')
        self.assertEqual(check['status'], 'FAIL')
        self.assertNotEqual(bindings['worktree_status_sha256'], hashlib.sha256(b'').hexdigest())
        self.assertEqual(bindings['outside_root_paths'], ['neighbor.txt'])
        self.assertEqual(bindings['outside_root_paths_count'], 1)
        self.report['bindings'].update(bindings)
        self.report['checks'] = [check]
        self.assertEqual(self.emit(), 2)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
            CONSUMER.require_layout_receipt(self.root)

    def test_missing_receipt_refused_before_contract_checks(self):
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
            CONSUMER.require_layout_receipt(self.root)
        for name in ['0_9', '0_10']:
            self.copy('tests/hyperfide/cases/source_control/' + name + '.py')
        result = subprocess.run([sys.executable, 'tests/hyperfide/cases/source_control/0_10.py'],
                                cwd=self.root, text=True, capture_output=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('LAYOUT_RECEIPT_REQUIRED', result.stderr)
        self.assertEqual(result.stdout, '')

    def test_stale_mapping_digest_is_refused(self):
        self.assertEqual(self.emit(), 0)
        self.mapping['qualification'] = 'changed mapping bytes'
        self.write('spec/hyperfide-source-control/repository-layout.json', self.mapping)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED.*mapping digest'):
            CONSUMER.require_layout_receipt(self.root)

    def test_stale_generation_is_refused_even_with_current_digest(self):
        self.report['bindings']['layout_generation'] += '-stale'
        self.assertEqual(self.emit(), 0)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED.*generation'):
            CONSUMER.require_layout_receipt(self.root)

    def test_schema_invalid_receipt_is_refused(self):
        self.assertEqual(self.emit(), 0)
        valid = PRODUCER.document(self.path)
        for field, value in [('checks', 'PASS'), ('schema_version', True),
                             ('checked_at', 'yesterday'), ('case_qualification', 'UNRUN')]:
            with self.subTest(field=field):
                invalid = {**valid, field: value}
                self.path.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
                    CONSUMER.require_layout_receipt(self.root)
        invalid = copy.deepcopy(valid)
        invalid['bindings']['source_snapshot']['core/runtime.txt']['sha256'] = 'invalid'
        self.path.write_text(json.dumps(invalid))
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
            CONSUMER.require_layout_receipt(self.root)

    def test_producer_schema_violation_becomes_regression(self):
        self.report['schema_version'] = True
        self.assertEqual(self.emit(), 1)
        result = PRODUCER.document(self.path)
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['case_qualification'], 'UNRUN')
        self.assertTrue(any('schema violation' in error for error in result['regressions']))

    def test_passing_emitted_receipt_survives_consumer_restart(self):
        self.assertEqual(self.emit(), 0)
        receipt = CONSUMER.require_layout_receipt(self.root)
        self.assertEqual(receipt['status'], 'PASS')
        self.assertEqual(receipt['case_qualification'], 'PASS')
        self.assertEqual(receipt['bindings']['mapping_sha256'], PRODUCER.digest(self.root / 'spec/hyperfide-source-control/repository-layout.json'))
        self.assertEqual(receipt['bindings']['layout_generation'], self.mapping['layout_generation'])
        for name in ['0_9', '0_10']:
            self.copy('tests/hyperfide/cases/source_control/' + name + '.py')
        code = "import importlib.util; from pathlib import Path; s=importlib.util.spec_from_file_location('consumer', 'tests/hyperfide/cases/source_control/0_10.py'); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(m.require_layout_receipt(Path.cwd())['status'])"
        for _ in range(2):
            result = subprocess.run([sys.executable, '-c', code], cwd=self.root, text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), 'PASS')

    def test_blocked_and_failed_receipts_are_refused(self):
        for field, value, expected in [('missing_evidence', [{'kind': 'runtime'}], 2),
                                       ('regressions', ['runtime regression'], 1)]:
            with self.subTest(field=field):
                self.report['missing_evidence'], self.report['regressions'] = [], []
                self.report[field] = value
                self.assertEqual(self.emit(), expected)
                with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
                    CONSUMER.require_layout_receipt(self.root)

    def test_invalid_json_duplicates_and_symlinks_are_refused(self):
        self.assertEqual(self.emit(), 0)
        valid = self.path.read_text()
        for content in ['{', valid.replace('"schema_version": 1,', '"schema_version": 1, "schema_version": 1,')]:
            self.path.write_text(content)
            with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
                CONSUMER.require_layout_receipt(self.root)
        saved = self.path.with_name('saved.json')
        saved.write_text(valid)
        self.path.unlink()
        self.path.symlink_to(saved)
        with self.assertRaisesRegex(ValueError, 'LAYOUT_RECEIPT_REQUIRED'):
            CONSUMER.require_layout_receipt(self.root)

    def pin(self):
        pin = {'schema_version': 1,
               'upstream_implementation_baseline': self.mapping['implementation_baseline'],
               'upstream_layout_revision': PRODUCER.LAYOUT_REVISION,
               'import_commit': self.revision, 'subtree_prefix': 'tools/hyperfide',
               'subtree_tree_id': self.git('rev-parse', self.revision + ':tools/hyperfide')}
        self.write('spec/hyperfide-source-control/layout-vendored-baseline.json', pin)
        return pin

    def test_vendored_history_resolves_real_import_tree_and_rejects_changed_pins(self):
        pin = self.pin()
        history = PRODUCER.resolve_history(self.mapping, PRODUCER.LAYOUT_REVISION, self.root)
        self.assertTrue(history['vendored'])
        self.assertEqual(history['baseline_revision'], self.revision)
        self.assertEqual(history['layout_revision'], self.revision)
        self.assertEqual(history['subtree_tree_id'], pin['subtree_tree_id'])
        self.assertEqual(PRODUCER.resolve_history(self.mapping, self.revision, self.root), history)
        self.git('commit', '--allow-empty', '-qm', 'Unpinned follow-on revision')
        with self.assertRaises(ValueError):
            PRODUCER.resolve_history(self.mapping, self.git('rev-parse', 'HEAD'), self.root)
        for key, value in [('subtree_tree_id', self.git('rev-parse', 'HEAD^{tree}')),
                           ('upstream_layout_revision', self.revision), ('subtree_prefix', '../outside')]:
            with self.subTest(key=key):
                self.write('spec/hyperfide-source-control/layout-vendored-baseline.json', {**pin, key: value})
                with self.assertRaises(ValueError):
                    PRODUCER.resolve_history(self.mapping, PRODUCER.LAYOUT_REVISION, self.root)

    def test_available_upstream_history_does_not_require_vendored_pin(self):
        mapping = {**self.mapping, 'implementation_baseline': self.revision}
        history = PRODUCER.resolve_history(mapping, self.revision, self.root)
        self.assertFalse(history['vendored'])
        self.assertEqual(history['layout_revision'], self.revision)

    def test_import_recapture_uses_pinned_inventory_and_records_unavailable_history(self):
        pin = self.pin()
        history = PRODUCER.resolve_history(self.mapping, PRODUCER.LAYOUT_REVISION, self.root)
        PRODUCER.recreate_vendored_baseline(history, self.root)
        path = self.root / 'build/layout/0.3/import-recapture.json'
        record = PRODUCER.document(path)
        self.assertEqual(record['exit_code'], 0)
        self.assertEqual(record['command'], ['git', 'archive', pin['subtree_tree_id']])
        self.assertEqual(record['revision'], self.revision)
        self.assertEqual(record['source_tree_id'], pin['subtree_tree_id'])
        log = self.root / record['log']
        self.assertEqual(record['log_sha256'], PRODUCER.digest(log))
        self.assertEqual(record['producer_sha256'], PRODUCER.digest(self.root / 'tools/repository/layout-inventory.py'))
        result = PRODUCER.document(self.root / 'build/layout/0.3/receipt.json')
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['case_qualification'], 'UNRUN')
        self.assertEqual(result['revision'], self.revision)
        self.assertEqual(result['source_tree_id'], pin['subtree_tree_id'])
        self.assertEqual(result['vendored_baseline'], history)
        self.assertEqual(result['mapping_sha256'], PRODUCER.digest(self.root / 'spec/hyperfide-source-control/repository-layout.json'))
        self.assertEqual(result['historical_verification'], {
            'status': 'UNAVAILABLE', 'code': 'HISTORICAL_FILE_MISSING',
            'archive': 'build/layout/0.3-preserved-original/manifest.json'})
        self.assertTrue(result['assertions'])
        self.assertTrue(all(value is True for value in result['assertions'].values()))
        inventory_path = self.root / result['inventory']
        inventory = PRODUCER.document(inventory_path)
        self.assertEqual(result['inventory_sha256'], PRODUCER.digest(inventory_path))
        self.assertEqual(record['inventory_sha256'], result['inventory_sha256'])
        self.assertEqual(record['receipt_sha256'], PRODUCER.digest(self.root / 'build/layout/0.3/receipt.json'))
        self.assertEqual(inventory['revision'], self.revision)
        self.assertEqual(inventory['source_tree_id'], pin['subtree_tree_id'])
        self.assertTrue(inventory['valid'])
        self.assertEqual(inventory['worktree_drift'], [])
        self.assertIn('core/runtime.txt', {item['source'] for item in inventory['files']})
        self.assertFalse((self.root / 'build/layout/0.3/imported-historical-verification').exists())
        before = path.stat().st_mtime_ns
        PRODUCER.recreate_vendored_baseline(history, self.root)
        self.assertEqual(path.stat().st_mtime_ns, before)
        inventory_path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'inventory missing or changed'):
            PRODUCER.recreate_vendored_baseline(history, self.root)
        self.assertEqual(path.stat().st_mtime_ns, before)

    def test_inventory_and_followon_changes_are_confined_to_real_subtree(self):
        (self.host / 'neighbor.txt').write_text('outside project\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Host change')
        revision = self.git('rev-parse', 'HEAD')
        inventory, _ = PRODUCER.project_inventory(self.root, self.mapping, revision)
        names = {item['source'] for item in inventory['files']}
        self.assertIn('core/runtime.txt', names)
        self.assertNotIn('neighbor.txt', names)
        self.assertTrue(all(not name.startswith('tools/hyperfide/') for name in names))
        self.assertEqual(inventory['source_tree_id'], self.git('rev-parse', 'HEAD:tools/hyperfide'))
        self.assertEqual(PRODUCER.project_changes(revision, ['tools/hyperfide'], self.root), [])
        self.write('core/runtime.txt', 'updated source\n')
        (self.host / 'neighbor.txt').write_text('another host change\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Project and host change')
        changes = PRODUCER.project_changes(self.git('rev-parse', 'HEAD'), ['tools/hyperfide'], self.root)
        self.assertEqual([item['path'] for item in changes], ['core/runtime.txt'])
        self.assertEqual(changes[0]['after_blob'], self.git('rev-parse', 'HEAD:tools/hyperfide/core/runtime.txt'))

    def commit_aggregation_input(self):
        self.write('core/runtime.txt', 'authorized follow-on source\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'Landed mapped follow-on change')
        landed = self.git('rev-parse', 'HEAD')
        path = self.write('spec/hyperfide-source-control/layout-aggregation-input.json', {
            'schema_version': 1, 'layout_revision': self.revision,
            'authorized_followon_revisions': [landed], 'task_receipts': {}})
        self.git('add', '.')
        self.git('commit', '-qm', 'Carry aggregation authorization input')
        return path, landed, self.git('rev-parse', 'HEAD')

    def test_input_commit_is_self_authorized_and_outside_revision_is_a_regression(self):
        path, landed, carrier = self.commit_aggregation_input()
        followon = PRODUCER.check_followon_authorization(
            PRODUCER.document(path), path, self.revision, carrier,
            ['tools/hyperfide'], self.report, self.root)
        self.assertEqual([item['revision'] for item in followon], [landed, carrier])
        self.assertTrue(all(item['authorized'] for item in followon))
        self.assertEqual(self.report['missing_evidence'], [])
        self.assertEqual(self.report['regressions'], [])
        self.assertEqual(self.report['self_authorized_revision'], carrier)
        self.assertEqual(self.report['aggregation_input'], {
            'path': 'spec/hyperfide-source-control/layout-aggregation-input.json',
            'sha256': PRODUCER.digest(path)})
        self.assertEqual(self.emit(), 0)
        receipt = PRODUCER.document(self.path)
        PRODUCER.validate_layout_receipt(receipt)
        self.assertEqual(receipt['self_authorized_revision'], carrier)
        self.assertEqual(receipt['aggregation_input']['sha256'], PRODUCER.digest(path))

        outside = self.git('commit-tree', self.revision + '^{tree}', '-m', 'Unrelated ancestry')
        inputs = PRODUCER.document(path)
        inputs['authorized_followon_revisions'].extend([carrier, outside])
        self.write(str(path.relative_to(self.root)), inputs)
        self.git('add', str(path.relative_to(self.host)))
        self.git('commit', '-qm', 'Record invalid outside authorization for rejection')
        PRODUCER.check_followon_authorization(
            PRODUCER.document(path), path, self.revision, self.git('rev-parse', 'HEAD'),
            ['tools/hyperfide'], self.report, self.root)
        self.assertEqual(self.report['missing_evidence'], [])
        self.assertEqual(self.report['regressions'], [
            'Follow-on authorization contains a revision outside the actual layout-to-candidate ancestry'])

    def test_later_mapped_changes_without_input_update_remain_missing(self):
        path, landed, carrier = self.commit_aggregation_input()
        later = []
        for content in ['unlisted mapped source\n', 'another unlisted mapped change\n']:
            self.write('core/runtime.txt', content)
            self.git('add', '.')
            self.git('commit', '-qm', 'Change mapped source without authorization input')
            later.append(self.git('rev-parse', 'HEAD'))
        followon = PRODUCER.check_followon_authorization(
            PRODUCER.document(path), path, self.revision, later[-1],
            ['tools/hyperfide'], self.report, self.root)
        self.assertEqual([item['revision'] for item in followon], [landed, carrier, *later])
        self.assertEqual([item['authorized'] for item in followon], [True, True, False, False])
        self.assertEqual(self.report['self_authorized_revision'], carrier)
        self.assertEqual(self.report['aggregation_input']['sha256'], PRODUCER.digest(path))
        self.assertEqual(self.report['regressions'], [])
        self.assertEqual(self.report['missing_evidence'], [
            {'kind': 'follow-on-authorization', 'revision': revision, 'changed_paths': 1}
            for revision in later])
        for item in followon[2:]:
            self.assertEqual([change['path'] for change in item['changes']], ['core/runtime.txt'])
            self.assertEqual(item['changes'][0]['after_blob'], self.git(
                'rev-parse', item['revision'] + ':tools/hyperfide/core/runtime.txt'))
        self.assertEqual(self.emit(), 2)
        receipt = PRODUCER.document(self.path)
        PRODUCER.validate_layout_receipt(receipt)
        self.assertEqual(receipt['missing_evidence'], self.report['missing_evidence'])

    def pending_receipt(self):
        result = self.emit()
        report = PRODUCER.document(self.path)
        summary = {'task': '0.9', 'status': report['status'], 'checks': len(report['checks']),
                   'missing_evidence': len(report['missing_evidence']),
                   'missing_evidence_kinds': [item['kind'] for item in report['missing_evidence']],
                   'regressions': len(report['regressions']), 'receipt': 'build/layout/0.9/receipt.json'}
        PRODUCER.validate_layout_receipt(report)
        return summary, report, result

    def test_pending_aggregation_accepts_only_missing_driver_receipts(self):
        self.report['missing_evidence'] = [{'kind': 'task-runtime-receipt', 'task': task}
                                           for task in PRODUCER.REQUIRED]
        self.report['task_receipts'] = {}
        summary, report, result = self.pending_receipt()
        self.assertEqual(result, 2)
        self.assertEqual(report['case_qualification'], 'UNRUN')
        PENDING.validate_pending_aggregation(summary, report, result)
        self.report['missing_evidence'] = []
        self.report['task_receipts'] = {task: {} for task in PRODUCER.REQUIRED}
        summary, report, result = self.pending_receipt()
        self.assertEqual(result, 0)
        PENDING.validate_pending_aggregation(summary, report, result)

    def test_pending_aggregation_names_first_unexpected_missing_evidence(self):
        expected = {'kind': 'task-runtime-receipt', 'task': '0.4'}
        for item in [{'kind': 'aggregation-input'}, {'kind': 'follow-on-authorization'},
                     {'kind': 'driver-input'}, {'kind': 'invalid-task-runtime-receipt', 'task': '0.4'},
                     {'kind': 'task-runtime-receipt', 'task': '0.9'}, {'kind': 'task-runtime-receipt'}]:
            with self.subTest(item=item):
                self.report['missing_evidence'] = [expected, item]
                summary, report, result = self.pending_receipt()
                with self.assertRaises(ValueError) as error:
                    PENDING.validate_pending_aggregation(summary, report, result)
                self.assertEqual(str(error.exception), 'Unexpected missing evidence: ' + json.dumps(item, sort_keys=True))
        self.report['checks'][0]['status'] = 'FAIL'
        self.report['missing_evidence'] = [expected, {'kind': 'follow-on-authorization', 'revision': self.revision}]
        with self.assertRaisesRegex(ValueError, 'Unexpected missing evidence: .*follow-on-authorization'):
            PENDING.validate_pending_aggregation(*self.pending_receipt())

    def test_pending_aggregation_rejects_failed_checks_regressions_and_inconsistent_output(self):
        self.report['regressions'] = ['recorded regression']
        with self.assertRaisesRegex(ValueError, 'Layout regression: recorded regression'):
            PENDING.validate_pending_aggregation(*self.pending_receipt())
        self.report['regressions'] = []
        self.report['checks'][0]['status'] = 'FAIL'
        with self.assertRaisesRegex(ValueError, 'Layout check failed: fixture.source-binding'):
            PENDING.validate_pending_aggregation(*self.pending_receipt())
        self.report['checks'] = []
        self.report['missing_evidence'] = [{'kind': 'task-runtime-receipt', 'task': '0.4'}]
        with self.assertRaisesRegex(ValueError, 'No layout checks'):
            PENDING.validate_pending_aggregation(*self.pending_receipt())
        self.report['checks'] = [{'id': 'fixture.source-binding', 'status': 'PASS', 'evidence': {}}]
        summary, report, result = self.pending_receipt()
        with self.assertRaisesRegex(ValueError, 'summary differs'):
            PENDING.validate_pending_aggregation({**summary, 'missing_evidence': 0}, report, result)
        with self.assertRaisesRegex(ValueError, 'process exit differs'):
            PENDING.validate_pending_aggregation(summary, report, 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
