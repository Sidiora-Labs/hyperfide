#!/usr/bin/env python3
"""Independently observe the exact GitHub repository retained for the campaign."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[4]

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory',type=Path,required=True)
    parser.add_argument('--receipt',type=Path,default=ROOT/'build/source-control/github-canary/receipt.json')
    parser.add_argument('--prepare',action='store_true',help='Verify the private untouched repository before execution')
    args=parser.parse_args()
    inventory=json.loads(args.inventory.read_text());resource=inventory['resource']
    result=subprocess.run(['gh','api','repos/'+resource['repository']],text=True,capture_output=True,check=True,timeout=30)
    observed=json.loads(result.stdout)
    assert observed['id']==resource['repository_id'] and observed['full_name']==resource['repository']
    assert observed['private'] is True and observed['owner']['login']==resource['owner']
    assert dt.datetime.fromisoformat(resource['expiry'].replace('Z','+00:00'))>dt.datetime.now(dt.timezone.utc)
    if args.prepare:
        refs=subprocess.run(['gh','api','repos/'+resource['repository']+'/branches'],text=True,capture_output=True,check=True,timeout=30)
        assert json.loads(refs.stdout)==[], 'Canonical canary must be untouched'
    else:
        receipt=json.loads(args.receipt.read_text())
        assert receipt['status']=='PASS' and receipt['repository']==resource['repository']
        retained=receipt['cleanup']['resources'];assert len(retained)==1 and retained[0]==dict(resource,status='retained')
        head=subprocess.run(['gh','api','repos/'+resource['repository']+'/git/ref/heads/main'],text=True,capture_output=True,check=True,timeout=30)
        assert json.loads(head.stdout)['object']['sha']==receipt['head'].removeprefix('git:sha1:')
    print(json.dumps({'status':'PASS','observation':'private GitHub resource retained','resource':resource}))

if __name__=='__main__':main()
