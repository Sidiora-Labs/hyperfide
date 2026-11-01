import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const output=path.join(root,'build/layout/0.7');
const require=createRequire(path.join(root,'package.json'));
if(process.argv[2]==='scaffold'){
 const {scaffoldPlugin}=await import(pathToFileURL(path.join(root,'lib/templates/src/plugin-scaffold.ts')));
 const {buildPluginServer}=await import(pathToFileURL(path.join(root,'tools/plugin-build/src/build-plugin-server.ts')));
 const generated=await fs.mkdtemp(path.join(output,'consumer-'));
 const target=path.join(generated,'hyperfide-plugin-layout-probe');
 await scaffoldPlugin({targetDir:target,packageName:'hyperfide-plugin-layout-probe',hyperfideVersion:JSON.parse(await fs.readFile(path.join(root,'apps/launcher/package.json'),'utf8')).version});
 await fs.mkdir(path.join(target,'node_modules/@hyperfide'),{recursive:true});
 await fs.symlink(path.join(root,'sdk/plugins'),path.join(target,'node_modules/@hyperfide/plugin-sdk'),'dir');
 await fs.symlink(await fs.realpath(path.join(root,'sdk/plugins/node_modules/zod')),path.join(target,'node_modules/zod'),'dir');
 const sdk=JSON.parse(await fs.readFile(path.join(target,'package.json'),'utf8'));
 assert.equal(sdk.name,'hyperfide-plugin-layout-probe');
 // This backend-only consumer invokes the actual server compiler; it does not claim a frontend/Tailwind build.
 const toolchain={esbuild:require.resolve('esbuild')};
 await buildPluginServer(target,JSON.parse(await fs.readFile(path.join(root,'apps/launcher/package.json'),'utf8')).version,toolchain);
 const built=await import(pathToFileURL(path.join(target,'dist/server.js')));
 assert.equal(typeof built.default,'function');
 const meta=JSON.parse(await fs.readFile(path.join(target,'dist/server.meta.json'),'utf8'));
 await fs.writeFile(path.join(output,'scaffold-consumer.json'),JSON.stringify({status:'PASS',package_name:sdk.name,server:path.relative(root,path.join(target,'dist/server.js')),meta},null,2)+'\n');
 console.log(JSON.stringify({status:'PASS',consumer:sdk.name,built_server_imported:true}));
}else if(process.argv[2]==='extensions'){
 for(const dir of ['extensions/vscode','extensions/kvx-vscode']){
  const manifest=JSON.parse(await fs.readFile(path.join(root,dir,'package.json'),'utf8'));
  if(manifest.main)assert((await fs.stat(path.join(root,dir,manifest.main))).isFile());
  for(const grammar of manifest.contributes?.grammars??[])assert((await fs.stat(path.join(root,dir,grammar.path))).isFile());
  for(const language of manifest.contributes?.languages??[])if(language.configuration)assert((await fs.stat(path.join(root,dir,language.configuration))).isFile());
 }
 console.log(JSON.stringify({status:'PASS',extensions:2}));
}else throw new Error('Expected scaffold or extensions');
