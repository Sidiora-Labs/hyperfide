#!/usr/bin/env python3
"""Pure refusal tests for growth matrix constraints, not product qualification."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scale', Path(__file__).with_name('scale.py'))
scale = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scale)


class GrowthMatrixTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        config = Path(self.directory.name) / 'private.json'
        config.write_text(json.dumps({'budgets': {'max_growth_ratio': 2}}))
        config.chmod(0o600)
        self.runs = []
        for name in ['baseline', 'unique-content', 'directory-fanout', 'history-depth', 'source-tier']:
            dimensions = {'unique_file_descriptors': 1, 'directory_fanout': 10, 'history_depth': 1}
            if name == 'unique-content': dimensions['unique_file_descriptors'] = 1000
            if name == 'directory-fanout': dimensions['directory_fanout'] = 256
            if name == 'history-depth': dimensions['history_depth'] = 1000
            results = [{'logical_files': count, 'content_condition': {'profile': 'cold-unique-edit-objects'}, 'measurements': {'checkpoint_rpc_ms': {'p95': 10}, 'completed_operations': 100}, 'server_before': {'value': {'storage_requests': 0, 'storage_bytes': 0, 'storage_offered_write_bytes': 0}}, 'server_after': {'value': {'storage_requests': 1000, 'storage_bytes': 100000, 'storage_offered_write_bytes': 100000}}} for count in [10000, 1000000, 10000000]]
            self.runs.append({'id': name, 'inputs': {'config': {'path': str(config)}}, 'receipt': {'manifest': {'modified_files': 10, 'modified_bytes': 1048576}, 'source_scope': {'repository_id': 'fixture'}, 'endpoint': 'https://example.invalid', 'results': results}, 'preparation': {'corpora': [dict(dimensions) for _ in range(3)]}, 'measurement_windows': [{'start_ms': 1000, 'end_ms': 2000}], 'topology': {'source': {'service_id': 'two' if name == 'source-tier' else 'one', 'replicas': 2 if name == 'source-tier' else 1, 'cpu': 2}, 'metadata': {'identity': 'unchanged'}, 'objects': {'identity': 'unchanged'}, 'source_profiles': [{'service_id': service, 'replicas': replicas, 'request_count_before': 0, 'request_count_after': 10 if service == ('two' if name == 'source-tier' else 'one') else 0, 'observed_from_ms': 500, 'observed_through_ms': 2500} for service, replicas in [('one', 1), ('two', 2)]]}})

    def tearDown(self):
        self.directory.cleanup()

    def test_complete_matrix_and_single_axis_refusals(self):
        scale.validate_growth(self.runs)
        changed = copy.deepcopy(self.runs)
        changed[1]['preparation']['corpora'][0]['history_depth'] = 1000
        with self.assertRaisesRegex(ValueError, 'Axes must remain constant'):
            scale.validate_growth(changed)
        with self.assertRaisesRegex(ValueError, 'Complete ordered growth matrix'):
            scale.validate_growth(self.runs[:-1])

    def test_tier_change_must_preserve_other_resources(self):
        changed = copy.deepcopy(self.runs)
        changed[-1]['topology']['metadata']['identity'] = 'resized'
        with self.assertRaisesRegex(ValueError, 'changed storage or metadata'):
            scale.validate_growth(changed)
        changed = copy.deepcopy(self.runs)
        changed[-1]['topology']['source']['replicas'] = 1
        with self.assertRaisesRegex(ValueError, 'Active source profile|independently scaled source replicas'):
            scale.validate_growth(changed)

    def test_cold_state_and_measured_work_budgets_are_required(self):
        changed = copy.deepcopy(self.runs)
        changed[0]['receipt']['results'][2]['server_after']['value']['storage_requests'] = 100000
        with self.assertRaisesRegex(ValueError, 'growth budget exceeded'):
            scale.validate_growth(changed)
        changed = copy.deepcopy(self.runs)
        changed[0]['receipt']['results'][2]['content_condition']['profile'] = 'warm'
        with self.assertRaisesRegex(ValueError, 'cold edit objects'):
            scale.validate_growth(changed)


if __name__ == '__main__':
    unittest.main()
