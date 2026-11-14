#!/usr/bin/env python3
"""Real qualifier/checker coverage for release-campaign resume and refusal."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import uuid


HERE = Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


RUNNER = module('release_campaign', HERE / 'release_campaign.py')
FIXTURE = module('release_fixture', HERE / 'campaign_fixture.py')


class ReleaseCampaignTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='hf-release-runner-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / 'release'
        native, registration, manifest, registry = FIXTURE.create_campaign(self.root, RUNNER.Q, 'full-case')
        registration.update(task='6.3', case_variant='full', variant='case:hyperfide-source-control/SCM-024/full')
        manifest.update(registered_variant=registration['variant'])
        source_manifest=json.loads((self.root/'source.json').read_text())
        records={}
        for path in (self.root/'src').iterdir():
            if not path.is_file():continue
            relative=path.relative_to(self.root).as_posix();captured=self.root/'captured'/relative;captured.parent.mkdir(parents=True,exist_ok=True);captured.write_bytes(path.read_bytes())
            records[relative]={'path':captured.relative_to(self.root).as_posix(),'sha256':RUNNER.digest(captured)}
        source_manifest.update(files=list(records.values()),source_paths=records)
        self.write('source.json',source_manifest)
        native['manifest']=self.pin('source.json')
        readiness=json.loads((self.root/'readiness.json').read_text());readiness['manifest_sha256']=native['manifest']['sha256'];self.write('readiness.json',readiness)
        native['readiness_receipt']=self.pin('readiness.json');manifest['native_source']=native
        self.native, self.registration, self.manifest, self.registry = native, registration, manifest, registry
        self.claims = {'schema_version': 1, 'cases': {'SCM-024': {'requirement_clauses': ['14.4'], 'required_variants': ['full']}}}
        self.write('registry.json', registry)
        self.write('registrations/native.json', registration)
        self.write('manifest.json', manifest)
        self.write('native.json', native)
        self.write('claims.json', self.claims)
        self.plan = {'schema_version': 1, 'release_id': str(uuid.uuid4()),
                     'registry': self.pin('registry.json'), 'claims': self.pin('claims.json'),
                     'native_source': self.pin('native.json'),
                     'entries': [{'case_id': 'SCM-024', 'variant': 'full', 'manifest': self.pin('manifest.json')}]}
        self.write('plan.json', self.plan)

    def write(self, name, value):
        path = self.root / name
        path.write_bytes(RUNNER.canonical(value) + b'\n')

    def pin(self, name):
        return {'path': name, 'sha256': RUNNER.digest(self.root / name)}

    def replace_probe(self, body):
        (self.root/'src/probe.py').write_text(body)
        captured=self.root/'captured/src/probe.py';captured.write_text(body)
        source=RUNNER.read(self.root/'source.json')
        source['source_paths']['src/probe.py']['sha256']=RUNNER.digest(captured)
        for record in source['files']:
            if record['path']=='captured/src/probe.py':record['sha256']=RUNNER.digest(captured)
        self.write('source.json',source);self.native['manifest']=self.pin('source.json')
        readiness=RUNNER.read(self.root/'readiness.json');readiness['manifest_sha256']=self.native['manifest']['sha256'];self.write('readiness.json',readiness)
        self.native['readiness_receipt']=self.pin('readiness.json');self.write('native.json',self.native)
        self.manifest['native_source']=self.native
        self.manifest['inputs'][0].update(sha256=RUNNER.digest(self.root/'src/probe.py'),size=len(body.encode()))
        self.write('manifest.json',self.manifest)
        self.plan['native_source']=self.pin('native.json');self.plan['entries'][0]['manifest']=self.pin('manifest.json');self.write('plan.json',self.plan)

    def run_campaign(self, resume=False):
        return RUNNER.run(self.root, self.root / 'plan.json', self.output, resume)

    def test_real_qualifier_checker_closure_and_exact_resume(self):
        # Checked-in manifests pin reviewed inputs and cannot invent native identities.
        registry_path = HERE/'registry.json'
        claims_path = HERE/'claims.json'
        _, canonical_variants = RUNNER.Q.load_registry(registry_path)
        for name in ('scm-023-api-cli-ui.json', 'scm-024-full.json'):
            descriptor = RUNNER.read(HERE/'manifests/full'/name)
            for field in ('registry', 'claims', 'registration'):
                RUNNER.pin(RUNNER.ROOT, descriptor[field])
            for item in descriptor['inputs']:
                path = RUNNER.pin(RUNNER.ROOT, {key: item[key] for key in ('path', 'sha256')})
                self.assertEqual(path.stat().st_size, item['size'])
            with self.assertRaises(RUNNER.Q.GateError):
                RUNNER.bind_full_manifest(RUNNER.ROOT, descriptor, {}, registry_path, claims_path, canonical_variants)
        pinned = {'schema_version': 1, 'kind': 'hyperfide.source-full-case-inputs',
                  'feature': 'hyperfide-source-control', 'case_id': 'SCM-024', 'variant': 'full',
                  'registered_variant': self.registration['variant'], 'registry': self.pin('registry.json'),
                  'claims': self.pin('claims.json'), 'registration': self.pin('registrations/native.json'),
                  'inputs': self.manifest['inputs'], 'seed': self.manifest['seed'],
                  'policy': self.manifest['policy'], 'approval': self.manifest['approval']}
        registry, variants = RUNNER.Q.load_registry(self.root/'registry.json')
        bound = RUNNER.bind_full_manifest(self.root, pinned, self.native, self.root/'registry.json', self.root/'claims.json', variants)
        self.assertEqual(bound['native_source'], self.native)
        self.assertEqual(bound['expected_assertion_ids'], registry['cases']['SCM-024']['full_assertion_ids'])
        for field in ('registry', 'claims', 'registration'):
            altered = copy.deepcopy(pinned)
            altered[field]['sha256'] = '0'*64
            with self.assertRaisesRegex(RUNNER.CampaignError, 'Input pin differs'):
                RUNNER.bind_full_manifest(self.root, altered, self.native, self.root/'registry.json', self.root/'claims.json', variants)
        missing_native = copy.deepcopy(self.native)
        missing_native.pop('root_tree_id')
        with self.assertRaises(RUNNER.Q.GateError):
            RUNNER.bind_full_manifest(self.root, pinned, missing_native, self.root/'registry.json', self.root/'claims.json', variants)
        self.write('pinned.json', pinned)
        self.plan['entries'][0]['manifest'] = self.pin('pinned.json')
        self.write('plan.json', self.plan)
        report = self.run_campaign()
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(report['closure']['status'], 'PASS')
        original = copy.deepcopy(report['entries'])
        resumed = self.run_campaign(True)
        self.assertEqual(resumed['entries'], original)
        self.assertEqual(len(resumed['reuse_records']), 1)
        reuse = resumed['reuse_records'][0]
        self.assertEqual(reuse['decision'], 'REUSE')
        self.assertEqual(reuse['receipt_id'], original[0]['receipt_id'])
        self.assertEqual(reuse['previous_inventory_sha256'], original[0]['inventory_sha256'])
        self.assertEqual(reuse['current_inventory_sha256'], original[0]['inventory_sha256'])
        self.assertIn('Unchanged inventory digest', reuse['reason'])
        persisted = RUNNER.read(self.output/reuse['record'])
        self.assertEqual(persisted, {key: value for key, value in reuse.items() if key != 'record'})
        self.assertEqual(original[0]['inventory_sha256'], RUNNER.inventory_digest(original[0]['reuse_inventory']))
        self.assertEqual(len(list(self.output.glob('attempts/*/*/campaign/receipts/*.json'))), 1)

    def test_status_only_spec_metadata_preserves_receipt_but_contract_change_refuses(self):
        active=self.root/RUNNER.Q.STATUS_CONTRACT_PATH
        snapshot=self.root/RUNNER.Q.STATUS_CONTRACT_SNAPSHOT
        body=b'[meta]\nstatus = "in_progress"\n[req.1]\nac_1 = "required behavior"\n[task.0.1]\nstatus = "implemented"\nverify_cmd = "python3 check.py"\n[case.SCM-001]\nstatus = "UNRUN"\n'
        for path in [active,snapshot]:path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(body)
        self.registration['source_files'].append(RUNNER.Q.STATUS_CONTRACT_SNAPSHOT)
        self.registration['status_contracts']=[{'path':RUNNER.Q.STATUS_CONTRACT_PATH,'snapshot':RUNNER.Q.STATUS_CONTRACT_SNAPSHOT,'mode':RUNNER.Q.STATUS_CONTRACT_MODE}]
        captured=self.root/'captured'/RUNNER.Q.STATUS_CONTRACT_SNAPSHOT;captured.parent.mkdir(parents=True,exist_ok=True);captured.write_bytes(body)
        source=RUNNER.read(self.root/'source.json');record={'path':captured.relative_to(self.root).as_posix(),'sha256':RUNNER.digest(captured)}
        source['source_paths'][RUNNER.Q.STATUS_CONTRACT_SNAPSHOT]=record;source['files'].append(record);self.write('source.json',source)
        self.native['manifest']=self.pin('source.json');readiness=RUNNER.read(self.root/'readiness.json');readiness['manifest_sha256']=self.native['manifest']['sha256'];self.write('readiness.json',readiness);self.native['readiness_receipt']=self.pin('readiness.json')
        self.manifest['native_source']=self.native;self.manifest['inputs'].append({'path':RUNNER.Q.STATUS_CONTRACT_SNAPSHOT,'sha256':RUNNER.digest(snapshot),'size':len(body)})
        self.write('registrations/native.json',self.registration);self.write('native.json',self.native);self.write('manifest.json',self.manifest)
        self.plan['native_source']=self.pin('native.json');self.plan['entries'][0]['manifest']=self.pin('manifest.json');self.write('plan.json',self.plan)
        first=self.run_campaign();self.assertEqual(first['status'],'PASS')
        active.write_bytes(body.replace(b'"in_progress"',b'"done"').replace(b'"UNRUN"',b'"PASS"'))
        second=self.run_campaign(True);self.assertEqual(second['entries'],first['entries']);self.assertEqual(second['status'],'PASS')
        active.write_bytes(body.replace(b'required behavior',b'weakened behavior'))
        with self.assertRaises((RUNNER.CampaignError,RUNNER.Q.GateError)):self.run_campaign(True)
        entry=first['entries'][0]
        with self.assertRaises(RUNNER.CampaignError):RUNNER.checked(self.output/entry['campaign'],entry['receipt_id'],entry['receipt_sha256'])

    def test_changed_plan_or_source_refuses_resume(self):
        first = self.run_campaign()
        receipt = self.output / first['entries'][0]['campaign'] / 'receipts' / (first['entries'][0]['receipt_id']+'.json')
        before = receipt.read_bytes()
        (self.root / 'src/input.txt').write_text('changed source\n')
        with self.assertRaises((RUNNER.CampaignError, RUNNER.Q.GateError)):
            self.run_campaign(True)
        state = RUNNER.read(self.output/'state.json')
        self.assertEqual(state['entries']['SCM-024/full']['status'], 'INVALID')
        reuse = state['reuse_records'][-1]
        self.assertEqual(reuse['decision'], 'INVALID')
        self.assertNotEqual(reuse['previous_inventory_sha256'], reuse['current_inventory_sha256'])
        self.assertIn('inventory digest changed', reuse['reason'])
        self.assertEqual(receipt.read_bytes(), before)

    def test_new_entrypoint_bytes_cannot_claim_an_old_native_tree(self):
        probe=self.root/'src/probe.py';probe.write_text(probe.read_text()+'# current implementation change\n')
        self.manifest['inputs'][0].update(sha256=RUNNER.digest(probe),size=probe.stat().st_size)
        self.write('manifest.json',self.manifest);self.plan['entries'][0]['manifest']=self.pin('manifest.json');self.write('plan.json',self.plan)
        with self.assertRaisesRegex(RUNNER.CampaignError,'does not bind current implementation'):
            self.run_campaign()

    def test_new_transitive_source_file_is_not_silently_accepted(self):
        (self.root/'src/new_dependency.py').write_text('current_dependency=True\n')
        with self.assertRaisesRegex(RUNNER.CampaignError,'does not bind current implementation'):
            self.run_campaign()

    def test_missing_required_variant_keeps_successful_work_without_closure(self):
        self.claims['cases']['SCM-024']['required_variants'].append('live')
        self.write('claims.json', self.claims)
        self.plan['claims'] = self.pin('claims.json')
        self.write('plan.json', self.plan)
        report = self.run_campaign()
        self.assertEqual(report['status'], 'BLOCKED')
        self.assertEqual(report['missing_variants'], ['SCM-024/live'])
        self.assertEqual(report['entries'][0]['status'], 'PASS')
        self.assertFalse((self.output / 'closure.json').exists())

    def test_tampered_receipt_is_not_reused(self):
        report = self.run_campaign()
        entry = report['entries'][0]
        receipt = self.output / entry['campaign'] / 'receipts' / (entry['receipt_id'] + '.json')
        receipt.write_text('{}')
        with self.assertRaises(RUNNER.CampaignError):
            self.run_campaign(True)

        state = RUNNER.read(self.output/'state.json')
        self.assertEqual(state['entries']['SCM-024/full']['status'], 'INVALID')
        reuse = state['reuse_records'][-1]
        self.assertEqual(reuse['decision'], 'INVALID')
        self.assertEqual(reuse['previous_inventory_sha256'], reuse['current_inventory_sha256'])
        self.assertIn('Recorded receipt changed', reuse['reason'])

    def test_interrupted_index_recovers_only_an_actual_verified_receipt(self):
        report = self.run_campaign()
        state = RUNNER.read(self.output / 'state.json')
        entry = state['entries']['SCM-024/full']
        entry.update(status='RUNNING')
        entry.pop('receipt_id')
        entry.pop('receipt_sha256')
        (self.output / 'state.json').write_bytes(RUNNER.canonical(state))
        resumed = self.run_campaign(True)
        self.assertTrue(resumed['entries'][0]['recovered'])
        self.assertEqual(resumed['entries'][0]['receipt_id'], report['entries'][0]['receipt_id'])

    def test_multiple_variants_resume_without_packet_order_drift(self):
        registration=copy.deepcopy(self.registration)
        registration.update(case_variant='live',variant='case:hyperfide-source-control/SCM-024/live')
        manifest=copy.deepcopy(self.manifest)
        manifest.update(registered_variant=registration['variant'],campaign_id='native-live-harness',policy={'source_variant':'live'})
        self.write('registrations/live.json',registration)
        self.write('live.json',manifest)
        self.claims['cases']['SCM-024']['required_variants'].append('live')
        self.write('claims.json',self.claims)
        self.plan['claims']=self.pin('claims.json')
        self.plan['entries'].insert(0,{'case_id':'SCM-024','variant':'live','manifest':self.pin('live.json')})
        self.write('plan.json',self.plan)
        self.assertEqual(self.run_campaign()['status'],'PASS')
        before=(self.output/'closure.json').read_bytes()
        self.assertEqual(self.run_campaign(True)['status'],'PASS')
        self.assertEqual((self.output/'closure.json').read_bytes(),before)
        state=RUNNER.read(self.output/'state.json')
        original_state=copy.deepcopy(state)
        wrong=state['entries']['SCM-024/live']
        for field in ['campaign','receipt_id','receipt_sha256']:
            state['entries']['SCM-024/full'][field]=wrong[field]
        (self.output/'state.json').write_bytes(RUNNER.canonical(state))
        with self.assertRaisesRegex(RUNNER.CampaignError,'Affected receipts are INVALID'):
            self.run_campaign(True)
        wrong_reuse=[row for row in RUNNER.read(self.output/'state.json')['reuse_records'] if row['variant']=='full' and row['decision']=='INVALID'][-1]
        self.assertIn('Stored campaign input differs',wrong_reuse['reason'])
        # One variant's manifest changes; the other retains exact inventory and
        # its real independently checked receipt, even though closure is blocked.
        (self.output/'state.json').write_bytes(RUNNER.canonical(original_state))
        receipts={path:path.read_bytes() for path in self.output.glob('attempts/*/*/campaign/receipts/*.json')}
        self.manifest['seed'] += 1
        self.write('manifest.json',self.manifest)
        for entry in self.plan['entries']:
            if entry['variant']=='full':entry['manifest']=self.pin('manifest.json')
        self.write('plan.json',self.plan)
        with self.assertRaisesRegex(RUNNER.CampaignError,'Affected receipts are INVALID'):
            self.run_campaign(True)
        invalidated=RUNNER.read(self.output/'state.json')
        self.assertEqual(invalidated['entries']['SCM-024/full']['status'],'INVALID')
        self.assertEqual(invalidated['entries']['SCM-024/live']['status'],'PASS')
        decisions={row['variant']:row for row in invalidated['reuse_records']}
        self.assertEqual(decisions['full']['decision'],'INVALID')
        self.assertNotEqual(decisions['full']['previous_inventory_sha256'],decisions['full']['current_inventory_sha256'])
        self.assertEqual(decisions['live']['decision'],'REUSE')
        self.assertEqual(decisions['live']['previous_inventory_sha256'],decisions['live']['current_inventory_sha256'])
        self.assertEqual({path:path.read_bytes() for path in self.output.glob('attempts/*/*/campaign/receipts/*.json')},receipts)
        self.assertEqual(len(list(self.output.glob('attempts/*/*'))),2)

    def test_interrupted_execution_without_receipt_is_not_relaunched(self):
        report=self.run_campaign()
        state=RUNNER.read(self.output/'state.json')
        entry=state['entries']['SCM-024/full']
        receipt=self.output/entry['campaign']/'receipts'/(entry['receipt_id']+'.json')
        receipt.unlink()
        entry['status']='RUNNING'
        (self.output/'state.json').write_bytes(RUNNER.canonical(state))
        resumed=self.run_campaign(True)
        self.assertEqual(resumed['status'],'BLOCKED')
        self.assertIn('Interrupted entry',resumed['entries'][0]['diagnostic'])
        self.assertEqual(len(list(self.output.glob('attempts/*/*'))),1)

    def test_failed_case_retries_only_after_verified_cleanup(self):
        self.replace_probe("import json\nprint(json.dumps({'type':'assertion','id':'native.bytes','expected':True,'actual':False}))\nprint(json.dumps({'type':'cleanup','complete':True,'resources':[]}))\n")
        report=self.run_campaign();self.assertEqual(report['status'],'BLOCKED')
        self.assertTrue(report['entries'][0]['retry_safe'])
        self.run_campaign(True)
        self.assertEqual(len(list(self.output.glob('attempts/*/*'))),2)

    def test_failed_case_with_missing_cleanup_is_not_repeated(self):
        self.replace_probe("raise RuntimeError('owned test failure before cleanup')\n")
        self.assertEqual(self.run_campaign()['status'],'BLOCKED')
        self.assertEqual(self.run_campaign(True)['status'],'BLOCKED')
        self.assertEqual(len(list(self.output.glob('attempts/*/*'))),1)

    def test_task_component_manifest_cannot_fill_a_case(self):
        self.registration.pop('case_variant')
        self.registration.update(scope='task-component', variant='task:hyperfide-source-control/6.3')
        self.manifest.update(scope='task-component', registered_variant=self.registration['variant'])
        self.write('registrations/native.json', self.registration)
        self.write('manifest.json', self.manifest)
        self.plan['entries'][0]['manifest'] = self.pin('manifest.json')
        self.write('plan.json', self.plan)
        with self.assertRaises(RUNNER.CampaignError):
            self.run_campaign()


if __name__ == '__main__':
    unittest.main()
