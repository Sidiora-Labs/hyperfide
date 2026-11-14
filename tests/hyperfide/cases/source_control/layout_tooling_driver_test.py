#!/usr/bin/env python3
"""Exercise the real layout drivers in standalone and vendored Git fixtures."""
from pathlib import Path
import hashlib
import importlib.util
import json
import subprocess
import tempfile
import unittest


def load_driver(name):
    spec = importlib.util.spec_from_file_location('layout_driver_' + name, Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOLING = load_driver('0_8')
BINDINGS = load_driver('0_9')


class LayoutToolingDriverTest(unittest.TestCase):
    def git(self, root, *args):
        return subprocess.check_output(['git', '-c', 'user.name=Layout Fixture', '-c', 'user.email=layout@example.invalid',
                                        '-c', 'commit.gpgsign=false', *args], cwd=root, text=True).strip()

    def write(self, root, name, text):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def project(self, root):
        root.mkdir(parents=True, exist_ok=True)
        self.write(root, 'spec/hyperfide-source-control/repository-layout.json',
                   json.dumps({'layout_generation': 'category-layout-v1'}))
        self.write(root, 'core/control-plane/src/control.ts', 'export const current = true;\n')

    def manifest(self, root, entries):
        return self.write(root, 'spec/hyperfide-source-control/layout-reference-exceptions.json',
                          json.dumps({'schema_version': 1, 'exceptions': entries}))

    def historical(self, root):
        text = 'Historical revision `a2a367f9`\nservices/hyperfide/src/control.ts\n'
        self.write(root, 'docs/reference/services-runtime.md', text + '\nCurrent services/live/control.ts\n')
        entry = {'file': 'docs/reference/services-runtime.md', 'line_range': [1, 2], 'revision': 'a2a367f9',
                 'classification': 'revision-bound-source-reference', 'reason': 'Retained source index at a2a367f9.',
                 'section_sha256': hashlib.sha256(text.encode()).hexdigest()}
        self.manifest(root, [entry])
        return entry

    def test_source_references_classifies_exact_historical_installed_and_live_paths(self):
        with tempfile.TemporaryDirectory(prefix='layout-references-') as temporary:
            root = Path(temporary)
            self.git(root, 'init', '-q')
            self.historical(root)
            self.write(root, 'deploy/start.sh', 'node services/dist/control.js\n')
            self.write(root, 'tools/live.sh', 'node platform/apps/server/index.js\n')
            self.git(root, 'add', '.')
            rows = TOOLING.source_references(root)
            actual = {(row['consumer'], row['line']): row for row in rows}
            historical = actual[('docs/reference/services-runtime.md', 2)]
            self.assertEqual(historical['classification'], 'revision-bound-source-reference')
            self.assertEqual(historical['reason'], 'Retained source index at a2a367f9.')
            self.assertEqual(actual[('deploy/start.sh', 1)]['classification'], 'installed-artifact')
            self.assertEqual(actual[('tools/live.sh', 1)]['classification'], 'unresolved-current-reference')
            self.assertEqual(actual[('docs/reference/services-runtime.md', 4)]['classification'], 'unresolved-current-reference')
            self.assertEqual(len(rows), 4)
            self.assertFalse((root / 'build').exists())

    def test_changed_historical_section_is_not_exempted(self):
        with tempfile.TemporaryDirectory(prefix='layout-reference-change-') as temporary:
            root = Path(temporary)
            self.git(root, 'init', '-q')
            self.historical(root)
            path = root / 'docs/reference/services-runtime.md'
            path.write_text(path.read_text().replace('src/control.ts', 'src/new-live.ts'))
            rows = TOOLING.source_references(root)
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(row['classification'] == 'unresolved-current-reference' for row in rows))

    def test_manifest_is_required_and_rejects_invalid_or_overlapping_exceptions(self):
        with tempfile.TemporaryDirectory(prefix='layout-reference-manifest-') as temporary:
            root = Path(temporary)
            self.git(root, 'init', '-q')
            with self.assertRaises(FileNotFoundError):
                TOOLING.source_references(root)
            entry = self.historical(root)
            for changes in [{'revision': 'HEAD'}, {'line_range': [2, 1]}, {'file': 'docs/../tools/live.sh'},
                            {'reason': ''}, {'section_sha256': 'unbound'}, {'classification': 'installed-artifact'}]:
                with self.subTest(changes=changes):
                    self.manifest(root, [{**entry, **changes}])
                    with self.assertRaises(ValueError):
                        TOOLING.source_references(root)
            self.manifest(root, [entry, entry])
            with self.assertRaisesRegex(ValueError, 'Overlapping'):
                TOOLING.source_references(root)

    def test_measurement_exception_only_covers_its_exact_reference(self):
        with tempfile.TemporaryDirectory(prefix='layout-measurement-') as temporary:
            root = Path(temporary)
            self.git(root, 'init', '-q')
            text = 'Measured platform/apps/server/ against services/live/current.ts\n'
            self.write(root, 'docs/operations.md', text)
            self.manifest(root, [{'file': 'docs/operations.md', 'line_range': [1, 1], 'revision': 'a2a367f9',
                'classification': 'historical-measurement-reference', 'reason': 'Original measurement input.',
                'section_sha256': hashlib.sha256(text.encode()).hexdigest(), 'reference': 'platform/apps/server/'}])
            rows = TOOLING.source_references(root)
            self.assertEqual([(row['reference'], row['classification']) for row in rows], [
                ('platform/apps/server/', 'historical-measurement-reference'),
                ('services/live/current.ts', 'unresolved-current-reference')])

    def test_capture_bindings_uses_vendored_subtree_and_separate_host_commit(self):
        with tempfile.TemporaryDirectory(prefix='layout-subtree-') as temporary:
            host = Path(temporary)
            root = host / 'tools/hyperfide'
            self.git(host, 'init', '-q')
            self.project(root)
            self.write(host, 'host.txt', 'host source\n')
            self.write(host, 'tools/neighbor/private.txt', 'outside project\n')
            self.git(host, 'add', '.')
            self.git(host, 'commit', '-qm', 'Initial fixture')
            initial = BINDINGS.capture_bindings(root)
            self.assertEqual(initial['source_tree_id'], self.git(host, 'rev-parse', 'HEAD:tools/hyperfide'))
            self.assertNotEqual(initial['source_tree_id'], self.git(host, 'rev-parse', 'HEAD^{tree}'))
            self.assertEqual(initial['host_commit'], self.git(host, 'rev-parse', 'HEAD'))
            self.assertEqual(initial['source_revision'], initial['host_commit'])
            self.assertEqual(initial['source_prefix'], 'tools/hyperfide/')
            self.assertEqual(set(initial['source_snapshot']), {'core/control-plane/src/control.ts'})
            self.write(host, 'host.txt', 'changed host source\n')
            self.git(host, 'add', 'host.txt')
            self.git(host, 'commit', '-qm', 'Change only the host')
            changed_host = BINDINGS.capture_bindings(root)
            self.assertNotEqual(changed_host['host_commit'], initial['host_commit'])
            self.assertEqual(changed_host['source_tree_id'], initial['source_tree_id'])
            self.assertEqual(changed_host['source_snapshot_sha256'], initial['source_snapshot_sha256'])
            self.write(root, 'core/control-plane/src/control.ts', 'export const current = false;\n')
            self.write(root, 'tools/untracked.py', 'print("new input")\n')
            dirty = BINDINGS.capture_bindings(root)
            self.assertNotEqual(dirty['source_snapshot_sha256'], initial['source_snapshot_sha256'])
            self.assertIn('tools/untracked.py', dirty['source_snapshot'])
            self.git(host, 'add', 'tools/hyperfide')
            self.git(host, 'commit', '-qm', 'Change project source')
            changed_project = BINDINGS.capture_bindings(root)
            self.assertNotEqual(changed_project['source_tree_id'], initial['source_tree_id'])
            self.assertEqual(changed_project['source_snapshot_sha256'], dirty['source_snapshot_sha256'])
            self.assertEqual(BINDINGS.source_tree_id(initial['host_commit'], root), initial['source_tree_id'])

    def test_capture_bindings_supports_a_standalone_checkout(self):
        with tempfile.TemporaryDirectory(prefix='layout-standalone-') as temporary:
            root = Path(temporary)
            self.git(root, 'init', '-q')
            self.project(root)
            self.git(root, 'add', '.')
            self.git(root, 'commit', '-qm', 'Standalone fixture')
            bindings = BINDINGS.capture_bindings(root)
            self.assertEqual(bindings['source_prefix'], '')
            self.assertEqual(bindings['source_tree_id'], self.git(root, 'rev-parse', 'HEAD^{tree}'))
            self.assertEqual(bindings['host_commit'], self.git(root, 'rev-parse', 'HEAD'))


if __name__ == '__main__':
    unittest.main(verbosity=2)
