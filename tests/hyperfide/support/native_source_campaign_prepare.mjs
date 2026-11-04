/** Prepare immutable campaign corpora through the deployed source API. No checkout or ambient credentials. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readPrivate, credential} from '../source-control/workloads/deployment.mjs';
import {machineIdentity} from '../source-control/workloads/campaign.mjs';
const stableUUID=value=>{const h=createHash('sha256').update(value).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const hash=b=>'sha256:'+createHash('sha256').update(b).digest('hex');
const config=JSON.parse(await readPrivate(process.env.HF_SOURCE_PREPARE_CONFIG));
assert.equal(config.schema_version,1);assert.equal(config.isolated_scope,true);
assert.equal(new URL(config.endpoint).protocol,'https:');assert(path.isAbsolute(config.output_directory));
const counts=config.file_counts??[10000,1000000,10000000];
for(const n of counts)assert(Number.isSafeInteger(n)&&n>=10&&n<=10000000);
const unique=config.unique_contents??1, depth=config.history_depth??1,fanout=config.fanout??100;
assert(Number.isSafeInteger(fanout)&&fanout>=10&&fanout<=256);
assert(Number.isSafeInteger(unique)&&unique>=1&&unique<=1000&&unique<=Math.min(...counts));assert(Number.isSafeInteger(depth)&&depth>=1&&depth<=1000);
const {SourceControlClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'client.js')));
await fs.mkdir(config.output_directory,{recursive:true,mode:0o700});
const identity={endpoint:config.endpoint,scope:config.scope,counts,unique_contents:unique,history_depth:depth,fanout,seed:config.seed??42,epoch_ms:config.epoch_ms??1700000000000};
const binding=path.join(config.output_directory,'preparation-binding.json');
try{await fs.writeFile(binding,JSON.stringify(identity),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;assert.deepEqual(JSON.parse(await readPrivate(binding)),identity,'Preparation output belongs to another scope or profile');}
const journal=path.join(config.output_directory,'preparation-operations.jsonl');
const completed=new Map();
try{for(const line of (await fs.readFile(journal,'utf8')).trim().split('\n').filter(Boolean)){const r=JSON.parse(line);completed.set(r.key,r);}}catch(e){if(e.code!=='ENOENT')throw e;}
let client;
if(config.signed_config_file){
 const signed=JSON.parse(await readPrivate(config.signed_config_file));assert.equal(signed.endpoint,config.endpoint);assert.deepEqual(signed.scope,config.scope);
 const {createSignedSourceClient}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_SDK_MODULE_ROOT,'signed.js')));client=await createSignedSourceClient(signed);
}else client=new SourceControlClient({endpoint:config.endpoint,scope:config.scope,timeout_ms:300000,token:()=>credential(config)});
const capabilities=await client.capabilities();
async function mutation(key,action,input){
 const digest=hash(JSON.stringify({action,input}));let saved=completed.get(key);
 if(saved){assert.equal(saved.digest,digest,'Preparation configuration changed within resumable journal');if(saved.result)return saved.result;}
 else{saved={key,digest,operation_id:randomUUID()};await fs.appendFile(journal,JSON.stringify(saved)+'\n',{mode:0o600});completed.set(key,saved);}
 const result=await client.call(action,input,{operation_id:saved.operation_id,idempotency_key:saved.operation_id});
 saved={...saved,result};await fs.appendFile(journal,JSON.stringify(saved)+'\n',{mode:0o600});completed.set(key,saved);return result;
}
async function put(key,kind,bytes){return (await mutation(key,'source.objects.put',{kind,payload_base64:Buffer.from(bytes).toString('base64')})).object_id;}
const files=[];
for(let i=0;i<unique;i++){
 const bytes=Buffer.from('campaign-seed:'+String(config.seed??42)+':content:'+i+'\n');
 const blob=await put('blob:'+i,'blob',bytes);
 files.push(await put('file:'+i,'file',JSON.stringify([1,String(bytes.length),hash(bytes),['blob',blob]])));
}
async function tree(key,entries){
 entries.sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 return put('tree:'+key,'tree-leaf',JSON.stringify([1,'',entries.map(([name,kind,id])=>[name,kind,kind==='file'?'100644':'040000',id])]));
}
const shared=new Map();
async function cold(n,offset=0){
 const key=n+':'+offset%unique;if(shared.has(key))return shared.get(key);
 const entries=[];
 if(n<=fanout){for(let i=0;i<n;i++)entries.push(['f'+String(i).padStart(3,'0'),'file',files[(offset+i)%unique]]);}
 else{let span=fanout;while(Math.ceil(n/span)>fanout)span*=fanout;for(let i=0,start=0;start<n;i++,start+=span)entries.push(['d'+String(i).padStart(3,'0'),'directory',await cold(Math.min(span,n-start),offset+start)]);}
 const result=await tree('cold:'+key,entries);shared.set(key,result);return result;
}
const edit_paths=Array.from({length:10},(_,i)=>'hot/file-'+String(i).padStart(2,'0')+'.txt');
const hot=await tree('hot',edit_paths.map((name,i)=>[name.slice(4),'file',files[i%unique]]));
const verified=new Map(), allFiles=new Set(), allTrees=new Set();
async function measure(id){
 if(verified.has(id))return verified.get(id);let total=0,cursor;
 allTrees.add(id);
 do{const page=await client.tree(id,{limit:256,...(cursor?{cursor}:{})});for(const entry of page.entries){if(entry.kind==='directory')total+=await measure(entry.object_id);else{total++;allFiles.add(entry.object_id);}}cursor=page.next_cursor;}while(cursor);
 verified.set(id,total);return total;
}
const corpora=[];
for(const n of counts){
 const root=await tree('root:'+n,[['hot','directory',hot],...(n>10?[['cold','directory',await cold(n-10)]]:[])]);
 let parent,revision;const history=[];
 for(let generation=0;generation<depth;generation++){
  revision=await mutation('revision:'+n+':'+generation,'source.revisions.create',{change_id:stableUUID('campaign:'+String(config.seed??42)+':'+n+':'+generation),root_tree_id:root,parent_revision_ids:parent?[parent]:[],predecessor_revision_ids:[],provenance:{author:{name:'Source campaign',email:'source-campaign@example.invalid'},message:'Prepared corpus '+n+' history '+generation,timestamp:new Date((config.epoch_ms??1700000000000)+generation*1000).toISOString()}});
  const readback=await client.revision(revision.revision_id);assert.equal(readback.root_tree_id,root);assert.deepEqual(readback.parent_revision_ids,parent?[parent]:[]);parent=revision.revision_id;history.push(parent);
 }
 assert.equal(await measure(root),n);
 for(const name of edit_paths){const result=await client.call('source.trees.lookup',{tree_id:root,path:name});assert.equal(result.entry.kind,'file');}
 corpora.push({logical_files:n,revision_id:parent,root_tree_id:root,edit_paths,history_revision_ids:history,history_depth:depth,directory_fanout:fanout,hot_directories:['hot'],unique_file_descriptors:allFiles.size});
}
const result={schema_version:1,status:'PASS',scope:config.scope,endpoint:config.endpoint,backend_identity:config.backend_identity,machine:machineIdentity(),capabilities,corpora,measurements:{unique_content_objects:files.length,unique_tree_objects:allTrees.size,source:'paginated deployed source API traversal; shared subtrees counted per reference'},completed_at:new Date().toISOString()};
await fs.writeFile(path.join(config.output_directory,'prepared-corpora.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:result.status,corpora:corpora.map(c=>({logical_files:c.logical_files,revision_id:c.revision_id})),output:path.join(config.output_directory,'prepared-corpora.json')}));
