#!/usr/bin/env python3
"""Exercise named mount composition and metadata-only source with actual Git/files."""
from pathlib import Path
import json
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/fleet/mount-layout'

SCRIPT = r'''
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root=process.cwd(),load=name=>import(pathToFileURL(path.join(root,'core/control-plane/dist/preparation/'+name+'.js')).href);
const {createGitSourceManifest,verifyGitSourceManifest}=await load('fleet_source');
const {resolveFleetMounts,materializeFleetMounts,assembleFleetWorkerSource,verifyFleetWorkerDependencies,fleetMountPath}=await load('fleet_mounts');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hf-mount-layout-')),checks=[];
const pass=(id,value)=>{assert.ok(value,id);checks.push(id);};
const refuse=async(id,code,fn)=>{await assert.rejects(async()=>await fn(),error=>error?.code===code,id);checks.push(id);};
try{
 const repository=path.join(temporary,'repository');await fs.mkdir(repository);const git=(...args)=>execFileSync('git',['-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 git('init','-q');git('config','user.name','Fleet Mount Fixture');git('config','user.email','mount-fixture@example.invalid');
 for(const [name,body]of [['sdk/a.txt','sdk\n'],['core/b.txt','core\n'],['omitted/large.txt','excluded\n']]){await fs.mkdir(path.dirname(path.join(repository,name)),{recursive:true});await fs.writeFile(path.join(repository,name),body);}
 git('add','.');git('commit','-qm','Pinned mount fixture');const revision='git:'+git('rev-parse','HEAD'),tree_oid=git('rev-parse','HEAD^{tree}');
 const source=await createGitSourceManifest({repositoryPath:repository,repository:'mount-fixture',revision,tree_oid,paths:['sdk/**','core/**']});
 verifyGitSourceManifest(source,{digest:source.digest,revision,repository:'mount-fixture',readScope:['sdk/**','core/**']});
 const environmentRoot=path.join(temporary,'environment'),actualRoot=path.join(temporary,'staging');await fs.mkdir(actualRoot);
 const neron={source:{source_backend:'git'},client:{mode:'sparse'},workspace:{read_scope:['sdk/**','core/**']}};
 const mount=(paths,target)=>({kind:'source',source:'primary',paths,target,access:'read_only',mode:'sparse'});
 const manifest={environment:{root:environmentRoot},'mount.sdk':mount(['sdk/**'],environmentRoot+'/bases/sdk'),'mount.core':mount(['core/**'],environmentRoot+'/bases/core')};
 const layout=resolveFleetMounts({manifest,sourceConfig:neron,source});
 pass('named-mount-inventory',layout.mounts.length===2&&layout.sourceFiles.length===2&&layout.unionEntries.length===2);
 await materializeFleetMounts(layout,source,actualRoot);
 pass('mount-scope-no-implicit-materialization',(await fs.readdir(fleetMountPath(layout,actualRoot,layout.mounts.find(m=>m.name==='sdk')))).join()==='sdk');
 for(const item of layout.mounts){const base=fleetMountPath(layout,actualRoot,item);await fs.mkdir(path.join(base,'node_modules/pkg'),{recursive:true});await fs.writeFile(path.join(base,'node_modules/pkg/index.js'),'module.exports=42;\n');await fs.mkdir(path.join(base,'node_modules/.bin'));await fs.symlink('../pkg/index.js',path.join(base,'node_modules/.bin/pkg'));}
 const worker=environmentRoot+'/slots/0/source',worker2=environmentRoot+'/slots/1/source';
 await assembleFleetWorkerSource(layout,{actualRoot,workerSource:worker});await assembleFleetWorkerSource(layout,{actualRoot,workerSource:worker2});await verifyFleetWorkerDependencies(layout,{actualRoot,workerSource:worker});
 const first=path.join(actualRoot,'slots/0/source'),second=path.join(actualRoot,'slots/1/source');
 pass('private-repository-union',(await fs.readFile(path.join(first,'sdk/a.txt'),'utf8'))==='sdk\n'&&(await fs.readFile(path.join(first,'core/b.txt'),'utf8'))==='core\n');
 pass('identical-dependency-output-merge',(await fs.readFile(path.join(first,'node_modules/pkg/index.js'),'utf8'))==='module.exports=42;\n');
 pass('contained-dependency-link-copied',(await fs.readlink(path.join(first,'node_modules/.bin/pkg')))==='../pkg/index.js');
 pass('worker-copies-have-independent-inodes',(await fs.stat(path.join(first,'sdk/a.txt'))).ino!==(await fs.stat(path.join(second,'sdk/a.txt'))).ino);
 await fs.writeFile(path.join(first,'sdk/a.txt'),'worker mutation\n');pass('worker-mutation-preserves-other-view',(await fs.readFile(path.join(second,'sdk/a.txt'),'utf8'))==='sdk\n');
 await fs.writeFile(path.join(first,'node_modules/pkg/index.js'),'changed dependency\n');await refuse('worker-dependency-mutation-refused','FLEET_INSTALL_DEPENDENCY_INTEGRITY',()=>verifyFleetWorkerDependencies(layout,{actualRoot,workerSource:worker}));
 const conflicted=fleetMountPath(layout,actualRoot,layout.mounts[0]);await fs.writeFile(path.join(conflicted,'node_modules/pkg/index.js'),'conflicting dependency\n');await refuse('conflicting-mount-output-refused','FLEET_INSTALL_MOUNT_CONFLICT',()=>assembleFleetWorkerSource(layout,{actualRoot,workerSource:environmentRoot+'/slots/2/source'}));
 await refuse('overlapping-target-refused','FLEET_INSTALL_MOUNT_OVERLAP',()=>Promise.resolve(resolveFleetMounts({manifest:{...manifest,'mount.core':mount(['core/**'],environmentRoot+'/bases/sdk/nested')},sourceConfig:neron,source})));
 await refuse('virtual-mount-refused','FLEET_INSTALL_MOUNTS_UNSUPPORTED',()=>Promise.resolve(resolveFleetMounts({manifest:{...manifest,'mount.sdk':{...manifest['mount.sdk'],mode:'virtual'}},sourceConfig:neron,source})));
 await refuse('unadmitted-mount-source-refused','FLEET_INSTALL_MOUNTS_UNSUPPORTED',()=>Promise.resolve(resolveFleetMounts({manifest:{...manifest,'mount.sdk':{...manifest['mount.sdk'],source:'other'}},sourceConfig:neron,source})));
 await refuse('missing-dependency-mount-refused','FLEET_INSTALL_DEPENDENCY_SCOPE',()=>Promise.resolve(resolveFleetMounts({manifest:{...manifest,'dependency.other':{mount:'absent'}},sourceConfig:neron,source})));
 const single=resolveFleetMounts({manifest:{environment:{root:environmentRoot},'mount.sdk':manifest['mount.sdk']},sourceConfig:neron,source});
 await fs.writeFile(path.join(temporary,'external-secret'),'outside\n');const sdkBase=fleetMountPath(single,actualRoot,single.mounts[0]);await fs.symlink(path.relative(path.join(sdkBase,'node_modules'),path.join(temporary,'external-secret')),path.join(sdkBase,'node_modules/escape'));
 await refuse('escaping-dependency-link-refused','FLEET_INSTALL_SYMLINK',()=>assembleFleetWorkerSource(single,{actualRoot,workerSource:environmentRoot+'/slots/4/source'}));
 const metadata=await createGitSourceManifest({repositoryPath:repository,repository:'mount-fixture',revision,tree_oid,paths:[],metadataOnly:true});
 verifyGitSourceManifest(metadata,{digest:metadata.digest,revision,repository:'mount-fixture',readScope:[],metadataOnly:true});
 pass('api-only-real-commit-tree-with-zero-code',metadata.tree_oid===tree_oid&&metadata.entries.length===0&&metadata.bytes===0&&metadata.paths.length===0);
 await refuse('metadata-mode-cannot-downgrade-file-transfer','FLEET_SOURCE_MANIFEST',()=>Promise.resolve(verifyGitSourceManifest(metadata,{digest:metadata.digest,revision,repository:'mount-fixture',readScope:[]})));
 await refuse('file-manifest-cannot-claim-api-only','FLEET_SOURCE_MANIFEST',()=>Promise.resolve(verifyGitSourceManifest(source,{digest:source.digest,revision,repository:'mount-fixture',readScope:[],metadataOnly:true})));
 const apiManifest={environment:{root:environmentRoot}},apiNeron={...neron,client:{mode:'api_only'}};
 const api=resolveFleetMounts({manifest:apiManifest,sourceConfig:apiNeron,source:metadata});await assembleFleetWorkerSource(api,{actualRoot,workerSource:environmentRoot+'/slots/3/source'});
 pass('api-only-working-view-has-no-source-files',(await fs.readdir(path.join(actualRoot,'slots/3/source'))).length===0&&api.sourceFiles.length===0);
 await refuse('api-only-code-mount-refused','FLEET_INSTALL_API_ONLY',()=>Promise.resolve(resolveFleetMounts({manifest,sourceConfig:apiNeron,source:metadata})));
 await refuse('metadata-only-widened-path-refused','FLEET_SOURCE_SCOPE',()=>createGitSourceManifest({repositoryPath:repository,repository:'mount-fixture',revision,tree_oid,paths:['sdk/**'],metadataOnly:true}));
 await refuse('missing-file-scope-stays-error','FLEET_SOURCE_EMPTY',()=>createGitSourceManifest({repositoryPath:repository,repository:'mount-fixture',revision,tree_oid,paths:['missing/**']}));
 process.stdout.write(JSON.stringify({status:'PASS',assertions:checks,source_revision:revision})+'\n');
}finally{await fs.rm(temporary,{recursive:true,force:true});}
'''


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(['node', '--input-type=module', '-e', SCRIPT], cwd=ROOT, capture_output=True, text=True)
    (OUT / 'gate.log').write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    report = json.loads(result.stdout)
    (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'assertions': len(report['assertions'])}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
