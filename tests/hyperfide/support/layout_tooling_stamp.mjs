import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const root=path.resolve(process.argv[2]);
const {writeStamp,checkStamp}=await import(pathToFileURL(path.join(root,'deploy/hyperfide/dist-stamp.mjs')));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'hyperfide-layout-stamp-'));
const service=path.join(temporary,'core/control-plane');
const assertions=[];
function check(id,value){if(!value)throw new Error(id);assertions.push(id);}
try{
 fs.mkdirSync(service,{recursive:true});
 for(const name of ['src','dist','scripts'])fs.cpSync(path.join(root,'core/control-plane',name),path.join(service,name),{recursive:true});
 for(const name of ['package.json','package-lock.json','tsconfig.json'])fs.copyFileSync(path.join(root,'core/control-plane',name),path.join(service,name));
 fs.mkdirSync(path.join(temporary,'contracts'),{recursive:true});
 fs.cpSync(path.join(root,'contracts/fleet'),path.join(temporary,'contracts/fleet'),{recursive:true});
 writeStamp(service);
 check('stamp.copied-inputs-fresh',checkStamp(service).fresh);
 const source=path.join(service,'src/control.ts'),bytes=fs.readFileSync(source);
 fs.appendFileSync(source,'\n// Source identity challenge.\n');
 check('stamp.source-change-refused',checkStamp(service).code==='DIST_STALE'&&checkStamp(service).reason==='source');
 fs.writeFileSync(source,bytes);
 const canonical=path.join(temporary,'contracts/fleet/index.mjs'),contract=fs.readFileSync(canonical);
 fs.appendFileSync(canonical,'\n// Canonical contract identity challenge.\n');
 check('stamp.canonical-contract-change-refused',checkStamp(service).code==='DIST_STALE'&&checkStamp(service).reason==='source');
 fs.writeFileSync(canonical,contract);
 const emitted=path.join(service,'dist/control.js'),compiled=fs.readFileSync(emitted);
 fs.appendFileSync(emitted,'\n// Emitted byte identity challenge.\n');
 check('stamp.emitted-change-refused',checkStamp(service).code==='DIST_STALE'&&checkStamp(service).reason==='dist');
 fs.writeFileSync(emitted,compiled);
 fs.unlinkSync(emitted);
 check('stamp.missing-emission-refused',checkStamp(service).code==='DIST_STALE'&&checkStamp(service).reason==='dist');
 fs.writeFileSync(emitted,compiled);
 fs.unlinkSync(path.join(service,'dist/.source-digest.json'));
 check('stamp.unstamped-refused',checkStamp(service).code==='DIST_UNSTAMPED');
 process.stdout.write(JSON.stringify({status:'PASS',assertions,scope:'Real source-stamp implementation over copied current inputs and emitted bytes; no compilation or service qualification'})+'\n');
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
