#!/usr/bin/env python3
"""Bind the reviewed GitHub campaign and exact retained repository to a native capture."""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[4]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-source',type=Path,required=True)
    parser.add_argument('--inventory',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    spec=importlib.util.spec_from_file_location('qualify',ROOT/'tests/hyperfide/qualify.py');q=importlib.util.module_from_spec(spec);spec.loader.exec_module(q)
    registry,variants=q.load_registry(ROOT/'tests/hyperfide/source-control/registry.json');variant='case:hyperfide-source-control/SCM-015/github';registration,_=variants[variant]
    native=json.loads(args.native_source.read_text());native['test_inventory_sha256']=q.digest(q.canonical(registration['assertion_ids']));q.native_capture(ROOT,native,registration['assertion_ids'])
    captured=json.loads((ROOT/native['manifest']['path']).read_text()).get('source_paths',{});inputs=[]
    for relative in registration['source_files']:
        data=(ROOT/relative).read_bytes()
        if captured.get(relative,{}).get('sha256')!=q.digest(data):raise q.GateError('Shared native implementation differs: '+relative)
        inputs.append({'path':relative,'sha256':q.digest(data),'size':len(data)})
    inventory_path=args.inventory.resolve();relative=inventory_path.relative_to(ROOT).as_posix();data=inventory_path.read_bytes();inventory=json.loads(data)
    if [inventory['resource']]!=registration['resources'] or relative not in registration.get('fixtures',[]):raise q.GateError('GitHub resource differs from pinned registration')
    inputs.append({'path':relative,'sha256':q.digest(data),'size':len(data)})
    manifest={'schema_version':2,'feature':'hyperfide-source-control','native_source':native,'campaign_id':'scm-015-github','registered_variant':variant,'scope':'full-case','case_ids':['SCM-015'],'expected_assertion_ids':registration['assertion_ids'],'approval':{'approved':True,'allowed_actions':registration['actions'],'allow_retained_resources':True},'inputs':inputs,'resources':registration['resources'],'seed':15,'policy':{'source_variant':'github','execution_profile':'private-unprotected-main','github_inventory':{'path':relative,'sha256':q.digest(data)}}}
    q.validate_manifest(manifest,registration,registry);args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(q.canonical(manifest)+b'\n');print(args.output)

if __name__=='__main__':main()
