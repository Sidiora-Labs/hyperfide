#!/usr/bin/env python3
"""Supervise an owned real campaign with a pinned local runner and durable restart state."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import time
ROOT=Path(__file__).resolve().parents[3]
def private(path):
    path=Path(path);stat=path.lstat()
    if not path.is_absolute() or path.is_symlink() or not path.is_file() or stat.st_mode&0o077:raise RuntimeError('Private regular configuration required')
    return json.loads(path.read_text())
def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as source:
        for block in iter(lambda:source.read(1024*1024),b''):h.update(block)
    return 'sha256:'+h.hexdigest()
def atomic(path,value):
    temporary=path.with_suffix(path.suffix+'.tmp');temporary.write_text(json.dumps(value,indent=2)+'\n');temporary.chmod(0o600);temporary.replace(path)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',required=True,type=Path);parser.add_argument('--config',required=True,type=Path);parser.add_argument('--sdk-root',required=True,type=Path);parser.add_argument('--node',required=True,type=Path);args=parser.parse_args()
    manifest=private(args.manifest);config=private(args.config);directory=Path(config['output_directory']);directory.mkdir(parents=True,mode=0o700,exist_ok=True)
    lock=open(directory/'supervisor.lock','a+');os.chmod(lock.name,0o600);fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    runner=directory/'runner';pins=directory/'runner-manifest.json'
    if not pins.exists():
        if runner.exists():raise RuntimeError('Unpinned runner directory exists')
        support=runner/'tests/hyperfide/support';support.mkdir(parents=True,mode=0o700)
        shutil.copytree(ROOT/'tests/hyperfide/source-control/workloads',runner/'tests/hyperfide/source-control/workloads')
        for name in ['native_source_external_workload.mjs','native_source_campaign_verify.mjs','native_source_campaign_observer.mjs','native_source_campaign_collect.mjs']:
            shutil.copyfile(ROOT/'tests/hyperfide/support'/name,support/name)
        shutil.copytree(args.sdk_root,runner/'sdk')
        files={str(path.relative_to(runner)):digest(path) for path in runner.rglob('*') if path.is_file()}
        atomic(pins,{'schema_version':1,'node':str(args.node),'node_digest':digest(args.node),'files':files,'manifest_digest':digest(args.manifest),'configuration_digest':digest(args.config)})
    snapshot=private(pins)
    def validate():
        if snapshot['node_digest']!=digest(args.node) or snapshot['manifest_digest']!=digest(args.manifest) or snapshot['configuration_digest']!=digest(args.config):raise RuntimeError('Pinned campaign launch inputs changed')
        for name,expected in snapshot['files'].items():
            if digest(runner/name)!=expected:raise RuntimeError('Pinned campaign runner changed: '+name)
    env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LANG':'C.UTF-8','HF_SOURCE_WORKLOAD_CONFIG':str(args.config),'HF_SOURCE_WORKLOAD_MANIFEST':str(args.manifest),'SOURCE_CONTROL_SDK_MODULE_ROOT':str(runner/'sdk')}
    hooks=[config['observer'],manifest.get('canary'),*manifest.get('drills',[])]
    for hook in hooks:
        if hook:
            for key in hook.get('env_keys',[]):
                value=config.get('hook_environment',{}).get(key,os.environ.get(key))
                if not isinstance(value,str) or not value:raise RuntimeError('Required hook environment unavailable: '+key)
                env[key]=value
    stopped=False;child=None
    def stop(signum,_frame):
        nonlocal stopped
        stopped=True
        if child and child.poll() is None:child.send_signal(signum)
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    attempt=0;verify=False
    if (directory/'campaign-state.sqlite').exists():
        with sqlite3.connect('file:'+str(directory/'campaign-state.sqlite')+'?mode=ro',uri=True) as database:
            row=database.execute("SELECT value FROM meta WHERE key='status'").fetchone();verify=bool(row and json.loads(row[0])=='PASS')
    with open(directory/'supervisor.log','ab',buffering=0) as log:
        os.chmod(log.name,0o600)
        while not stopped:
            validate();launch={**env}
            if verify:launch['HF_SOURCE_WORKLOAD_VERIFY_ONLY']='1'
            child=subprocess.Popen([str(args.node),str(runner/'tests/hyperfide/support/native_source_external_workload.mjs')],env=launch,stdout=log,stderr=subprocess.STDOUT,pass_fds=(lock.fileno(),))
            atomic(directory/'supervisor.json',{'schema_version':1,'pid':os.getpid(),'child_pid':child.pid,'phase':'VERIFYING' if verify else 'RUNNING','attempt':attempt,'started_at':time.time(),'runner_manifest':str(pins)})
            while True:
                try:code=child.wait(timeout=30);break
                except subprocess.TimeoutExpired:atomic(directory/'supervisor.json',{'schema_version':1,'pid':os.getpid(),'child_pid':child.pid,'phase':'VERIFYING' if verify else 'RUNNING','attempt':attempt,'heartbeat_at':time.time()})
            if stopped:break
            if code==0:
                if not verify:verify=True;continue
                atomic(directory/'supervisor.json',{'schema_version':1,'pid':os.getpid(),'phase':'PASS','finished_at':time.time()});return 0
            state=directory/'campaign-state.sqlite'
            with sqlite3.connect('file:'+str(state)+'?mode=ro',uri=True) as database:
                row=database.execute("SELECT value FROM meta WHERE key='status'").fetchone();status=json.loads(row[0]) if row else 'UNKNOWN'
            if status not in ('RUNNING','PAUSED','FINALIZING'):raise RuntimeError('Campaign stopped with explicit '+status+'; inspect retained evidence')
            attempt+=1;time.sleep(min(30,attempt*2))
    atomic(directory/'supervisor.json',{'schema_version':1,'pid':os.getpid(),'phase':'PAUSED','finished_at':time.time()});return 130
if __name__=='__main__':raise SystemExit(main())
