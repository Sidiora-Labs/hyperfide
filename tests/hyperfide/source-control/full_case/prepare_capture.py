#!/usr/bin/env python3
"""Capture reviewed implementation files in one genuine native source snapshot."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[4]

def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    choice=parser.add_mutually_exclusive_group()
    choice.add_argument('--registration',type=Path,default=ROOT/'tests/hyperfide/source-control/registrations/full-SCM-023-owned-api-cli-ui.json')
    choice.add_argument('--all-full',action='store_true',help='Union every reviewed full-case source file and source-root inventory after freeze')
    args=parser.parse_args()
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
    q=load('source_qualifier',ROOT/'tests/hyperfide/qualify.py')
    registry_path=ROOT/'tests/hyperfide/source-control/registry.json'
    _,variants=q.load_registry(registry_path)
    if args.all_full:
        selected=[(name,record) for name,(record,_) in variants.items() if record['scope']=='full-case']
    else:
        target=args.registration.resolve()
        if not target.is_relative_to(ROOT/'tests/hyperfide/source-control/registrations'):
            parser.error('Use a repository-reviewed full-case registration')
        selected=[(name,record) for name,(record,filename) in variants.items() if filename.resolve()==target]
    if not selected:parser.error('No reviewed full-case registrations selected')
    def inventory():
        files=set()
        for _,record in selected:
            files.update(record['source_files'])
            if args.all_full:
                files.update(Path(item['original_path']).relative_to(ROOT).as_posix() for item in q.source_inventory(ROOT,record,ROOT/'build'))
        if len(files)>50000:raise ValueError('Shared source capture exceeds its file bound')
        total=0;result={}
        for relative in sorted(files):
            filename=ROOT/relative
            if Path(relative).is_absolute() or '..' in Path(relative).parts or filename.resolve()!=filename or filename.is_symlink() or not filename.is_file():raise ValueError('Invalid reviewed source path: '+relative)
            if any(part in ('.env','id_rsa','id_ed25519') for part in Path(relative).parts):raise ValueError('Private source path refused: '+relative)
            data=filename.read_bytes();total+=len(data)
            if len(data)>128*1024*1024 or total>512*1024*1024:raise ValueError('Shared source capture exceeds its byte bound')
            result[relative]=q.digest(data)
        return result
    for _,record in selected:q.verify_status_contracts(ROOT,record)
    before=inventory();registry_hash=q.digest(registry_path.read_bytes())
    assertion_ids=sorted({item for _,record in selected for item in record['assertion_ids']}) if args.all_full else selected[0][1]['assertion_ids']
    planned={'feature':'hyperfide-source-control','scope':'full-case','source_files':list(before),'source_hashes':before,'assertion_ids':assertion_ids,'variants':[name for name,_ in selected]}
    directory=ROOT/'build/source-control/full-case/capture-plans';directory.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-plan-',dir=directory) as temporary:
        plan=Path(temporary)/'plan.json';plan.write_bytes(q.canonical(planned));plan.chmod(0o600)
        result_path=Path(temporary)/'result.json'
        os.environ['HF_SOURCE_CAPTURE_REGISTRATION']=str(plan)
        os.environ['HF_SOURCE_CAPTURE_RESULT']=str(result_path)
        os.environ['HF_SOURCE_CAPTURE_TOOLCHAIN']=json.dumps([sys.executable,shutil.which('git'),'/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell'])
        fixture=load('source_fixture',ROOT/'tests/hyperfide/support/native_source_fixture.py')
        result=fixture.run_source_actor(Path(__file__).with_suffix('.mjs'),migrations=['0736-source-control-storage.sql','0737-source-control-metadata.sql','0738-source-control-capabilities.sql','0739-source-control-workspaces.sql','0740-source-control-transformations.sql','0741-source-control-acceptance.sql','0743-source-control-assurance.sql'],timeout=1800)
        if result:return result
        for _,record in selected:q.verify_status_contracts(ROOT,record)
        if before!=inventory() or registry_hash!=q.digest(registry_path.read_bytes()):raise ValueError('Reviewed source inventory changed during capture')
        note=json.loads(result_path.read_text());native=json.loads(Path(note['native_source_path']).read_text());q.native_capture(ROOT,native,assertion_ids)
        note.update(shared=args.all_full,variants=planned['variants'],registry_sha256=registry_hash)
        (Path(note['native_source_path']).parent/'capture.json').write_bytes(q.canonical(note)+b'\n')
        print(json.dumps(note,sort_keys=True));return 0

if __name__=='__main__':
    raise SystemExit(main())
