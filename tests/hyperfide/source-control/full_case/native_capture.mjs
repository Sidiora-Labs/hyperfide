import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Capture an actual bounded native snapshot using authenticated API reads.
 * The caller supplies the real current context, never a synthesized epoch.
 * This captures source data; it does not claim those files are the runtime
 * implementation unless the caller's native revision really contains it.
 */
export async function captureNativeSource({client,context,revisionId,workspaceRoot,outputDirectory,assertionIds,toolchain=[],maxObjects=4096,maxBytes=67108864}){
 const {canonicalBytes,canonicalEnvelope}=await import(pathToFileURL(path.join(process.env.SOURCE_CONTROL_MODULE_ROOT,'contracts.js')));
 const output=path.resolve(outputDirectory),root=path.resolve(workspaceRoot);assert(output.startsWith(root+'/'));
 await fs.mkdir(path.join(output,'objects'),{recursive:true});await fs.mkdir(path.join(output,'files'),{recursive:true});
 const pin=async(filename,bytes)=>{const parent=path.dirname(filename);await fs.mkdir(parent,{recursive:true});assert.equal(await fs.realpath(parent),parent,'Native capture output cannot traverse links');const file=await fs.open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_NOFOLLOW,0o600);try{const stat=await file.stat();assert(stat.isFile()&&stat.nlink===1,'Native capture requires a private regular file');await file.truncate(0);await file.writeFile(bytes);}finally{await file.close();}return {path:path.relative(root,filename),sha256:digest(bytes)};};
 const revision=await client.revision(revisionId);assert.equal(revision.revision_id,revisionId);assert.equal(String(revision.authority_epoch),context.authority_epoch);
 const seen=new Set(),objects=[];let total=0;
 async function object(id){if(seen.has(id))return;assert(seen.size<maxObjects,'Native capture object bound exceeded');seen.add(id);const read=await client.object(id),payload=Buffer.from(read.payload_base64,'base64'),bytes=Buffer.from(canonicalEnvelope(read.kind,payload));assert.equal('sha256:'+digest(bytes),id);total+=bytes.length;assert(total<=maxBytes,'Native capture byte bound exceeded');objects.push({...await pin(path.join(output,'objects',id.slice(7)),bytes),object_id:id,state:'READY'});if(['tree-leaf','tree-index','file'].includes(read.kind)){const tuple=JSON.parse(payload);let children=[];if(read.kind==='tree-leaf')children=tuple[2].map(entry=>entry[3]);else if(read.kind==='tree-index')children=tuple[3].map(child=>child[1]);else children=tuple[3][0]==='blob'?[tuple[3][1]]:tuple[3][1].map(chunk=>chunk[0]);for(const child of children)await object(child);}}
 await object(revision.root_tree_id);
 const p=revision.descriptor.provenance,scope=revision.descriptor.scope;
 const revisionBytes=Buffer.from(canonicalEnvelope('revision',canonicalBytes([1,[scope.organisation_id,scope.repository_id,scope.security_domain_id],revision.root_tree_id,revision.parent_revision_ids,[p.author.name,p.author.email,p.message,p.timestamp]])));
 assert.equal('sha256:'+digest(revisionBytes),revisionId);objects.push({...await pin(path.join(output,'objects',revisionId.slice(7)),revisionBytes),object_id:revisionId,state:'READY'});
 const files=[],sourcePaths={};
 async function directory(id,prefix=''){let cursor;do{const page=await client.tree(id,{limit:256,...(cursor?{cursor}:{})});for(const entry of page.entries){assert(entry.name&&!entry.name.includes('/')&&!['.','..'].includes(entry.name));const relative=prefix+entry.name;if(entry.kind==='directory')await directory(entry.object_id,relative+'/');else{const read=await client.object(entry.object_id),descriptor=JSON.parse(Buffer.from(read.payload_base64,'base64'));const parts=descriptor[3][0]==='blob'?[descriptor[3][1]]:descriptor[3][1].map(chunk=>chunk[0]);const buffers=[];for(const child of parts)buffers.push(Buffer.from((await client.object(child)).payload_base64,'base64'));const bytes=Buffer.concat(buffers);assert.equal(String(bytes.length),descriptor[1]);assert.equal('sha256:'+digest(bytes),descriptor[2]);const record=await pin(path.join(output,'files',relative),bytes);files.push(record);sourcePaths[relative]=record;}}cursor=page.next_cursor;}while(cursor);}
 await directory(revision.root_tree_id);assert(files.length,'Native source capture cannot be empty');
 const identity={scope:context.scope,revision_id:revisionId,root_tree_id:revision.root_tree_id,authority_epoch:context.authority_epoch,policy_version:context.policy_version};assert(identity.policy_version);
 const manifest=await pin(path.join(output,'source.json'),Buffer.from(JSON.stringify({schema_version:1,...identity,files,source_paths:sourcePaths})+'\n'));
 const readiness=await pin(path.join(output,'readiness.json'),Buffer.from(JSON.stringify({schema_version:1,...identity,manifest_sha256:manifest.sha256,status:'VERIFIED',objects})+'\n'));
 const toolchainPins=[];for(let i=0;i<toolchain.length;i++){const source=await fs.realpath(toolchain[i]);const bytes=await fs.readFile(source);toolchainPins.push(await pin(path.join(output,'toolchain',String(i)+'-'+path.basename(source)),bytes));}assert(toolchainPins.length,'Actual toolchain pins required');
 const native={schema_version:1,...identity,manifest,readiness_receipt:readiness,toolchain:toolchainPins,environment:{platform:process.platform,identity:'authenticated native API snapshot; '+process.version},test_inventory_sha256:digest(Buffer.from(JSON.stringify(assertionIds)))};
 await pin(path.join(output,'native.json'),Buffer.from(JSON.stringify(native,null,2)+'\n'));return native;
}
