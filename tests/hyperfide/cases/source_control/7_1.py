#!/usr/bin/env python3
"""Build twice, verify, and run the extracted native source release package."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[4]
OUT=ROOT/'build/source-control/7.1'

def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def verify(directory):
    manifest=json.loads((directory/'runtime-manifest.json').read_text())
    inputs=manifest.get('input_manifest')
    if not isinstance(inputs,dict) or hashlib.sha256(json.dumps(inputs,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()!=manifest['source_inputs_sha256']:
        raise AssertionError('Package source input closure differs')
    files=manifest['files']
    actual={path.relative_to(directory).as_posix() for path in directory.rglob('*') if (path.is_file() or path.is_symlink()) and path.relative_to(directory).as_posix()!='runtime-manifest.json'}
    if actual!=set(files):raise AssertionError('Package file inventory differs')
    for name,record in files.items():
        path=directory/name
        if record['kind']=='symlink':
            if not path.is_symlink() or os.readlink(path)!=record['target'] or not path.resolve().is_relative_to(directory):raise AssertionError('Unsafe package dependency link')
        elif path.is_symlink() or not path.is_file() or digest(path)!=record['sha256'] or path.stat().st_size!=record['size'] or (path.stat().st_mode&0o777)!=record['mode']:
            raise AssertionError('Package artifact differs: '+name)
    return manifest

def guard_checks():
    spec=importlib.util.spec_from_file_location('source_package',ROOT/'deploy/hyperfide/source-control/package.py')
    package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)
    with tempfile.TemporaryDirectory(prefix='hf-package-guards-') as temporary:
        root=Path(temporary);service=root/'service'
        for name in ['dist','components','migrations']:(service/name).mkdir(parents=True)
        (service/'dist/.source-digest.json').write_text('{}');component=service/'components/a.json';component.write_text('{}');migration=service/'migrations/a.sql';migration.write_text('SELECT 1;')
        before=package.input_digest(service);component.write_text('{"changed":true}')
        if before==package.input_digest(service):raise AssertionError('Component bytes missing from package input closure')
        before=package.input_digest(service);migration.write_text('SELECT 2;')
        if before==package.input_digest(service):raise AssertionError('Migration bytes missing from package input closure')
        source=root/'dependency';source.mkdir();outside=root/'outside';outside.write_text('private canary');(source/'alias').symlink_to(outside)
        try:package.tree_records(source)
        except RuntimeError:pass
        else:raise AssertionError('External dependency link would copy outside bytes')
    return ['component and migration input drift refused','outside dependency symlink refused']

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--package-only',action='store_true');parser.add_argument('--service-root');parser.add_argument('--package-dir',help='Verify and smoke an already assembled package');args=parser.parse_args()
    if not args.package_only and not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
    node=Path(os.environ.get('HYPERFIDE_NODE_BINARY','/root/.nvm/versions/node/v24.22.0/bin/node')).resolve()
    OUT.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='hf-source-release-build-') as temporary:
        work=Path(temporary);records=[]
        if args.package_dir:
            existing=Path(args.package_dir).resolve()
            record=json.loads((existing/'package-manifest.json').read_text())
            archive_source=existing/record['artifact']['path']
            if digest(archive_source)!=record['artifact']['sha256'] or archive_source.stat().st_size!=record['artifact']['size']:
                raise AssertionError('Assembled package checksum differs')
            (work/'first').mkdir()
            shutil.copyfile(archive_source,work/'first'/archive_source.name)
            shutil.copyfile(existing/'package-manifest.json',work/'first/package-manifest.json')
            records=[record,record]
        else:
            for name in ['first','second']:
                directory=work/name
                result=subprocess.run([sys.executable,str(ROOT/'deploy/hyperfide/source-control/package.py'),'--output',str(directory),'--node',str(node),*(['--service-root',args.service_root] if args.service_root else [])],cwd=ROOT,text=True,capture_output=True,timeout=300)
                if result.returncode:raise RuntimeError(result.stdout+result.stderr)
                records.append(json.loads(result.stdout.splitlines()[-1]))
        for name,record in zip(['first','second'],records):
            (OUT/('package-'+name+'.json')).write_text(json.dumps(record,indent=2)+'\n')
        if records[0]!=records[1]:
            if records[0]['source_inputs_sha256']!=records[1]['source_inputs_sha256']:
                raise AssertionError('Runtime source changed between reproducibility builds')
            details=[]
            manifests=[]
            for name in ['first','second']:
                with tarfile.open(work/name/'native-source-runtime.tar.gz') as bundle:
                    manifests.append(json.load(bundle.extractfile('runtime-manifest.json')))
            for name in sorted(set(manifests[0]['files'])|set(manifests[1]['files'])):
                if manifests[0]['files'].get(name)!=manifests[1]['files'].get(name):details.append(name)
            raise AssertionError('Same release inputs did not reproduce package files: '+', '.join(details[:20]))
        destination=OUT/'artifacts'/records[0]['artifact']['sha256'];destination.mkdir(parents=True,exist_ok=True)
        for name in [records[0]['artifact']['path'],'package-manifest.json']:
            target=destination/name
            if target.exists() and target.read_bytes()!=(work/'first'/name).read_bytes():raise AssertionError('Existing immutable release artifact differs')
            shutil.copyfile(work/'first'/name,target)
        archive=work/'first'/records[0]['artifact']['path'];runtime=work/'runtime';runtime.mkdir()
        with tarfile.open(archive) as bundle:bundle.extractall(runtime,filter='data')
        manifest=verify(runtime)
        env={**os.environ,'PATH':str(runtime/'bin')+':'+os.environ.get('PATH',''),'LD_LIBRARY_PATH':str(runtime/'lib/hyperfide'),'HF_SOURCE_PACKAGE_ROOT':str(runtime)}
        if subprocess.check_output([str(runtime/'runtime/node'),'--version'],env=env,text=True).strip()!=manifest['node_version']:raise AssertionError('Packaged Node version differs')
        checks=[*guard_checks(),*(['reproducible archive bytes'] if not args.package_dir else []),'complete package checksums and internal dependency links','packaged pinned Node runtime']
        if not args.package_only:
            result=subprocess.run([str(runtime/'runtime/node'),str(ROOT/'tests/hyperfide/support/native_source_package_smoke.mjs')],cwd=runtime,env=env,text=True,capture_output=True,timeout=300)
            if result.returncode:raise RuntimeError(result.stdout+result.stderr)
            smoke=json.loads(result.stdout.splitlines()[-1]);checks.extend(smoke['checks'])
        destination=OUT/'artifacts'/records[0]['artifact']['sha256'];destination.mkdir(parents=True,exist_ok=True)
        for name in [records[0]['artifact']['path'],'package-manifest.json']:
            target=destination/name
            if target.exists() and target.read_bytes()!=(work/'first'/name).read_bytes():raise AssertionError('Existing immutable release artifact differs')
            shutil.copyfile(work/'first'/name,target)
        report={'schema_version':1,'status':'PASS','scope':'packaged native source component' if not args.package_only else 'package assembly only','checks':checks,'artifact':str(destination/records[0]['artifact']['path']),'artifact_sha256':records[0]['artifact']['sha256'],'files':len(manifest['files'])}
        (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
    return 0
if __name__=='__main__':
    try:
        raise SystemExit(main())
    except (RuntimeError,AssertionError,OSError,ValueError,subprocess.SubprocessError) as error:
        OUT.mkdir(parents=True,exist_ok=True)
        report={'schema_version':1,'status':'FAIL','scope':'packaged native source component','diagnostics':[str(error)]}
        (OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
        raise SystemExit(1)
