import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../../..');
const dispositions=JSON.parse(await fs.readFile(path.join(root,'build/layout/0.9/reviewed-source-dispositions.json'),'utf8'));
const assertions=[];
const mobile=path.join(root,'apps/mobile/metro.config.js'),row=dispositions.flagged_rewrites.find(row=>row.target==='apps/mobile/metro.config.js');
function metroConfig(text){
 const module={exports:{}};
 const evaluate=new vm.Script('(function(require,module,exports,__filename,__dirname){'+text+'\n})',{filename:mobile});
 evaluate.runInThisContext()(createRequire(mobile),module,module.exports,mobile,path.dirname(mobile));return module.exports;
}
const currentConfig=metroConfig(await fs.readFile(mobile,'utf8'));
const historicConfig=metroConfig(execFileSync('git',['cat-file','blob',row.after_blob],{cwd:root,encoding:'utf8'}));
const origin=path.join(root,'apps/mobile/src/layout-consumer.ts');
const context={originModulePath:origin,resolveRequest:(_context,specifier)=>({type:'sourceFile',filePath:execFileSync(process.execPath,['--input-type=commonjs','-e','console.log(require.resolve('+JSON.stringify(specifier)+'))'],{cwd:path.join(root,'apps/mobile'),encoding:'utf8',env:{PATH:process.env.PATH}}).trim()})};
const source=await fs.realpath(path.join(root,'sdk/client/src/core.ts'));
assert.notEqual(historicConfig.resolver.resolveRequest(context,'@hyperfide/sdk/core','ios').filePath,source);
assert.equal(currentConfig.resolver.resolveRequest(context,'@hyperfide/sdk/core','ios').filePath,source);
assertions.push({id:'metro-workspace-subpath-source-exports',status:'PASS',historical_regression_observed:true});
console.log(JSON.stringify({status:'PASS',assertions}));
