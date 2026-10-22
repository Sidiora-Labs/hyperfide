#!/usr/bin/env node
/* Stale-dist guard. services/hyperfide/dist is gitignored build output, so
 * nothing else stops a checkout from running JavaScript older than its
 * TypeScript (a missing recovery/bootstrap_fence.js broke the bootstrap fence
 * this way). The build records a content digest of every compiler input in
 * dist/.source-digest.json; install-service.mjs and scripts/release.sh refuse
 * when that digest no longer matches the source.
 *   node dist-stamp.mjs write <service-root>   (run by `npm run build`)
 *   node dist-stamp.mjs check <service-root>   (exit 1 with DIST_STALE / DIST_UNSTAMPED) */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const STAMP_FILE='.source-digest.json';
// Every input that changes what tsc emits or how node loads it.
const ROOT_INPUTS=['package.json','package-lock.json','tsconfig.json'];

function walk(directory,base,out){
 for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
  const file=path.join(directory,entry.name);
  if(entry.isDirectory())walk(file,base,out);
  else if(entry.isFile())out.push(path.relative(base,file).split(path.sep).join('/'));
 }
 return out;
}

export function sourceDigest(serviceRoot){
 const files=[...ROOT_INPUTS.filter(name=>fs.existsSync(path.join(serviceRoot,name))),...walk(path.join(serviceRoot,'src'),serviceRoot,[])].sort();
 const hash=createHash('sha256');
 for(const name of files){
  const bytes=fs.readFileSync(path.join(serviceRoot,name));
  hash.update(name+'\0'+bytes.length+'\0');hash.update(bytes);
 }
 return {digest:'sha256:'+hash.digest('hex'),files:files.length};
}

export function writeStamp(serviceRoot){
 const stamp={schema_version:1,...sourceDigest(serviceRoot)};
 fs.writeFileSync(path.join(serviceRoot,'dist',STAMP_FILE),JSON.stringify(stamp)+'\n');
 return stamp;
}

/** Returns {fresh:true,...} or {fresh:false,code,...}; never throws for a missing or unreadable stamp. */
export function checkStamp(serviceRoot){
 const current=sourceDigest(serviceRoot);
 let recorded;
 try{recorded=JSON.parse(fs.readFileSync(path.join(serviceRoot,'dist',STAMP_FILE),'utf8'));}
 catch{return {fresh:false,code:'DIST_UNSTAMPED',expected:current.digest,recorded:null};}
 if(recorded?.schema_version!==1||recorded.digest!==current.digest)return {fresh:false,code:'DIST_STALE',expected:current.digest,recorded:recorded?.digest??null};
 return {fresh:true,digest:current.digest};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,root]=process.argv.slice(2);
 if(!['write','check'].includes(mode)||!root){process.stderr.write('usage: dist-stamp.mjs write|check <service-root>\n');process.exit(2);}
 const serviceRoot=path.resolve(root);
 if(mode==='write'){process.stdout.write(JSON.stringify(writeStamp(serviceRoot))+'\n');}
 else{
  const result=checkStamp(serviceRoot);
  process.stdout.write(JSON.stringify(result)+'\n');
  if(!result.fresh){process.stderr.write(`hyperfide: ${result.code}: ${serviceRoot}/dist does not match its source; run npm run build\n`);process.exit(1);}
 }
}
