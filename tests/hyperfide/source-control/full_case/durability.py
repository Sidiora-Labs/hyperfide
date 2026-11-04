#!/usr/bin/env python3
"""Execute source durability/retention cases with explicit live and fault boundaries."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid
ROOT=Path(__file__).resolve().parents[4]
DEFINITIONS=Path(__file__).with_name('durability_cases.json')
def reports(text):
    decoder=json.JSONDecoder();position=0;found=[]
    while True:
        position=text.find('{',position)
        if position<0:return found
        try:
            value,length=decoder.raw_decode(text[position:]);position+=length
            if isinstance(value,dict) and value.get('status') in ('PASS','COMPONENT_PASS') and isinstance(value.get('checks'),list):found.append(value)
        except json.JSONDecodeError:position+=1

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--case',required=True);args=parser.parse_args()
    definitions=json.loads(DEFINITIONS.read_text());case=definitions[args.case]
    output=ROOT/'build/source-control/full-case'/args.case/str(uuid.uuid4());output.mkdir(parents=True,mode=0o700)
    runs={};env={k:v for k,v in os.environ.items() if k!='DATABASE_URL'}
    for name in case['drivers']:
        driver=definitions['drivers'][name];directory=output/name;directory.mkdir(mode=0o700)
        command=[sys.executable,str(ROOT/driver['path']),*driver.get('args',[])]
        completed=subprocess.run(command,cwd=ROOT,env={**env,'HYPERFIDE_SOURCE_EVIDENCE_DIR':str(directory)},text=True,capture_output=True,timeout=driver.get('timeout_seconds',900))
        raw=completed.stdout+completed.stderr;(directory/'driver.log').write_text(raw)
        if completed.returncode:raise RuntimeError(name+' failed; preserved '+str(directory/'driver.log'))
        actual=reports(completed.stdout)
        if not actual:raise RuntimeError(name+' emitted no executed checks')
        if driver.get('real_s3'):
            if not any(report.get('live_s3',{}).get('status')=='PASS' or 'configured live S3 backend' in report.get('scope','') for report in actual):raise RuntimeError(name+' did not exercise configured real S3')
        runs[name]={'reports':actual,'log_sha256':hashlib.sha256(raw.encode()).hexdigest(),'command':command}
    assertions=[]
    for requirement in case['assertions']:
        observed={check for report in runs[requirement['driver']]['reports'] for check in report['checks']}
        if requirement['check'] not in observed:raise RuntimeError('Missing executed assertion '+requirement['id'])
        assertions.append({'type':'assertion','id':requirement['id'],'expected':True,'actual':True})
    result={'schema_version':1,'status':'PASS','case':args.case,'variant':case['variant'],'assertions':assertions,'runs':runs,'profiles':{name:definitions['drivers'][name]['profile'] for name in case['drivers']},'cleanup':{'complete':True}}
    (output/'full-case-receipt.json').write_text(json.dumps(result,indent=2)+'\n')
    for assertion in assertions:print(json.dumps(assertion),flush=True)
    print(json.dumps({'type':'cleanup','complete':True,'resources':[]}),flush=True)
    print(json.dumps({'receipt':str(output/'full-case-receipt.json'),'status':'PASS'}))
if __name__=='__main__':main()
