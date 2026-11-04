#!/usr/bin/env python3
"""Pure refusal tests for growth matrix constraints, not product qualification."""
import copy
import base64
import hashlib
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

    def service_matrix(self):
        root = Path(self.directory.name)
        scope = self.runs[0]['receipt']['source_scope']

        def evidence(name, value):
            path = root / (name + '.json')
            path.write_text(json.dumps(value))
            return scale.pin(path)

        def provider(member):
            return evidence('provider-' + member['service_id'], {'data': {'deployment': {'id': member['deployment_id'], 'serviceId': member['service_id'], 'status': 'SUCCESS', 'meta': {'imageDigest': member['image_digest'], 'serviceManifest': {'deploy': {'numReplicas': 1, 'multiRegionConfig': {member['region']: {'numReplicas': 1}}, 'limitOverride': {'containers': {'cpu': member['cpu'], 'memoryBytes': member['memory_bytes']}}}}}}}})

        profiles = []
        for count in [1, 2]:
            members = []
            for number in range(count):
                ident = str(count) + '-' + str(number)
                members.append({'service_id': 'service-' + ident, 'deployment_id': 'deployment-' + ident, 'volume_id': 'volume-' + ident, 'origin': 'https://backend-' + ident + '.invalid', 'replicas': 1, 'cpu': 2, 'memory_bytes': 4000000000, 'region': 'region', 'image_digest': 'sha256:' + 'a' * 64, 'journal_identity': {'volume_id': 'volume-' + ident, 'path': '/app/state/authority-journal/authority.authority.json'},
                                'startup_readback': evidence('startup-' + ident, {'schema_version': 1, 'machine_id_origin': 'railway-replica-id', 'provider_replica_id': 'replica-' + ident, 'volume': {'mounted': True, 'path': '/app/state', 'mode': '0700'}}),
                                'journal_readback': evidence('journal-' + ident, {'schema_version': 1, 'deployment_id': 'authority', 'document_digest': 'document', 'epoch': '1', 'head_digest': 'head', 'history': [{'epoch': '1'}], 'pending': None, 'state': 'ACTIVE'})})
                members[-1]['provider_readback'] = provider(members[-1])
                members[-1]['volume_readback'] = evidence('volume-' + ident, {'data': {'environment': {'volumeInstances': {'edges': [{'node': {'volumeId': members[-1]['volume_id'], 'serviceId': members[-1]['service_id'], 'mountPath': '/app/state'}}]}}}})
                members[-1]['activation_readback'] = evidence('activation-' + ident, {'schema_version': 1, 'generation': 'g-' + ident, 'authority_adoption': {'deployment_id': 'authority', 'document_file': 'authority-journal.json'}, 'files': {'authority-journal.json': base64.b64encode(Path(members[-1]['journal_readback']['path']).read_bytes()).decode()}})
                members[-1]['launch_readback'] = evidence('state-launch-' + ident, {'processes': [{'argv': ['/app/native/runtime/node', '/app/core/control-plane/dist/control.js'], 'environment': {'RAILWAY_SERVICE_ID': members[-1]['service_id'], 'RAILWAY_DEPLOYMENT_ID': members[-1]['deployment_id'], 'HYPERFIDE_DEPLOYMENT_ID': 'authority', 'HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256': 'sha256:' + members[-1]['activation_readback']['sha256']}}]})
            proxy = {'service_id': 'proxy-' + str(count), 'deployment_id': 'proxy-deploy-' + str(count), 'origin': 'https://proxy-' + str(count) + '.invalid', 'replicas': 1, 'cpu': 1, 'memory_bytes': 1000000000, 'region': 'region', 'image_digest': 'sha256:' + 'b' * 64}
            proxy['provider_readback'] = provider(proxy)
            proxy['routing_script_digest'] = 'sha256:' + 'd' * 64
            proxy['routing_readback'] = evidence('routing-' + str(count), {'sampled_at': '1970-01-01T00:00:00.000Z', 'processes': [{'pid': '1', 'command': ['node', '/app/proxy.mjs'], 'service_id': proxy['service_id'], 'deployment_id': proxy['deployment_id'], 'backends': [member['origin'] for member in members], 'proxy_digest': proxy['routing_script_digest']}]})
            profiles.append({'deployment_mode': 'independent-services', 'proxy': proxy, 'backends': members})
        for run in self.runs:
            observed = copy.deepcopy(profiles)
            for profile in observed:
                active = len(profile['backends']) == (2 if run['id'] == 'source-tier' else 1)
                for member in profile['backends']:
                    member.update(request_count_before=0, request_count_after=10 if active else 0, observed_from_ms=500, observed_through_ms=2500)
                    member['request_counter_evidence'] = {}
                    for phase, requests, sampled in [('before', 0, '1970-01-01T00:00:00.500Z'), ('after', 10 if active else 0, '1970-01-01T00:00:02.500Z')]:
                        raw = {'schema_version': 1, 'scope': scope, 'service_id': member['service_id'], 'deployment_id': member['deployment_id'], 'boot_id': member['service_id'] + '-boot', 'sampled_at': sampled, 'state': 'RUNNING', 'coverage': 'COMPLETE', 'listeners': ['IPv4:127.0.0.1:9443'], 'requests': requests}
                        member['request_counter_evidence'][phase] = evidence(run['id'] + member['service_id'] + phase, raw)
                profile.update(request_count_before=0, request_count_after=sum(member['request_count_after'] for member in profile['backends']), observed_from_ms=500, observed_through_ms=2500)
            run['topology']['source_profiles'] = observed
            run['topology']['source'] = scale.source_identity(observed[1 if run['id'] == 'source-tier' else 0])
            run['receipt']['endpoint'] = run['topology']['source']['proxy']['origin']

    def runtime_matrix(self):
        self.service_matrix()
        root = Path(self.directory.name)

        def evidence(name, value):
            path = root / (name + '.json')
            path.write_text(json.dumps(value))
            return scale.pin(path)

        def digest(rows, packages):
            return 'sha256:' + hashlib.sha256(json.dumps({'rows': rows, 'packages': packages}, separators=(',', ':')).encode()).hexdigest()

        report = {'schema_version': 1, 'roots': ['/app (excluding /app/state)', '/opt', '/usr', '/etc'], 'allowed_instance_files': ['/etc/hostname', '/etc/hosts', '/etc/machine-id'], 'sources': [], 'proxies': []}
        updated = {}
        for profile in self.runs[0]['topology']['source_profiles']:
            for category, members in [('sources', profile['backends']), ('proxies', [profile['proxy']])]:
                for member in members:
                    service = member['service_id']
                    image = 'sha256:' + hashlib.sha256(service.encode()).hexdigest()
                    provider = json.loads(Path(member['provider_readback']['path']).read_text())
                    provider['data']['deployment']['meta']['imageDigest'] = image
                    provider_ref = evidence('provider-' + service, provider)
                    executable = '/app/native/runtime/node' if category == 'sources' else '/usr/local/bin/node'
                    rows = [[executable, 493, 1, '1' * 64], ['/etc/hostname', 420, 1, hashlib.sha256(service.encode()).hexdigest()], ['/usr/bin/node', 'link', executable]]
                    if category == 'sources':
                        rows.extend([['/app/deploy/hyperfide/fleet-control/start.mjs', 420, 1, '2' * 64], ['/app/core/control-plane/dist/control.js', 420, 1, '3' * 64]])
                        identity_ref = evidence('identity-' + service, {'schema_version': 1, 'origin': profile['proxy']['origin'], 'principals': ['same-principal']})
                        generation = 'g-' + service
                        config_files = {'control-identity.json': Path(identity_ref['path']).read_bytes(), 'control-policy.json': b'policy', 'source-authorization.json': b'authorization', 'tls-ca.crt': b'tls', 'database-ca.crt': b'database', 'authority-journal.json': Path(member['journal_readback']['path']).read_bytes()}
                        activation_ref = evidence('runtime-activation-' + service, {'schema_version': 1, 'generation': generation, 'authority_adoption': {'deployment_id': 'authority', 'document_file': 'authority-journal.json'}, 'files': {name: base64.b64encode(value).decode() for name, value in config_files.items()}})
                        launch = {'service_id': service, 'deployment_id': member['deployment_id'], 'processes': [{'pid': str(index), 'argv': [executable, entry, '--policy', '/app/state/bootstrap/' + generation + '/control-policy.json'], 'executable': executable, 'executable_digest': 'sha256:' + '1' * 64, 'cwd': '/app', 'environment': {'RAILWAY_SERVICE_ID': service, 'RAILWAY_DEPLOYMENT_ID': member['deployment_id'], 'HYPERFIDE_DEPLOYMENT_ID': 'authority'}} for index, entry in enumerate(['/app/deploy/hyperfide/fleet-control/start.mjs', '/app/core/control-plane/dist/control.js'])], 'configs': [{'generation': generation, 'origin': profile['proxy']['origin'], 'identity_digest': 'sha256:' + identity_ref['sha256'], 'identity_keys': ['schema_version', 'origin', 'principals'], 'policy_digest': 'policy', 'authorization_digest': 'authorization', 'tls_ca_digest': 'tls', 'database_ca_digest': 'database'}]}
                        for process in launch['processes']:
                            process['environment']['HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256'] = 'sha256:' + activation_ref['sha256']
                        for field, filename in [('policy_digest', 'control-policy.json'), ('authorization_digest', 'source-authorization.json'), ('tls_ca_digest', 'tls-ca.crt'), ('database_ca_digest', 'database-ca.crt')]:
                            launch['configs'][0][field] = 'sha256:' + hashlib.sha256(config_files[filename]).hexdigest()
                    else:
                        rows.append(['/app/proxy.mjs', 420, 1, 'd' * 64])
                        launch = json.loads(Path(member['routing_readback']['path']).read_text())
                        launch['processes'][0].update(executable=executable, executable_digest='sha256:' + '1' * 64, cwd='/app')
                    packages = 'node\t24.22.0\n'
                    raw = {'schema_version': 1, 'rows': rows, 'packages': packages, 'digest': digest(rows, packages)}
                    manifest_ref = evidence('runtime-' + service, raw)
                    launch_ref = evidence('launch-' + service, launch)
                    entry = {'service_id': service, 'oci_image_digest': image, 'raw_runtime_manifest': manifest_ref['path'], 'raw_runtime_manifest_sha256': manifest_ref['sha256'], 'normalized_runtime_digest': digest([row for row in rows if row[0] != '/etc/hostname'], packages), 'row_count': len(rows), 'instance_file_rows': [row for row in rows if row[0] == '/etc/hostname'], 'launch_readback': launch_ref['path'], 'launch_readback_sha256': launch_ref['sha256']}
                    if category == 'sources':
                        entry['identity_readback'] = identity_ref
                    report[category].append(entry)
                    updated[service] = {'image_digest': image, 'provider_readback': provider_ref}
                    if category == 'proxies':
                        updated[service]['routing_readback'] = launch_ref
                    else:
                        updated[service]['launch_readback'] = launch_ref
                        updated[service]['activation_readback'] = activation_ref
        report_ref = evidence('runtime-equivalence', report)
        for run in self.runs:
            for profile in run['topology']['source_profiles']:
                for member in profile['backends'] + [profile['proxy']]:
                    member.update(updated[member['service_id']])
            run['topology']['runtime_equivalence'] = report_ref
            active = run['topology']['source_profiles'][1 if run['id'] == 'source-tier' else 0]
            run['topology']['source'] = scale.source_identity(active)
        return report

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

    def test_independent_service_topology_preserves_one_vs_two_backends(self):
        self.service_matrix()
        scale.validate_growth(self.runs)
        for field in ['service_id', 'deployment_id', 'volume_id']:
            changed = copy.deepcopy(self.runs)
            profiles = changed[0]['topology']['source_profiles']
            profiles[1]['backends'][0][field] = profiles[0]['backends'][0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, 'Independent backend identities'):
                scale.validate_growth(changed)

    def test_service_profiles_refuse_resource_and_replica_invention(self):
        for field, value, error in [('cpu', 4, 'resources or image'), ('image_digest', 'sha256:' + 'c' * 64, 'resources or image'), ('replicas', 2, 'replica count')]:
            self.service_matrix()
            changed = copy.deepcopy(self.runs)
            member = changed[0]['topology']['source_profiles'][1]['backends'][0]
            member[field] = value
            path = Path(member['provider_readback']['path'])
            raw = json.loads(path.read_text())
            deployment = raw['data']['deployment']
            if field == 'cpu':
                deployment['meta']['serviceManifest']['deploy']['limitOverride']['containers']['cpu'] = value
            elif field == 'image_digest':
                deployment['meta']['imageDigest'] = value
            else:
                deployment['meta']['serviceManifest']['deploy']['numReplicas'] = value
            path.write_text(json.dumps(raw))
            member['provider_readback'] = scale.pin(path)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, error):
                scale.validate_growth(changed)

    def test_service_profiles_require_raw_provider_and_volume_membership(self):
        for evidence, field, error in [('provider_readback', 'serviceId', 'deployment membership'), ('volume_readback', 'serviceId', 'volume membership')]:
            self.service_matrix()
            changed = copy.deepcopy(self.runs)
            member = changed[0]['topology']['source_profiles'][1]['backends'][0]
            path = Path(member[evidence]['path'])
            raw = json.loads(path.read_text())
            target = raw['data']['deployment'] if evidence == 'provider_readback' else raw['data']['environment']['volumeInstances']['edges'][0]['node']
            target[field] = 'other-service'
            path.write_text(json.dumps(raw))
            member[evidence] = scale.pin(path)
            with self.subTest(evidence=evidence), self.assertRaisesRegex(ValueError, error):
                scale.validate_growth(changed)

    def test_service_profiles_require_real_bounded_counters(self):
        self.service_matrix()
        changed = copy.deepcopy(self.runs)
        changed[0]['topology']['source_profiles'][0]['request_count_after'] += 1
        with self.assertRaisesRegex(ValueError, 'equal backend request counts'):
            scale.validate_growth(changed)
        changed = copy.deepcopy(self.runs)
        changed[0]['topology']['source_profiles'][1]['backends'][0]['request_count_after'] = 1
        with self.assertRaisesRegex(ValueError, 'active/idle'):
            scale.validate_growth(changed)
        changed = copy.deepcopy(self.runs)
        member = changed[0]['topology']['source_profiles'][0]['backends'][0]
        path = Path(member['request_counter_evidence']['after']['path'])
        raw = json.loads(path.read_text())
        raw['boot_id'] = 'replacement-boot'
        path.write_text(json.dumps(raw))
        member['request_counter_evidence']['after'] = scale.pin(path)
        with self.assertRaisesRegex(ValueError, 'restarted during'):
            scale.validate_growth(changed)

    def test_proxy_routes_and_measured_endpoint_must_match(self):
        self.service_matrix()
        changed = copy.deepcopy(self.runs)
        changed[-1]['receipt']['endpoint'] = 'https://wrong-proxy.invalid'
        with self.assertRaisesRegex(ValueError, 'active proxy'):
            scale.validate_growth(changed)
        changed = copy.deepcopy(self.runs)
        proxy = changed[0]['topology']['source_profiles'][1]['proxy']
        path = Path(proxy['routing_readback']['path'])
        raw = json.loads(path.read_text())
        raw['processes'][0]['backends'] = raw['processes'][0]['backends'][:1]
        path.write_text(json.dumps(raw))
        proxy['routing_readback'] = scale.pin(path)
        with self.assertRaisesRegex(ValueError, 'routing membership'):
            scale.validate_growth(changed)

    def test_distinct_oci_requires_complete_measured_runtime_equivalence(self):
        self.runtime_matrix()
        scale.validate_growth(self.runs)
        changed = copy.deepcopy(self.runs)
        del changed[0]['topology']['runtime_equivalence']
        with self.assertRaisesRegex(ValueError, 'resources or image'):
            scale.validate_growth(changed)

    def test_runtime_equivalence_rejects_executable_metadata_and_package_changes(self):
        for mutation in ['mode', 'hash', 'link', 'packages']:
            report = self.runtime_matrix()
            entry = report['sources'][1]
            path = Path(entry['raw_runtime_manifest'])
            raw = json.loads(path.read_text())
            if mutation == 'mode':
                raw['rows'][3][1] = 493
            elif mutation == 'hash':
                raw['rows'][3][3] = 'e' * 64
            elif mutation == 'link':
                raw['rows'][2][2] = '/usr/local/bin/different-node'
            else:
                raw['packages'] = 'node\t22.19.0\n'
            raw['digest'] = 'sha256:' + hashlib.sha256(json.dumps({'rows': raw['rows'], 'packages': raw['packages']}, separators=(',', ':')).encode()).hexdigest()
            path.write_text(json.dumps(raw))
            entry['raw_runtime_manifest_sha256'] = scale.pin(path)['sha256']
            entry['normalized_runtime_digest'] = 'sha256:' + hashlib.sha256(json.dumps({'rows': [row for row in raw['rows'] if row[0] != '/etc/hostname'], 'packages': raw['packages']}, separators=(',', ':')).encode()).hexdigest()
            report_path = Path(self.runs[0]['topology']['runtime_equivalence']['path'])
            report_path.write_text(json.dumps(report))
            self.runs[0]['topology']['runtime_equivalence'] = scale.pin(report_path)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'runtime differs'):
                scale.validate_growth(self.runs)

    def test_runtime_equivalence_cannot_expand_instance_exclusions(self):
        report = self.runtime_matrix()
        report['allowed_instance_files'].append('/app/core/control-plane/dist/control.js')
        path = Path(self.runs[0]['topology']['runtime_equivalence']['path'])
        path.write_text(json.dumps(report))
        self.runs[0]['topology']['runtime_equivalence'] = scale.pin(path)
        with self.assertRaisesRegex(ValueError, 'three allowed instance paths'):
            scale.validate_growth(self.runs)

    def test_runtime_equivalence_preserves_policy_identity_and_process_arguments(self):
        for mutation in ['policy', 'identity', 'argv']:
            report = self.runtime_matrix()
            entry = report['sources'][1]
            path = Path(entry['launch_readback'])
            raw = json.loads(path.read_text())
            if mutation == 'policy':
                raw['configs'][0]['policy_digest'] = 'changed-policy'
            elif mutation == 'argv':
                raw['processes'][1]['argv'].append('--changed-option')
            else:
                identity_path = Path(entry['identity_readback']['path'])
                identity = json.loads(identity_path.read_text())
                identity['principals'] = ['other-principal']
                identity_path.write_text(json.dumps(identity))
                entry['identity_readback'] = scale.pin(identity_path)
                raw['configs'][0]['identity_digest'] = 'sha256:' + entry['identity_readback']['sha256']
            if mutation in ['policy', 'identity']:
                member = next(member for profile in self.runs[0]['topology']['source_profiles'] for member in profile['backends'] if member['service_id'] == entry['service_id'])
                activation_path = Path(member['activation_readback']['path'])
                activation = json.loads(activation_path.read_text())
                filename = 'control-policy.json' if mutation == 'policy' else 'control-identity.json'
                payload = b'changed-policy' if mutation == 'policy' else Path(entry['identity_readback']['path']).read_bytes()
                activation['files'][filename] = base64.b64encode(payload).decode()
                activation_path.write_text(json.dumps(activation))
                member['activation_readback'] = scale.pin(activation_path)
                raw['configs'][0]['policy_digest' if mutation == 'policy' else 'identity_digest'] = 'sha256:' + hashlib.sha256(payload).hexdigest()
                for process in raw['processes']:
                    process['environment']['HYPERFIDE_FLEET_CONTROL_BOOTSTRAP_SHA256'] = 'sha256:' + member['activation_readback']['sha256']
            path.write_text(json.dumps(raw))
            entry['launch_readback_sha256'] = scale.pin(path)['sha256']
            for profile in self.runs[0]['topology']['source_profiles']:
                for member in profile['backends']:
                    if member['service_id'] == entry['service_id']:
                        member['launch_readback'] = scale.pin(path)
            report_path = Path(self.runs[0]['topology']['runtime_equivalence']['path'])
            report_path.write_text(json.dumps(report))
            self.runs[0]['topology']['runtime_equivalence'] = scale.pin(report_path)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'runtime differs'):
                scale.validate_growth(self.runs)

    def test_logical_authority_is_bound_separately_from_physical_deployment(self):
        self.service_matrix()
        scale.validate_growth(self.runs)
        member = self.runs[0]['topology']['source_profiles'][1]['backends'][0]
        path = Path(member['launch_readback']['path'])
        raw = json.loads(path.read_text())
        raw['processes'][0]['environment']['HYPERFIDE_DEPLOYMENT_ID'] = member['deployment_id']
        path.write_text(json.dumps(raw))
        member['launch_readback'] = scale.pin(path)
        with self.assertRaisesRegex(ValueError, 'authority namespace'):
            scale.validate_growth(self.runs)


if __name__ == '__main__':
    unittest.main()
