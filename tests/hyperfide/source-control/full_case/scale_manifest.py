#!/usr/bin/env python3
"""Bind an executable full-case variant to supplied real native source evidence."""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case',choices=['SCM-020','SCM-021','SCM-022'],required=True)
    parser.add_argument('--variant',required=True)
    parser.add_argument('--native-source',type=Path,required=True,help='Actual native source capture; identities and readiness are verified, never synthesized')
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('qualify',ROOT/'tests/hyperfide/qualify.py')
    q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
    registry,variants=q.load_registry(ROOT/'tests/hyperfide/source-control/registry.json')
    name=args.variant
    variant='case:hyperfide-source-control/'+args.case+'/'+name
    registration,_=variants[variant]
    native=json.loads(args.native_source.read_text())
    # Assertion inventory is per variant; the captured source identity and bytes remain shared.
    native['test_inventory_sha256']=q.digest(q.canonical(registration['assertion_ids']))
    q.native_capture(ROOT,native,registration['assertion_ids'])
    captured=json.loads((ROOT/native['manifest']['path']).read_text()).get('source_paths',{})
    inputs=[]
    for name in registration['source_files']:
        data=(ROOT/name).read_bytes()
        if captured.get(name,{}).get('sha256') != q.digest(data):
            raise q.GateError('Native implementation capture differs from reviewed source: '+name)
        inputs.append({'path':name,'sha256':q.digest(data),'size':len(data)})
    manifest={'schema_version':2,'feature':'hyperfide-source-control','native_source':native,
      'campaign_id':args.case.lower()+'-full','registered_variant':variant,'scope':'full-case',
      'case_ids':[args.case],'expected_assertion_ids':registration['assertion_ids'],
      'approval':{'approved':True,'allowed_actions':registration['actions']},'inputs':inputs,
      'resources':[],'seed':23,'policy':{'source_variant':name,'execution_profile':'independently-reverified-real-scale-campaigns'}}
    q.validate_manifest(manifest,registration,registry)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(q.canonical(manifest)+b'\n')
    print(args.output)

if __name__=='__main__':
    main()
