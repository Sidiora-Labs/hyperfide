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
        report = self.run_campaign()
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(report['closure']['status'], 'PASS')
        original = copy.deepcopy(report['entries'])
        resumed = self.run_campaign(True)
        self.assertEqual(resumed['entries'], original)
        self.assertEqual(len(list(self.output.glob('attempts/*/*/campaign/receipts/*.json'))), 1)

    def test_changed_plan_or_source_refuses_resume(self):
        self.run_campaign()
        (self.root / 'src/input.txt').write_text('changed source\n')
        with self.assertRaises((RUNNER.CampaignError, RUNNER.Q.GateError)):
            self.run_campaign(True)

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
        wrong=state['entries']['SCM-024/live']
        for field in ['campaign','receipt_id','receipt_sha256']:
            state['entries']['SCM-024/full'][field]=wrong[field]
        (self.output/'state.json').write_bytes(RUNNER.canonical(state))
        with self.assertRaisesRegex(RUNNER.CampaignError,'Stored campaign input differs'):
            self.run_campaign(True)

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
