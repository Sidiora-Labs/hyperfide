#!/usr/bin/env python3
"""Qualify source-backed sparse workspaces and the declared Linux FUSE profile."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',choices=['SCM-010','SCM-011'],required=True)
    parser.add_argument('--full',action='store_true')
    args=parser.parse_args()
    definitions=json.loads(Path(__file__).with_name('workspace_cases.json').read_text())
    selected=definitions[args.case]
    output=ROOT/'build/source-control/full-case'/args.case
    if args.full:output=output/'full'
    output.mkdir(parents=True,exist_ok=True)
    env={key:value for key,value in os.environ.items() if key not in ['DATABASE_URL','HYPERFIDE_SOURCE_CONTROL_TEST_PROFILE','HYPERFIDE_VIRTUAL_COMPONENT']}
    reports={}
    for name in selected['drivers']:
        definition=definitions['drivers'][name]
        command=[sys.executable,str(ROOT/definition['path'])]
        started=__import__('time').time_ns()
        result=subprocess.run(command,cwd=ROOT,env=env,text=True,capture_output=True,timeout=600)
        log=result.stdout+result.stderr
        (output/(name+'.log')).write_text(log)
        if result.returncode:
            sys.stderr.write(log[-20000:])
            raise RuntimeError(name+' failed; no full-case assertions emitted')
        source=ROOT/definition['receipt']
        if not source.is_file() or source.stat().st_mtime_ns<started:
            raise RuntimeError('Fresh execution receipt is missing: '+name)
        report=json.loads(source.read_text())
        if report.get('status')!='PASS' or (report.get('storage_backend') or report.get('backend'))!='REAL_S3':
            raise RuntimeError('Actual configured S3 qualification required: '+name)
        if name=='virtual' and (report.get('profile')!='linux-fuse7-source-v1' or not report.get('kernel')):
            raise RuntimeError('Actual declared Linux FUSE profile required')
        reports[name]={'report':report,'log_sha256':hashlib.sha256(log.encode()).hexdigest()}
    assertions=[]
    for item in selected['assertions']:
        report=reports[item['driver']]['report']
        present=item.get('check') in report.get('checks',[]) if 'check' in item else any(row.get('id')==item['assertion'] and row.get('outcome')=='PASS' for row in report.get('assertions',[]))
        if not present:raise RuntimeError('Missing executed workspace assertion: '+item['id'])
        assertions.append({'type':'assertion','id':item['id'],'expected':True,'actual':True})
    receipt={'schema_version':1,'case':args.case,'status':'PASS','execution_profile':selected['profile'],'assertions':assertions,'runs':reports,'retained_objects':'Exact owned S3 placements are recorded in each task receipt; no unrelated objects are removed.'}
    (output/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    for assertion in assertions:print(json.dumps(assertion),flush=True)
    print(json.dumps({'type':'cleanup','complete':True,'resources':[]}),flush=True)
    return 0
if __name__=='__main__':
    raise SystemExit(main())
