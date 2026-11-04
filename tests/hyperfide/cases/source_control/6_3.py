#!/usr/bin/env python3
"""Qualify a complete evidence packet or exercise closure refusal boundaries."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[4]
MODULE = ROOT / 'tests/hyperfide/source-control/closure.py'
spec = importlib.util.spec_from_file_location('source_closure', MODULE)
closure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(closure)

def self_test():
    checks = []
    with tempfile.TemporaryDirectory(prefix='hf-source-closure-') as temporary:
        root = Path(temporary)
        registry = {'schema_version': 2, 'cases': {'SCM-024': {'reqs': ['14.4'], 'full_assertion_ids': ['SCM-024.full']}}}
        claims = {'schema_version': 1, 'cases': {'SCM-024': {'requirement_clauses': ['14.4'], 'required_variants': ['full']}}}
        for name, value in [('registry.json', registry), ('claims.json', claims)]:
            (root / name).write_bytes(closure.canonical(value))
        source = {'scope': {key: str(uuid.uuid4()) for key in ['organisation_id','repository_id','security_domain_id']}, 'revision_id': 'sha256:'+'a'*64, 'root_tree_id': 'sha256:'+'b'*64, 'authority_epoch': '1', 'policy_version': 'closure-test'}
        packet = {'schema_version': 1, 'release_id': str(uuid.uuid4()), 'source': source, 'registry_sha256': closure.digest(root/'registry.json'), 'claims_sha256': closure.digest(root/'claims.json'), 'evidence': []}
        def refused(name, value, phrase):
            path = root / 'packet.json'; path.write_bytes(closure.canonical(value))
            try:
                closure.verify_packet(path, root/'registry.json', root/'claims.json')
            except closure.ClosureError as error:
                if phrase not in str(error):
                    raise AssertionError((name, str(error), phrase))
                checks.append(name)
            else:
                raise AssertionError(name+' unexpectedly passed')
        refused('missing-case', packet, 'Missing required')
        altered = copy.deepcopy(packet); altered['registry_sha256'] = '0'*64
        refused('stale-registry', altered, 'registry is stale')
        campaign = root/'campaign'; (campaign/'receipts').mkdir(parents=True)
        rid = str(uuid.uuid4())
        receipt = {'scope':'full-case','full_case_status':'PASS','case_ids':['SCM-024'],'expected_assertion_ids':['SCM-024.full'],'source':{'native':source}}
        receipt_path=campaign/'receipts'/(rid+'.json'); receipt_path.write_bytes(closure.canonical(receipt))
        (campaign/'manifest.json').write_bytes(closure.canonical({'policy':{'source_variant':'full'}}))
        entry = {'case_id':'SCM-024','variant':'full','campaign':str(campaign),'receipt_id':rid,'receipt_sha256':closure.digest(receipt_path)}
        candidate = {**packet,'evidence':[entry]}
        refused('fabricated-pass', candidate, 'Independent evidence checker refused')
        altered = copy.deepcopy(candidate); altered['evidence'].append(entry)
        refused('duplicate-variant', altered, 'duplicate case variant')
        altered = copy.deepcopy(candidate); altered['evidence'][0]['case_id']='SCM-999'
        refused('unknown-case', altered, 'Unknown or duplicate')
        altered = copy.deepcopy(candidate); altered['evidence'][0]['receipt_sha256']='0'*64
        refused('tampered-receipt', altered, 'receipt hash differs')
        receipt['scope']='task-component'; receipt_path.write_bytes(closure.canonical(receipt)); candidate['evidence'][0]['receipt_sha256']=closure.digest(receipt_path)
        refused('component-is-not-full-case', candidate, 'Component evidence')
        receipt['scope']='full-case'; receipt['source']['native']={**source,'policy_version':'old'}; receipt_path.write_bytes(closure.canonical(receipt)); candidate['evidence'][0]['receipt_sha256']=closure.digest(receipt_path)
        refused('stale-source', candidate, 'source or policy is stale')
        registry['cases']['SCM-024']['full_assertion_ids']=[]; (root/'registry.json').write_bytes(closure.canonical(registry)); candidate['registry_sha256']=closure.digest(root/'registry.json')
        refused('empty-assertion-inventory', candidate, 'Full assertion inventory is absent')
        actual = root / 'actual'; actual.mkdir()
        qspec = importlib.util.spec_from_file_location('closure_qualify', ROOT / 'tests/hyperfide/qualify.py')
        qualify = importlib.util.module_from_spec(qspec); qspec.loader.exec_module(qualify)
        fspec = importlib.util.spec_from_file_location('closure_campaign', ROOT / 'tests/hyperfide/source-control/campaign_fixture.py')
        fixture = importlib.util.module_from_spec(fspec); fspec.loader.exec_module(fixture)
        native, _, _, actual_registry = fixture.create_campaign(actual, qualify, 'full-case')
        run = subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/qualify.py'), '--root', str(actual), '--registry', str(actual/'registry.json'), '--manifest', str(actual/'manifest.json'), '--case', 'SCM-024'], capture_output=True, text=True, timeout=60)
        if run.returncode:
            raise AssertionError(run.stdout + run.stderr)
        summary = json.loads(run.stdout.splitlines()[-1])
        actual_claims = {'schema_version':1,'cases':{'SCM-024':{'requirement_clauses':['14.4'],'required_variants':['full']}}}
        (actual/'claims.json').write_bytes(closure.canonical(actual_claims))
        actual_receipt = Path(summary['campaign_dir'])/'receipts'/(summary['receipt_id']+'.json')
        actual_packet = {'schema_version':1,'release_id':str(uuid.uuid4()),'source':{field:native[field] for field in closure.IDENTITY},'registry_sha256':closure.digest(actual/'registry.json'),'claims_sha256':closure.digest(actual/'claims.json'),'evidence':[{'case_id':'SCM-024','variant':'full','campaign':summary['campaign_dir'],'receipt_id':summary['receipt_id'],'receipt_sha256':closure.digest(actual_receipt)}]}
        (actual/'packet.json').write_bytes(closure.canonical(actual_packet))
        result = closure.verify_packet(actual/'packet.json',actual/'registry.json',actual/'claims.json')
        if result['status'] != 'PASS' or len(result['checked_evidence']) != 1:
            raise AssertionError(result)
        checks.append('actual-qualifier-and-independent-checker')

    return {'schema_version':1,'status':'PASS','scope':'closure refusal boundaries; full product evidence is required separately','checks':checks}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test',action='store_true')
    parser.add_argument('--packet',default=os.environ.get('HF_SOURCE_CLOSURE_PACKET'))
    args=parser.parse_args()
    try:
        if args.self_test:
            report=self_test()
            for name in report['checks']:
                print(json.dumps({'type':'assertion','id':'source-closure.'+name,'expected':True,'actual':True}))
            print(json.dumps({'type':'cleanup','complete':True,'resources':[]}))
        else:
            if not args.packet:
                raise closure.ClosureError('HF_SOURCE_CLOSURE_PACKET or --packet must name the complete current native source evidence packet')
            report=closure.verify_packet(args.packet)
        if args.self_test:
            directory=ROOT/'build/source-control/6.3';directory.mkdir(parents=True,exist_ok=True)
            (directory/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report,sort_keys=True))
        return 0
    except (closure.ClosureError,OSError,ValueError,KeyError,TypeError) as error:
        print(json.dumps({'schema_version':1,'status':'BLOCKED','diagnostics':[str(error)]}))
        return 2

if __name__=='__main__':
    raise SystemExit(main())
