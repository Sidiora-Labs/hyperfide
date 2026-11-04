#!/usr/bin/env python3
"""Independent verifier tests for the sole mutable specification metadata field."""
import importlib.util
import json
import re
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
Q = module('status_qualifier', 'tests/hyperfide/qualify.py')
C = module('status_checker', 'tests/hyperfide/check-evidence.py')
F = module('status_fleet_verifier', 'tests/hyperfide/support/fleet_live_qualification.py')
BODY = b'[meta]\nstatus = "in_progress" # unchanged comment\nstage = "implementation"\n[req.1]\nac_1 = "same requirement"\n[task.0.1]\nstatus = "implemented"\nverify_cmd = "python3 verify.py"\nrequires = ["0.2"]\n[case.SCM-001]\nstatus = "UNRUN"\n'

class StatusContractTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.active = self.root / Q.STATUS_CONTRACT_PATH
        self.snapshot = self.root / Q.STATUS_CONTRACT_SNAPSHOT
        for path in [self.active, self.snapshot]:path.parent.mkdir(parents=True, exist_ok=True);path.write_bytes(BODY)
        self.registration = {'source_files': [Q.STATUS_CONTRACT_SNAPSHOT], 'source_roots': [], 'status_contracts': [{'path': Q.STATUS_CONTRACT_PATH, 'snapshot': Q.STATUS_CONTRACT_SNAPSHOT, 'mode': Q.STATUS_CONTRACT_MODE}]}
    def valid(self):
        Q.verify_status_contracts(self.root, self.registration);C.verify_status_contracts(self.root, self.registration)
    def refused(self, data):
        self.active.write_bytes(data)
        with self.assertRaises((Q.GateError, ValueError)):Q.verify_status_contracts(self.root, self.registration)
        with self.assertRaises((C.InvalidEvidence, ValueError)):C.verify_status_contracts(self.root, self.registration)
    def test_existing_meta_task_and_case_status_values_can_change(self):
        self.active.write_bytes(BODY.replace(b'"in_progress"', b'"done"').replace(b'"implemented"', b'"done"').replace(b'"UNRUN"', b'"PASS"'));self.valid()
        self.assertNotEqual(self.active.read_bytes(), self.snapshot.read_bytes())
    def test_requirements_commands_and_dependencies_are_immutable(self):
        for old,new in [(b'same requirement',b'changed requirement'),(b'python3 verify.py',b'python3 skip.py'),(b'0.2',b'0.3')]:self.refused(BODY.replace(old,new))
    def test_comments_spacing_and_line_endings_are_immutable(self):
        for data in [BODY.replace(b'unchanged comment',b'changed comment'),BODY.replace(b'status =',b'status='),BODY.replace(b'\n',b'\r\n')]:self.refused(data)
        status_bytes=set()
        for match in re.finditer(rb'status = "([^"]+)"',BODY):status_bytes.update(range(*match.span(1)))
        for offset in range(len(BODY)):
            if offset not in status_bytes:
                changed=bytearray(BODY);changed[offset]=ord('X') if changed[offset]!=ord('X') else ord('Y');self.refused(bytes(changed))
    def test_fields_and_sections_cannot_be_added_removed_or_renamed(self):
        for data in [BODY+b'extra = true\n',BODY.replace(b'status = "UNRUN"\n',b''),BODY.replace(b'[case.SCM-001]',b'[case.SCM-002]')]:self.refused(data)
    def test_unknown_statuses_and_nonstatus_stage_changes_are_refused(self):
        self.refused(BODY.replace(b'"UNRUN"',b'"MAGIC"'));self.refused(BODY.replace(b'"implementation"',b'"complete"'))
    def test_duplicate_status_fields_and_unregistered_paths_are_refused(self):
        body=BODY.replace(b'[req.1]',b'status = "done"\n[req.1]');self.active.write_bytes(body);self.snapshot.write_bytes(body)
        with self.assertRaises(Q.GateError):self.valid()
        self.registration['status_contracts'][0]['path']='other.kvx'
        with self.assertRaises(Q.GateError):Q.verify_status_contracts(self.root,self.registration)
        with self.assertRaises(C.InvalidEvidence):C.verify_status_contracts(self.root,self.registration)
    def test_symbolic_ancestors_are_refused(self):
        directory=self.active.parent; directory.rename(directory.with_name('real'));directory.symlink_to(directory.with_name('real'),target_is_directory=True)
        with self.assertRaises(Q.GateError):Q.verify_status_contracts(self.root,self.registration)
        with self.assertRaises(C.InvalidEvidence):C.verify_status_contracts(self.root,self.registration)
    def test_explicit_fleet_v2_derivation_retains_full_raw_baseline(self):
        baseline=self.root/'fleet-baseline.kvx';baseline.write_bytes(BODY);baseline.chmod(0o600)
        pin={'path':Q.STATUS_CONTRACT_PATH,'digest':F.digest(BODY)}
        declaration={'schema_version':2,'path':Q.STATUS_CONTRACT_PATH,'mode':Q.STATUS_CONTRACT_MODE,'baseline':{'path':baseline.name,'digest':pin['digest']}}
        current=BODY.replace(b'"in_progress"',b'"done"').replace(b'"UNRUN"',b'"PASS"')
        result=F.verified_contract_status_derivation(declaration,pin,current,self.root)
        self.assertEqual(result['baseline_digest'],F.digest(BODY));self.assertEqual(result['current_digest'],F.digest(current))
        with self.assertRaises(F.Refused):F.verified_contract_status_derivation(declaration,pin,current.replace(b'verify.py',b'skip.py'),self.root)
    def test_fleet_derivation_requires_explicit_typed_mode_and_private_baseline(self):
        baseline=self.root/'fleet-baseline.kvx';baseline.write_bytes(BODY);baseline.chmod(0o600)
        pin={'path':Q.STATUS_CONTRACT_PATH,'digest':F.digest(BODY)}
        declaration={'schema_version':2.0,'path':Q.STATUS_CONTRACT_PATH,'mode':Q.STATUS_CONTRACT_MODE,'baseline':{'path':baseline.name,'digest':pin['digest']}}
        with self.assertRaises(F.Refused):F.verified_contract_status_derivation(declaration,pin,BODY,self.root)
        declaration['schema_version']=2;baseline.chmod(0o644)
        with self.assertRaises(F.Refused):F.verified_contract_status_derivation(declaration,pin,BODY,self.root)

if __name__ == '__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(StatusContractTest);names=[test.id().rsplit('.',1)[-1] for test in suite]
    result=unittest.TextTestRunner(verbosity=1).run(suite);failed={test.id().rsplit('.',1)[-1] for test,_ in result.errors+result.failures}
    for name in names:print(json.dumps({'type':'assertion','id':'status-contract.'+name,'expected':True,'actual':name not in failed}))
    print(json.dumps({'type':'cleanup','complete':result.wasSuccessful(),'resources':[]}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
