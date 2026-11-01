import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const dispositions=JSON.parse(await fs.readFile(path.join(root,'build/layout/0.9/reviewed-source-dispositions.json'),'utf8'));
const assertions=[];
async function modulePair(target){
 const row=dispositions.flagged_rewrites.find(row=>row.target===target);assert(row);
 const filename=path.join(root,target),directory=await fs.mkdtemp(path.join(path.dirname(filename),'.tmp-'));
 const historical=directory+'.ts';
 await fs.writeFile(historical,execFileSync('git',['cat-file','blob',row.after_blob],{cwd:root}));
 try{return {current:await import(pathToFileURL(filename)),historic:await import(pathToFileURL(historical)),cleanup:async()=>{await fs.rm(historical,{force:true});await fs.rm(directory,{recursive:true,force:true});}};}
 catch(error){await fs.rm(historical,{force:true});await fs.rm(directory,{recursive:true,force:true});throw error;}
}
async function regression(id,target,check){
 const pair=await modulePair(target);
 try{
  let historicalFailed=false;try{await check(pair.historic);}catch(error){if(error.code==='ERR_ASSERTION')historicalFailed=true;else throw error;}
  assert(historicalFailed,'Historical production module must fail the consumer contract for the intended assertion');
  await check(pair.current);assertions.push({id,status:'PASS',historical_regression_observed:true,target});
 }finally{await pair.cleanup();}
}
await regression('git-diff-dotfile-path','apps/web/src/components/git-diff/git-diff-parsing.ts',mod=>{
 const [file]=mod.parseGitDiffFiles('diff --git a/.gitignore b/.gitignore\n--- a/.gitignore\n+++ b/.gitignore\n@@ -1 +1 @@\n-old\n+new\n');
 assert(file);assert.equal(mod.getOpenableGitDiffPath({...file,name:'.gitignore',prevName:undefined}),'.gitignore');
});
await regression('terminal-dot-name-title','apps/web/src/components/thread/terminal/thread-terminal-title.ts',mod=>{
 assert.equal(mod.normalizeTerminalTitle({title:'user@host:.release-check'}),'user@host:.release-check');
 assert.equal(mod.normalizeTerminalTitle({title:'user@host:./project'}),null);
});
await regression('desktop-dotdot-name-inside-mount','apps/desktop/src/hyperfide-process.ts',mod=>{
 let result;try{result=mod.createHyperfideAppProcessLaunch({bridgePath:'/mount/..cache/bridge.mjs',env:{},runtime:{kind:'appimage',mode:'electron-node',appDirPath:'/mount',executablePath:'/image.AppImage'}});}catch(error){assert.fail('A dot-prefixed name inside the mount is not parent traversal: '+error.message);}
 assert(result.args.includes('/mount/..cache/bridge.mjs'));
 assert.throws(()=>mod.createHyperfideAppProcessLaunch({bridgePath:'/outside/bridge.mjs',env:{},runtime:{kind:'appimage',mode:'electron-node',appDirPath:'/mount',executablePath:'/image.AppImage'}}),/inside the AppImage mount/);
});
await regression('plugin-owned-icon-explicit-relative','lib/domain/src/plugin-icon.ts',mod=>{
 assert.equal(mod.isPluginOwnedIconPath('.icons/agent.svg'),false);
 assert.equal(mod.isPluginOwnedIconPath('./icons/agent.svg'),true);
});
await regression('repository-dotdot-name-dev-identity','lib/config/src/runtime.ts',mod=>{
 assert(mod.resolveDevInstanceConfig({homeDir:'/home/user',repoRoot:'/home/user/..cache'}).instanceId.startsWith('cache-'));
});
await regression('inline-preview-dotdot-name','plugins/inline-vis/server.ts',mod=>{
 let value;try{value=mod.requireRelativePreviewFile('..cache/preview.html');}catch(error){assert.fail('Safe dot-prefixed preview filename is not traversal: '+error.message);}
 assert.equal(value,'..cache/preview.html');assert.throws(()=>mod.requireRelativePreviewFile('../outside.html'));
});
const fixture=await fs.mkdtemp(path.join(root,'build/layout/0.9/receipt-link-fixture-'));
try{
 await fs.mkdir(path.join(fixture,'artifacts/hyperfide/tasks/0.7/lane with space'),{recursive:true});
 await fs.writeFile(path.join(fixture,'artifacts/hyperfide/tasks/0.7/lane with space/receipt.json'),'{}');
 await regression('receipt-relative-url-separator','plugins/hyperfide-spec/src/board/server.ts',async mod=>{
  assert.equal(await mod.latestReceipt(fixture,'0.7'),'./artifacts/hyperfide/tasks/0.7/lane%20with%20space/receipt.json');
 });
}finally{await fs.rm(fixture,{recursive:true,force:true});}
const shared=await fs.mkdtemp(path.join(root,'build/layout/0.9/isolation-alias-fixture-'));
try{
 await fs.writeFile(path.join(shared,'consumer.test.ts'),"import '.theme';\n");
 await fs.writeFile(path.join(shared,'state.fixture.ts'),"vi.stubGlobal('layout-fixture',1);\n");
 await regression('shared-worker-dot-alias-isolation','vitest.shared.ts',mod=>{
  const projects=mod.sharedWorkerProjects({pkgDir:shared,name:'layout-consumer',include:['*.test.ts'],aliases:{'.theme':path.join(shared,'state.fixture.ts')}});
  assert(projects.some(project=>project.test?.name==='layout-consumer:isolated'));
 });
}finally{await fs.rm(shared,{recursive:true,force:true});}
const normalize=await import(pathToFileURL(path.join(root,'core/server/src/services/plugins/install-sources.ts')));
assert.throws(()=>normalize.normalizePluginSubdirectory('.git'),/invalid/);
assert.equal(normalize.normalizePluginSubdirectory('..cache'),'..cache');
for(const invalid of ['./../evil','./plugins/../../evil','./','./plugins//sidebar','./plugins/sidebar/','./plugins/./sidebar','./.git'])assert.throws(()=>normalize.normalizePluginSubdirectory(invalid));
assert.equal(normalize.normalizePluginSubdirectory('./plugins/sidebar'),'plugins/sidebar');
assertions.push({id:'plugin-subdirectory-security-and-fixture-vectors',status:'PASS'});
const collection=await import(pathToFileURL(path.join(root,'core/server/src/services/plugins/collection-manifest.ts')));
for(const source of ['.git','..cache/plugin','../evil','./../evil','./plugins/../../evil','./plugins//sidebar','./plugins/sidebar/','./plugins/./sidebar'])assert.throws(()=>collection.parsePluginCollectionManifest(JSON.stringify({schemaVersion:1,name:'layout-fixture',plugins:[{name:'sidebar',source}]}),'layout-fixture'));
assert.equal(collection.parsePluginCollectionManifest(JSON.stringify({schemaVersion:1,name:'layout-fixture',plugins:[{name:'sidebar',source:'./plugins/sidebar'}]}),'layout-fixture').plugins[0].source,'./plugins/sidebar');
assertions.push({id:'collection-explicit-relative-source-contract',status:'PASS'});
const metro=JSON.parse(execFileSync(process.execPath,[path.join(root,'tests/hyperfide/cases/source_control/support/layout_metro_consumer.mjs')],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH}}).trim().split('\n').at(-1));
assert.equal(metro.status,'PASS');assertions.push(...metro.assertions);
console.log(JSON.stringify({status:'PASS',assertions}));
