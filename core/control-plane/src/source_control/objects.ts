import {createHash,randomUUID} from 'node:crypto';
import {canonicalEnvelope,decodeCanonicalEnvelope,parseObjectId,parseTreeEntry,compareUTF8,canonicalBytes,parseStrictJSON,sourceError,SOURCE_FORMAT} from './contracts.js';
import type {SourceObjectKind,TreeEntry,ObjectId} from './contracts.js';
import type {ObjectUpload,SourceObjectBackend,SourceObjectCatalog,SourceStorageScope,StoredObject,VerifiedObject} from './storage_contract.js';
export const FILE_CHUNK_BYTES=SOURCE_FORMAT.chunk_size;
export interface FileDescriptor {size_bytes:string;content_digest:string;content:{kind:'blob';object_id:string}|{kind:'chunks';chunks:readonly {object_id:string;size_bytes:string}[]}}
export type TreeNode={kind:'tree-leaf';prefix:string;entries:TreeEntry[];count:number}|{kind:'tree-index';prefix:string;children:{digit:string;object_id:string;count:number}[];count:number};
const rawHash=(bytes:Uint8Array)=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
export function sourceObjectId(kind:SourceObjectKind,payload:Uint8Array):ObjectId{return parseObjectId(rawHash(canonicalEnvelope(kind,payload)));}
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)&&v.length<=20;
function tuple(payload:Uint8Array,max:number=SOURCE_FORMAT.max_object_bytes):any[]{const value=parseStrictJSON(payload,max);if(!Array.isArray(value)||!Buffer.from(canonicalBytes(value)).equals(Buffer.from(payload)))sourceError('NON_CANONICAL_OBJECT','Metadata requires exact canonical tuple bytes');return value;}
export function encodeFileDescriptor(file:FileDescriptor):Buffer{return Buffer.from(canonicalBytes([1,file.size_bytes,file.content_digest,file.content.kind==='blob'?['blob',file.content.object_id]:['chunks',file.content.chunks.map(c=>[c.object_id,c.size_bytes])]]));}
export function decodeFileDescriptor(payload:Uint8Array):FileDescriptor {
 const value=tuple(payload);if(value.length!==4||value[0]!==1||!decimal(value[1])||!Array.isArray(value[3]))sourceError('INVALID_FILE','Malformed v1 file descriptor');parseObjectId(value[2]);
 const size=BigInt(value[1]),content=value[3];if(size>BigInt(FILE_CHUNK_BYTES)*4096n)sourceError('FILE_LIMIT','File exceeds v1 chunk descriptor bound');
 if(content[0]==='blob'&&content.length===2){parseObjectId(content[1]);if(size>BigInt(FILE_CHUNK_BYTES))sourceError('INVALID_FILE','Large files require chunked encoding');return {size_bytes:value[1],content_digest:value[2],content:{kind:'blob',object_id:content[1]}};}
 if(content[0]!=='chunks'||content.length!==2||!Array.isArray(content[1])||content[1].length<2||content[1].length>4096||size<=BigInt(FILE_CHUNK_BYTES))sourceError('INVALID_FILE','Canonical ordered chunk descriptor required');
 const chunks:{object_id:string;size_bytes:string}[]=[];let total=0n;
 for(let i=0;i<content[1].length;i++){const part=content[1][i];if(!Array.isArray(part)||part.length!==2||!decimal(part[1]))sourceError('INVALID_FILE','Malformed file chunk');parseObjectId(part[0]);const n=BigInt(part[1]);if(n<1n||n>BigInt(FILE_CHUNK_BYTES)||i<content[1].length-1&&n!==BigInt(FILE_CHUNK_BYTES))sourceError('INVALID_FILE','Noncanonical file chunk length');total+=n;chunks.push({object_id:part[0],size_bytes:part[1]});}
 if(total!==size)sourceError('INVALID_FILE','File chunk lengths differ from logical size');return {size_bytes:value[1],content_digest:value[2],content:{kind:'chunks',chunks}};
}
export function treeNameKey(name:string):string{return Buffer.from(name,'utf8').toString('hex')+'!';}
export function encodeTreeNode(node:TreeNode):Buffer{return Buffer.from(canonicalBytes(node.kind==='tree-leaf'?[1,node.prefix,node.entries.map(e=>[e.name,e.kind,e.mode,e.object_id])]:[1,node.prefix,String(node.count),node.children.map(c=>[c.digit,c.object_id,String(c.count)])]));}
export function decodeTreeNode(kind:'tree-leaf'|'tree-index',payload:Uint8Array):TreeNode {
 const value=tuple(payload,SOURCE_FORMAT.max_tree_bytes);if(value[0]!==1||typeof value[1]!=='string'||!/^[0-9a-f]*!?$/.test(value[1])||value[1].length>8193)sourceError('INVALID_TREE','Malformed radix prefix');
 const prefix=value[1];
 if(kind==='tree-leaf'){
  if(value.length!==3||!Array.isArray(value[2])||value[2].length>SOURCE_FORMAT.max_tree_entries)sourceError('TREE_LIMIT','Bounded tree leaf required');
  const entries:TreeEntry[]=value[2].map((e:unknown)=>{if(!Array.isArray(e)||e.length!==4)sourceError('INVALID_TREE','Malformed tree entry tuple');return parseTreeEntry({name:e[0],kind:e[1],mode:e[2],object_id:e[3]});});
  for(let i=0;i<entries.length;i++){if(!treeNameKey(entries[i]!.name).startsWith(prefix)||i>0&&compareUTF8(entries[i-1]!.name,entries[i]!.name)>=0)sourceError('INVALID_TREE','Tree leaf names must be unique sorted prefix members');}
  return {kind,prefix,entries,count:entries.length};
 }
 if(value.length!==4||!decimal(value[2])||!Array.isArray(value[3])||value[3].length<1||value[3].length>17||prefix.includes('!'))sourceError('INVALID_TREE','Malformed radix index');
 let count=0;const children:{digit:string;object_id:string;count:number}[]=[];
 for(const child of value[3]){if(!Array.isArray(child)||child.length!==3||typeof child[0]!=='string'||!/^[!0-9a-f]$/.test(child[0])||!decimal(child[2])||BigInt(child[2])<1n||BigInt(child[2])>BigInt(Number.MAX_SAFE_INTEGER)||children.length&&children.at(-1)!.digit>=child[0])sourceError('INVALID_TREE','Canonical disjoint radix children required');parseObjectId(child[1]);count+=Number(child[2]);if(!Number.isSafeInteger(count))sourceError('TREE_LIMIT','Tree entry count exceeds exact range');children.push({digit:child[0],object_id:child[1],count:Number(child[2])});}
 if(count!==Number(value[2])||count<=SOURCE_FORMAT.max_tree_entries)sourceError('INVALID_TREE','Index count or split threshold differs');return {kind,prefix,children,count};
}
export class SourceObjectService {
 constructor(readonly catalog:SourceObjectCatalog,readonly backend:SourceObjectBackend){}
 async inspect(scope:SourceStorageScope,id:string):Promise<StoredObject|null>{return this.catalog.lookup(scope,id);}
 async beginUpload(scope:SourceStorageScope,input:{operation_id:string;object_id:string;kind:SourceObjectKind;size_bytes:string;owner_principal_id:string}):Promise<ObjectUpload>{return this.catalog.begin(scope,input);}
 async put(scope:SourceStorageScope,kind:SourceObjectKind,payload:Uint8Array,operation_id:string=randomUUID(),owner_principal_id?:string):Promise<VerifiedObject>{
 const bytes=Buffer.from(canonicalEnvelope(kind,payload));if(bytes.length>SOURCE_FORMAT.max_object_bytes)sourceError('OBJECT_LIMIT','Object exceeds format byte bound');
 const id=sourceObjectId(kind,payload),upload=await this.catalog.begin(scope,{operation_id,object_id:id,kind,size_bytes:String(bytes.length),...(owner_principal_id?{owner_principal_id}:{})});
 if(upload.status==='VERIFIED')return this.verifyRead(scope,upload);
 const outcome=await this.backend.put(upload.storage_key,bytes);if(outcome==='UNKNOWN')await this.catalog.unknown(scope,upload.upload_id);
 return this.completeUpload(scope,upload.upload_id);
 }
 private async verifyRead(scope:SourceStorageScope,row:StoredObject):Promise<VerifiedObject>{await this.read(scope,row.object_id);return {...row,state:'VERIFIED'};}
 async completeUpload(scope:SourceStorageScope,id:string):Promise<VerifiedObject>{
 const upload=await this.catalog.upload(scope,id),observation=await this.backend.read(upload.storage_key,Number(upload.size_bytes));
 if(observation.state!=='PRESENT'){await this.catalog.unknown(scope,id);sourceError('OBJECT_UNAVAILABLE','Upload outcome requires reconciliation');}
 const value=this.verifyBytes(upload,observation.bytes),children=await this.validatePayload(scope,value.kind,value.payload);
 const tree_prefix=value.kind==='tree-leaf'||value.kind==='tree-index'?decodeTreeNode(value.kind,value.payload).prefix:null;
 return this.catalog.verify(scope,id,children,{tree_prefix});
 }
 private verifyBytes(row:StoredObject,bytes:Buffer):{kind:SourceObjectKind;payload:Buffer}{
 if(bytes.length!==Number(row.size_bytes)||rawHash(bytes)!==row.object_id)sourceError('OBJECT_INTEGRITY','Native object envelope checksum or length differs');
 const decoded=decodeCanonicalEnvelope(bytes,row.kind);return {kind:decoded.kind,payload:Buffer.from(decoded.payload)};
 }
 async read(scope:SourceStorageScope,id:string):Promise<{object_id:string;kind:SourceObjectKind;payload:Buffer}>{
 const row=await this.catalog.lookup(scope,id);if(!row||row.state!=='VERIFIED')sourceError('OBJECT_NOT_READY','Source object is unavailable');
 const observed=await this.backend.read(row.storage_key,Number(row.size_bytes));if(observed.state!=='PRESENT')sourceError('OBJECT_UNAVAILABLE','Retained source bytes are unavailable');return {object_id:id,...this.verifyBytes(row,observed.bytes)};
 }
 private async validatePayload(scope:SourceStorageScope,kind:SourceObjectKind,payload:Buffer):Promise<string[]>{
 if(kind==='blob'||kind==='chunk'){if(payload.length>FILE_CHUNK_BYTES||kind==='chunk'&&payload.length===0)sourceError('OBJECT_LIMIT','Blob/chunk exceeds the v1 format limit');return [];}
 if(kind==='file'){
  const file=decodeFileDescriptor(payload),hash=createHash('sha256');let total=0;const chunks=file.content.kind==='blob'?[{object_id:file.content.object_id,size_bytes:file.size_bytes}]:file.content.chunks;
  for(const chunk of chunks){const child=await this.read(scope,chunk.object_id);if(child.kind!==(file.content.kind==='blob'?'blob':'chunk')||child.payload.length!==Number(chunk.size_bytes))sourceError('INVALID_FILE','File child kind/length differs');hash.update(child.payload);total+=child.payload.length;}
  if(String(total)!==file.size_bytes||'sha256:'+hash.digest('hex')!==file.content_digest)sourceError('OBJECT_INTEGRITY','Whole file payload checksum differs');return chunks.map(c=>c.object_id);
 }
 if(kind==='tree-leaf'||kind==='tree-index'){
  const node=decodeTreeNode(kind,payload);
  if(node.kind==='tree-leaf'){for(const entry of node.entries){const child=await this.catalog.lookup(scope,entry.object_id);if(!child||child.state!=='VERIFIED'||(entry.kind==='directory'?!['tree-leaf','tree-index'].includes(child.kind)||child.tree_prefix!=='':child.kind!==(entry.kind==='file'?'file':'blob')))sourceError('INVALID_TREE','Tree entry child is not ready with the declared kind');}return node.entries.map(e=>e.object_id);}
  for(const child of node.children){const object=await this.read(scope,child.object_id);if(object.kind!=='tree-leaf'&&object.kind!=='tree-index')sourceError('INVALID_TREE','Radix index child is not a tree node');const parsed=decodeTreeNode(object.kind,object.payload);if(parsed.prefix!==node.prefix+child.digit||parsed.count!==child.count)sourceError('INVALID_TREE','Radix child prefix/count differs');}return node.children.map(c=>c.object_id);
 }
 sourceError('UNSUPPORTED_OBJECT_KIND','This source object schema has no registered closure verifier');
 }
 async putFile(scope:SourceStorageScope,bytes:Uint8Array):Promise<VerifiedObject>{
 const parts:{object_id:string;size_bytes:string}[]=[];if(bytes.length<=FILE_CHUNK_BYTES){const blob=await this.put(scope,'blob',bytes);return this.put(scope,'file',encodeFileDescriptor({size_bytes:String(bytes.length),content_digest:rawHash(bytes),content:{kind:'blob',object_id:blob.object_id}}));}
 if(bytes.length>FILE_CHUNK_BYTES*4096)sourceError('FILE_LIMIT','File exceeds the v1 descriptor limit');
 for(let offset=0;offset<bytes.length;offset+=FILE_CHUNK_BYTES){const part=bytes.subarray(offset,Math.min(bytes.length,offset+FILE_CHUNK_BYTES)),object=await this.put(scope,'chunk',part);parts.push({object_id:object.object_id,size_bytes:String(part.length)});}
 return this.put(scope,'file',encodeFileDescriptor({size_bytes:String(bytes.length),content_digest:rawHash(bytes),content:{kind:'chunks',chunks:parts}}));
 }
 async readFile(scope:SourceStorageScope,id:string,range:{offset?:number;length?:number}={}):Promise<Buffer>{
 const object=await this.read(scope,id);if(object.kind!=='file')sourceError('INVALID_FILE','Logical file read requires a file descriptor');const file=decodeFileDescriptor(object.payload),size=Number(file.size_bytes),start=range.offset??0,end=range.length===undefined?size:start+range.length;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>size||end-start>SOURCE_FORMAT.max_object_bytes)sourceError('RANGE_LIMIT','Read a bounded valid file range');
 const chunks=file.content.kind==='blob'?[{object_id:file.content.object_id,size_bytes:file.size_bytes}]:file.content.chunks;let offset=0;const parts:Buffer[]=[];
 for(const chunk of chunks){const length=Number(chunk.size_bytes);if(offset<end&&offset+length>start||size===0){const value=await this.read(scope,chunk.object_id);if(value.kind!==(file.content.kind==='blob'?'blob':'chunk')||value.payload.length!==length)sourceError('OBJECT_INTEGRITY','File chunk differs');parts.push(value.payload.subarray(Math.max(0,start-offset),Math.min(length,end-offset)));}offset+=length;}
 const bytes=Buffer.concat(parts);if(start===0&&end===size&&rawHash(bytes)!==file.content_digest)sourceError('OBJECT_INTEGRITY','Logical file checksum differs');return bytes;
 }
}
