import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {buildNodeEsmEntry} from '../../../tools/workspace/build-utils.mjs';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const root=path.resolve(fileURLToPath(new URL('../../..',import.meta.url)));
if(process.argv[2]==='--inputs'){
 const entries=['cache','capabilities','checkpoint','client','journal','materializer','metrics','virtual-filesystem'].map(name=>path.join(root,'core/host-daemon/src/source-control',name+'.ts'));
 entries.push(path.join(root,'sdk/source-control/src/index.ts'),path.join(root,'core/authority-client/src/source.ts'));
 const result=await build({entryPoints:entries,bundle:true,write:false,metafile:true,outdir:'/unused',platform:'node',format:'esm',conditions:['source'],logLevel:'silent'});
 const files=new Set(Object.keys(result.metafile.inputs).map(name=>path.resolve(name)));
 for(const filename of [...files]){let directory=path.dirname(filename);while(directory.startsWith(root)){const manifest=path.join(directory,'package.json');try{await fs.access(manifest);files.add(manifest);}catch{}const parent=path.dirname(directory);if(parent===directory)break;directory=parent;}}
 files.add(path.join(root,'tools/workspace/build-utils.mjs'));files.add(path.join(root,'tools/plugin-build/src/zod-locale-stub.mjs'));files.add(fileURLToPath(import.meta.url));
 const require=createRequire(import.meta.url),esbuild=path.dirname(require.resolve('esbuild/package.json'));
 const buildPackage=JSON.parse(await fs.readFile(path.join(esbuild,'package.json'),'utf8'));
 const trees=[esbuild];
 const local=createRequire(path.join(esbuild,'package.json'));
 for(const name of Object.keys(buildPackage.optionalDependencies??{})){try{trees.push(path.dirname(local.resolve(name+'/package.json')));}catch{}}
 console.log(JSON.stringify({files:[...files].sort(),trees:trees.sort()}));
 process.exit(0);
}
const output=path.resolve(process.argv[2]);
if(!process.argv[2])throw new Error('Output directory required');
for(const name of ['cache','capabilities','checkpoint','client','journal','materializer','metrics','virtual-filesystem']){
 await buildNodeEsmEntry({entryPoint:path.join(root,'core/host-daemon/src/source-control',name+'.ts'),outfile:path.join(output,'host',name+'.js'),sourcemap:false});
}
await buildNodeEsmEntry({entryPoint:path.join(root,'sdk/source-control/src/index.ts'),outfile:path.join(output,'sdk/index.js'),sourcemap:false});
await fs.writeFile(path.join(output,'sdk/client.js'),'export {SourceControlClient} from "./index.js";\n');
await fs.writeFile(path.join(output,'sdk/contracts.js'),'export * from "./index.js";\n');
await buildNodeEsmEntry({entryPoint:path.join(root,'core/authority-client/src/source.ts'),outfile:path.join(output,'sdk/signed.js'),sourcemap:false});
