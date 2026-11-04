#!/usr/bin/env python3
"""Bind an actual native implementation capture to a workspace full-case variant."""
import argparse
import importlib.util
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',choices=['SCM-010','SCM-011'],required=True)
    parser.add_argument('--full',action='store_true')
    parser.add_argument('--native-source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('qualify',ROOT/'tests/hyperfide/qualify.py')
    q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
    registry,variants=q.load_registry(ROOT/'tests/hyperfide/source-control/registry.json')
    name='source-backed-sparse-real-s3' if args.case=='SCM-010' else 'linux-fuse7-real-s3'
    variant='case:hyperfide-source-control/'+args.case+'/'+('full' if args.full else name)
    registration,_=variants[variant]
    native=json.loads(args.native_source.read_text())
    native['test_inventory_sha256']=q.digest(q.canonical(registration['assertion_ids']))
    q.native_capture(ROOT,native,registration['assertion_ids'])
    captured=json.loads((ROOT/native['manifest']['path']).read_text()).get('source_paths',{})
    inputs=[]
    for relative in registration['source_files']:
        data=(ROOT/relative).read_bytes()
        if captured.get(relative,{}).get('sha256')!=q.digest(data):raise q.GateError('Native implementation capture differs: '+relative)
        inputs.append({'path':relative,'sha256':q.digest(data),'size':len(data)})
    manifest={'schema_version':2,'feature':'hyperfide-source-control','native_source':native,'campaign_id':args.case.lower()+'-'+name,'registered_variant':variant,'scope':'full-case','case_ids':[args.case],'expected_assertion_ids':registration['assertion_ids'],'approval':{'approved':True,'allowed_actions':registration['actions']},'inputs':inputs,'resources':[],'seed':int(args.case[-3:]),'policy':{'source_variant':('full' if args.full else name),'execution_profile':name}}
    q.validate_manifest(manifest,registration,registry)
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(q.canonical(manifest)+b'\n')
    print(args.output)
