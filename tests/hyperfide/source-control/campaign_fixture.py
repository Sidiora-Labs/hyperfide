"""Owned local campaigns for testing qualification and closure contracts."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import uuid

def create_campaign(root, q, scope_kind='task-component'):
    (root / 'src').mkdir()
    (root / 'src/probe.py').write_text("import json\nfrom pathlib import Path\nassert Path('src/input.txt').read_text() == 'native input\\n'\nprint(json.dumps({'type':'assertion','id':'native.bytes','expected':True,'actual':True}))\nprint(json.dumps({'type':'cleanup','complete':True,'resources':[]}))\n")
    (root / 'src/input.txt').write_text('native input\n')
    shutil.copyfile(Path(sys.executable).resolve(), root / 'src/python')
    (root / 'src/root.object').write_bytes(b'captured root object')
    (root / 'src/revision.object').write_bytes(b'captured revision object')
    def pin(path):
        return {'path': path, 'sha256': hashlib.sha256((root / path).read_bytes()).hexdigest()}
    scope = {name: str(uuid.uuid4()) for name in ('organisation_id', 'repository_id', 'security_domain_id')}
    identity = {'scope': scope, 'revision_id': 'sha256:' + pin('src/revision.object')['sha256'], 'root_tree_id': 'sha256:' + pin('src/root.object')['sha256'], 'authority_epoch': '1', 'policy_version': 'native-harness-v1'}
    source_manifest = {'schema_version': 1, **identity, 'files': [pin('src/input.txt')]}
    (root / 'source.json').write_bytes(q.canonical(source_manifest))
    readiness = {'schema_version': 1, **identity, 'manifest_sha256': pin('source.json')['sha256'], 'status': 'VERIFIED', 'objects': [dict(pin(path), object_id=identity[key], state='READY') for key, path in [('root_tree_id', 'src/root.object'), ('revision_id', 'src/revision.object')]]}
    (root / 'readiness.json').write_bytes(q.canonical(readiness))
    native = {'schema_version': 1, **identity, 'manifest': pin('source.json'), 'readiness_receipt': pin('readiness.json'), 'toolchain': [pin('src/python')], 'environment': {'platform': sys.platform, 'identity': 'isolated harness fixture'}, 'test_inventory_sha256': q.digest(q.canonical(['native.bytes']))}
    registration = {'schema_version': 2, 'feature': 'hyperfide-source-control', 'variant': 'task:hyperfide-source-control/0.2', 'task': '0.2', 'scope': scope_kind, 'cases': ['SCM-024'], 'assertion_ids': ['native.bytes'], 'argv': [sys.executable, 'src/probe.py'], 'source_files': ['src/probe.py'], 'source_roots': ['src'], 'actions': [], 'resources': [], 'required_env': []}
    manifest = {'schema_version': 2, 'feature': 'hyperfide-source-control', 'native_source': native, 'campaign_id': 'native-harness', 'registered_variant': registration['variant'], 'scope': scope_kind, 'case_ids': ['SCM-024'], 'expected_assertion_ids': ['native.bytes'], 'approval': {'approved': True, 'allowed_actions': []}, 'inputs': [dict(pin('src/probe.py'), size=(root / 'src/probe.py').stat().st_size)], 'resources': [], 'seed': 1, 'policy': {'source_variant':'full'}}
    isolated_registry = {'schema_version': 2, 'cases': {'SCM-024': {'reqs':['14.4'],'full_assertion_ids':['native.bytes'] if scope_kind=='full-case' else []}}, 'suites': {}, 'registration_glob': 'registrations/*.json'}
    (root / 'registrations').mkdir()
    for path, value in [('registry.json', isolated_registry), ('registrations/native.json', registration), ('manifest.json', manifest)]:
        (root / path).write_bytes(q.canonical(value))
    return native, registration, manifest, isolated_registry
