import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildNodeEsmEntry} from '../../../tools/workspace/build-utils.mjs';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const root=path.resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const args=process.argv.slice(2),sdkFlag=args.indexOf('--sdk-root');
const sdkRoot=await fs.realpath(sdkFlag===-1?path.join(root,'sdk/source-control'):path.resolve(args[sdkFlag+1]));
if(!sdkRoot.startsWith(root+path.sep)||!(await fs.stat(sdkRoot)).isDirectory())throw new Error('SDK snapshot must be a directory inside the builder workspace');
if(sdkFlag!==-1)args.splice(sdkFlag,2);
const hostNames=['cache','capabilities','checkpoint','client','journal','materializer','metrics','virtual-filesystem'];
const originals=hostNames.map(name=>path.join(root,'core/host-daemon/src/source-control',name+'.ts'));
originals.push(path.join(root,'core/authority-client/src/source.ts'));
let hostEntries=originals.slice(0,-1),signedEntry=originals.at(-1);
if(sdkFlag!==-1){
 const wrappers=path.join(sdkRoot,'.package-wrappers');await fs.mkdir(wrappers,{recursive:true});
 const entries=[];
 for(const [index,filename] of originals.entries()){
  const source=(await fs.readFile(filename,'utf8')).replace(/["']@hyperfide\/source-control\/host["']/g,JSON.stringify(path.join(sdkRoot,'src/host/index.ts'))).replace(/["']@hyperfide\/source-control\/signed["']/g,JSON.stringify(path.join(sdkRoot,'src/signed.ts')));
  const target=path.join(wrappers,index+'.ts');await fs.writeFile(target,source);entries.push(target);
 }
 hostEntries=entries.slice(0,-1);signedEntry=entries.at(-1);
}
if(args[0]==='--inputs'){
 const entries=[...hostEntries,path.join(sdkRoot,'src/index.ts'),signedEntry];
 const result=await build({entryPoints:entries,bundle:true,write:false,metafile:true,outdir:'/unused',platform:'node',format:'esm',conditions:['source'],logLevel:'silent'});
 const files=new Set(Object.keys(result.metafile.inputs).map(name=>path.resolve(name)));
 for(const filename of [...files]){let directory=path.dirname(filename);while(directory.startsWith(root)){const manifest=path.join(directory,'package.json');try{await fs.access(manifest);files.add(manifest);}catch{}const parent=path.dirname(directory);if(parent===directory)break;directory=parent;}}
 files.add(path.join(root,'tools/workspace/build-utils.mjs'));files.add(path.join(root,'tools/plugin-build/src/zod-locale-stub.mjs'));files.add(fileURLToPath(import.meta.url));
 for(const filename of originals)files.add(filename);
 const require=createRequire(import.meta.url),esbuild=path.dirname(require.resolve('esbuild/package.json'));
 const buildPackage=JSON.parse(await fs.readFile(path.join(esbuild,'package.json'),'utf8'));
 const trees=[esbuild];
 const local=createRequire(path.join(esbuild,'package.json'));
 for(const name of Object.keys(buildPackage.optionalDependencies??{})){try{trees.push(path.dirname(local.resolve(name+'/package.json')));}catch{}}
 console.log(JSON.stringify({files:[...files].sort(),trees:trees.sort()}));
 process.exit(0);
}
if(!args[0])throw new Error('Output directory required');
const output=path.resolve(args[0]);
for(const [index,name] of hostNames.entries()){
 await buildNodeEsmEntry({entryPoint:hostEntries[index],outfile:path.join(output,'host',name+'.js'),sourcemap:false});
}
await buildNodeEsmEntry({entryPoint:path.join(sdkRoot,'src/index.ts'),outfile:path.join(output,'sdk/index.js'),sourcemap:false});
await fs.writeFile(path.join(output,'sdk/client.js'),'export {SourceControlClient} from "./index.js";\n');
await fs.writeFile(path.join(output,'sdk/contracts.js'),'export * from "./index.js";\n');
await buildNodeEsmEntry({entryPoint:signedEntry,outfile:path.join(output,'sdk/signed.js'),sourcemap:false});
