#!/usr/bin/env python3
"""Assemble a content-pinned, reproducible native source runtime."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile

ROOT=Path(__file__).resolve().parents[3]
EXCLUDED={'.git','.env','__pycache__'}

def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
def digest(path):
    result=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda:stream.read(1048576),b''):result.update(data)
    return result.hexdigest()
def file_record(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):raise RuntimeError('Regular runtime input required: '+str(path))
        hasher=hashlib.sha256()
        with os.fdopen(os.dup(fd),'rb') as source:
            for data in iter(lambda:source.read(1048576),b''):hasher.update(data)
        after=os.fstat(fd)
        if (info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise RuntimeError('Runtime input changed while hashing')
        return {'kind':'file','sha256':hasher.hexdigest(),'size':info.st_size,'mode':stat.S_IMODE(info.st_mode)}
    finally:os.close(fd)
def excluded(name,exclude):return name in exclude or name.startswith('.env.')
def tree_records(root,exclude=EXCLUDED):
    root=Path(root).resolve();records={}
    if not root.is_dir():raise RuntimeError('Missing runtime tree: '+str(root))
    for directory,dirs,files in os.walk(root,followlinks=False):
        for name in sorted(dirs+files):
            if excluded(name,exclude):
                if name in dirs:dirs.remove(name)
                continue
            path=Path(directory)/name;relative=path.relative_to(root).as_posix();info=path.lstat()
            if stat.S_ISLNK(info.st_mode):
                if not path.resolve().is_relative_to(root) or not path.exists():raise RuntimeError('Runtime tree link escapes its package: '+relative)
                records[relative]={'kind':'symlink','target':os.readlink(path)}
                if name in dirs:dirs.remove(name)
            elif stat.S_ISDIR(info.st_mode):records[relative]={'kind':'directory','mode':stat.S_IMODE(info.st_mode)}
            elif stat.S_ISREG(info.st_mode):records[relative]=file_record(path)
            else:raise RuntimeError('Unsupported runtime input: '+relative)
    return records

def safe_tree(source,target,expected,exclude=EXCLUDED):
    if tree_records(source,exclude)!=expected:raise RuntimeError('Runtime tree changed before copying')
    shutil.copytree(source,target,symlinks=True,ignore=lambda _,names:[name for name in names if excluded(name,exclude)])
    if tree_records(target,exclude)!=expected:raise RuntimeError('Copied runtime tree differs from its input pins')

def safe_copy(source,target,expected,mode=None):
    target.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):raise RuntimeError('Regular runtime input required')
        with os.fdopen(os.dup(fd),'rb') as stream,target.open('wb') as output:
            shutil.copyfileobj(stream,output,1048576)
        after=os.fstat(fd)
        if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns) or digest(target)!=expected['sha256'] or target.stat().st_size!=expected['size']:
            raise RuntimeError('Runtime input changed during copying')
    finally:os.close(fd)
    target.chmod(mode if mode is not None else (0o755 if expected['mode']&0o111 else 0o644))
DEPENDENCIES=r'''
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root=process.argv[1],pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),graph={},entries={};
function resolve(name,base){const req=createRequire(path.join(base,'package.json'));for(const dir of req.resolve.paths(name)??[]){const file=path.join(dir,name,'package.json');if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name)return fs.realpathSync(file)}try{const file=req.resolve(name+'/package.json');if(JSON.parse(fs.readFileSync(file)).name)return fs.realpathSync(file)}catch{}let p=path.dirname(req.resolve(name));for(;;){const file=path.join(p,'package.json');if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).name)return fs.realpathSync(file);const parent=path.dirname(p);if(parent===p)throw Error('Missing named package '+name);p=parent}}
function visit(file){if(graph[file])return;const pkg=JSON.parse(fs.readFileSync(file)),deps={};graph[file]={name:pkg.name,version:pkg.version,deps};for(const name of Object.keys({...pkg.dependencies,...pkg.optionalDependencies,...pkg.peerDependencies}).sort()){try{const child=resolve(name,path.dirname(file));deps[name]=child;visit(child)}catch(error){if(!pkg.optionalDependencies?.[name]&&!pkg.peerDependenciesMeta?.[name]?.optional)throw error}}}
for(const name of Object.keys(pkg.dependencies).sort()){const file=resolve(name,root);entries[name]=file;visit(file)}
console.log(JSON.stringify({entries,graph}));
'''

def input_inventory(service,files=None,trees=None,values=None):
    records={}
    for name in ['dist','components','migrations']:
        records.update({'service/'+name+'/'+key:value for key,value in tree_records(Path(service)/name).items()})
    for name in ['package.json','package-lock.json']:
        if (Path(service)/name).is_file():records['service/'+name]=file_record(Path(service)/name)
    for label,path in (files or {}).items():records[label]=file_record(path)
    for label,(path,exclude) in (trees or {}).items():records.update({label+'/'+key:value for key,value in tree_records(path,exclude).items()})
    for label,value in (values or {}).items():records[label]={'kind':'value','sha256':hashlib.sha256(canonical(value)).hexdigest()}
    return records

def input_digest(service):return hashlib.sha256(canonical(input_inventory(service))).hexdigest()

def native_ready():
    if subprocess.run(['make','-q','hyperfide'],cwd=ROOT,capture_output=True).returncode:raise RuntimeError('Native CLI is stale; build hyperfide before packaging')
    native=ROOT/'build/hyperfide-native';sources=[ROOT/'Makefile',ROOT/'tools/repository/hyperfide-native-components.py']
    sources.extend(path for path in (ROOT/'core/native/src').rglob('*') if path.is_file() and path.suffix in ('.c','.h','.json'))
    if not native.is_file() or any(path.stat().st_mtime_ns>native.stat().st_mtime_ns for path in sources):raise RuntimeError('Native components are stale; build hyperfide-native before packaging')
    expected=json.loads(subprocess.check_output(['python3',str(ROOT/'tools/repository/hyperfide-native-components.py'),'--link-contract'],cwd=ROOT))
    if expected!=json.loads((ROOT/'build/hyperfide-native-link-contract.json').read_text()):raise RuntimeError('Native component link contract differs')

def build(output,node,service_root=None):
    if platform.system()!='Linux':raise RuntimeError('Native source runtime package profile requires Linux')
    service=Path(service_root).resolve() if service_root else ROOT/'core/control-plane'
    stamp_command=[str(node),str(ROOT/'deploy/hyperfide/dist-stamp.mjs'),'check',str(service)]
    subprocess.run(stamp_command,check=True,capture_output=True);native_ready()
    if subprocess.check_output([str(node),'--version'],text=True).strip()!='v'+json.loads((service/'package.json').read_text())['engines']['node']:raise RuntimeError('Pinned Node runtime required')
    resolved=subprocess.run([str(node),'-e',DEPENDENCIES,str(service)],text=True,capture_output=True)
    if resolved.returncode:raise RuntimeError('Production dependency closure failed: '+resolved.stderr[-1200:])
    graph=json.loads(resolved.stdout)
    items=sorted(graph['graph'],key=lambda filename:(graph['graph'][filename]['name'],graph['graph'][filename]['version'],filename))
    allowed=[(ROOT/'node_modules').resolve(),(ROOT/'core/control-plane/node_modules').resolve()]
    if any(not any(Path(filename).resolve().is_relative_to(root) for root in allowed) for filename in items):raise RuntimeError('Dependency resolves outside approved installed roots')
    bundle_command=[str(node),str(ROOT/'deploy/hyperfide/source-control/bundle.mjs'),'--inputs']
    bundles=json.loads(subprocess.check_output(bundle_command,cwd=ROOT,text=True))
    files={'runtime/node':node,'bin/hyperfide':ROOT/'hyperfide','bin/hyperfide-native':ROOT/'build/hyperfide-native','builder/package.py':Path(__file__).resolve(),'builder/pnpm-lock.yaml':ROOT/'pnpm-lock.yaml'}
    for filename in bundles['files']:
        path=Path(filename).resolve()
        if not path.is_relative_to(ROOT):raise RuntimeError('Bundle input escapes workspace')
        files['bundle/'+path.relative_to(ROOT).as_posix()]=path
    trees={}
    for index,filename in enumerate(items):trees['dependencies/'+str(index)]=(Path(filename).parent,EXCLUDED|{'node_modules'})
    for index,filename in enumerate(bundles['trees']):
        path=Path(filename).resolve()
        if not path.is_relative_to(ROOT/'node_modules'):raise RuntimeError('Build dependency escapes installed root')
        trees['builder/dependencies/'+str(index)]=(path,EXCLUDED|{'node_modules'})
    for name in ['mount','umount','git']:
        found=shutil.which(name,path='/usr/bin:/bin:/usr/sbin:/sbin')
        if found:files['bin/'+name]=Path(found).resolve()
    glibc=re.compile(r'ld-linux.*|lib(?:c|m|mvec|pthread|dl|rt|util|resolv|anl|nsl|BrokenLocale|c_malloc_debug|thread_db|nss_[A-Za-z0-9_]+)\.so\.[0-9]+')
    for label,binary in list(files.items()):
        if label not in ['runtime/node','bin/hyperfide','bin/hyperfide-native','bin/mount','bin/umount','bin/git']:continue
        result=subprocess.run(['ldd',str(binary)],text=True,capture_output=True,check=True)
        if 'not found' in result.stdout:raise RuntimeError('Unresolved runtime library')
        for value in re.findall(r'(?:=>\s+|^\s*)(/[^\s()]+)',result.stdout,re.M):
            path=Path(value).resolve()
            if glibc.fullmatch(path.name):continue
            if not any(path.is_relative_to(Path(root).resolve()) for root in ['/usr/lib','/lib','/lib64']):raise RuntimeError('Runtime library escapes explicit system roots')
            key='lib/hyperfide/'+path.name
            if key in files and digest(files[key])!=digest(path):raise RuntimeError('Conflicting runtime library '+path.name)
            files[key]=path
    positions={name:str(index) for index,name in enumerate(items)}
    layout={'entries':{key:positions[value] for key,value in graph['entries'].items()},'dependencies':{positions[name]:{key:positions[value] for key,value in data['deps'].items()} for name,data in graph['graph'].items()}}
    bundle_layout={key:[Path(name).resolve().relative_to(ROOT).as_posix() for name in names] for key,names in bundles.items()}
    before=input_inventory(service,files,trees,{'dependency-layout':layout,'bundle-inputs':bundle_layout})
    fingerprint=hashlib.sha256(canonical(before)).hexdigest()
    output.mkdir(parents=True,exist_ok=True)
    if any(output.iterdir()):raise RuntimeError('Output directory must be empty')
    with tempfile.TemporaryDirectory(prefix='hf-source-package-') as temporary:
        stage=Path(temporary)/'runtime';stage.mkdir()
        for name in ['dist','components','migrations']:
            expected={key.removeprefix('service/'+name+'/'):value for key,value in before.items() if key.startswith('service/'+name+'/')}
            safe_tree(service/name,stage/'services'/name,expected)
        for name in ['package.json','package-lock.json']:safe_copy(service/name,stage/'services'/name,before['service/'+name])
        for label,path in files.items():
            if label.startswith(('bin/','runtime/','lib/')):safe_copy(path,stage/label,before[label],0o755)
        (stage/'package.json').write_bytes(canonical({'type':'module'}))
        locations={name:stage/'services/node_modules/.hyperfide'/positions[name] for name in items}
        for filename,target in locations.items():
            prefix='dependencies/'+positions[filename]+'/'
            expected={key.removeprefix(prefix):value for key,value in before.items() if key.startswith(prefix)}
            safe_tree(Path(filename).parent,target,expected,EXCLUDED|{'node_modules'})
        def link(base,name,filename):
            target=base/name;target.parent.mkdir(parents=True,exist_ok=True);target.symlink_to(os.path.relpath(locations[filename],target.parent),target_is_directory=True)
        for filename,record in graph['graph'].items():
            for name,child in record['deps'].items():link(locations[filename]/'node_modules',name,child)
        for name,filename in graph['entries'].items():link(stage/'services/node_modules',name,filename)
        subprocess.run([str(node),str(ROOT/'deploy/hyperfide/source-control/bundle.mjs'),str(stage)],cwd=ROOT,check=True)
        launcher='''#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export LD_LIBRARY_PATH="$root/lib/hyperfide${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$root/runtime/node" "$root/services/dist/source_control/server.js" "$@"
'''
        (stage/'bin/source-control').write_text(launcher);(stage/'bin/source-control').chmod(0o755)
        if bundles!=json.loads(subprocess.check_output(bundle_command,cwd=ROOT,text=True)) or before!=input_inventory(service,files,trees,{'dependency-layout':layout,'bundle-inputs':bundle_layout}):raise RuntimeError('Runtime input closure changed during packaging')
        subprocess.run(stamp_command,check=True,capture_output=True);native_ready()
        for path in stage.rglob('*'):
            if not path.is_symlink():path.chmod(0o755 if path.is_dir() or path.stat().st_mode&0o111 else 0o644)
        shipped={}
        for path in sorted(stage.rglob('*')):
            name=path.relative_to(stage).as_posix()
            if path.is_symlink():
                if not path.exists() or not path.resolve().is_relative_to(stage):raise RuntimeError('External or missing packaged dependency link')
                shipped[name]={'kind':'symlink','target':os.readlink(path)}
            elif path.is_file():shipped[name]=file_record(path)
        manifest={'schema_version':1,'kind':'hyperfide-native-source-runtime','profile':'linux-'+platform.machine(),'source_format_version':1,'protocol_version':1,'node_version':subprocess.check_output([str(node),'--version'],text=True).strip(),'source_inputs_sha256':fingerprint,'input_manifest':before,'service_stamp':json.loads((service/'dist/.source-digest.json').read_text()),'files':shipped}
        (stage/'runtime-manifest.json').write_bytes(canonical(manifest))
        target=output/'native-source-runtime.tar.gz'
        with target.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0,compresslevel=6) as zipped,tarfile.open(fileobj=zipped,mode='w',format=tarfile.GNU_FORMAT) as archive:
            for path in sorted(stage.rglob('*')):
                info=archive.gettarinfo(str(path),arcname=path.relative_to(stage).as_posix());info.uid=info.gid=0;info.uname=info.gname='';info.mtime=0
                if info.isfile():
                    with path.open('rb') as content:archive.addfile(info,content)
                else:archive.addfile(info)
        record={'schema_version':1,'kind':'hyperfide-native-source-package','runtime_manifest_sha256':digest(stage/'runtime-manifest.json'),'artifact':{'roles':['service','host','native','cli','sdk'],'path':target.name,'sha256':digest(target),'size':target.stat().st_size},'source_inputs_sha256':fingerprint}
        (output/'package-manifest.json').write_bytes(canonical(record));return record

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True);parser.add_argument('--node',default=shutil.which('node'));parser.add_argument('--service-root')
    args=parser.parse_args()
    try:
        if not args.node:raise RuntimeError('Pinned Node runtime required')
        print(json.dumps(build(Path(args.output).resolve(),Path(args.node).resolve(),args.service_root),sort_keys=True));return 0
    except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'REFUSED','error':str(error)}));return 2
if __name__=='__main__':raise SystemExit(main())
