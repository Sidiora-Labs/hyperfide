export const SOURCE_PROTOCOL_VERSION = 1 as const;
export const SOURCE_API_PATH = '/api/v1/source-control';
export const SOURCE_FORMAT = Object.freeze({version:1,algorithm:'sha256',chunk_size:4194304,blob_threshold:4194304,max_object_bytes:8388608,max_tree_entries:256,max_tree_bytes:262144});
export type SourceObjectKind = 'blob'|'chunk'|'file'|'tree-leaf'|'tree-index'|'manifest'|'revision';
export const SOURCE_OBJECT_KINDS:readonly SourceObjectKind[] = ['blob','chunk','file','tree-leaf','tree-index','manifest','revision'];
declare const identity:unique symbol;
export type ObjectId = `sha256:${string}` & {readonly [identity]:'native-object'};
export type SourceObjectId = ObjectId;
export type TreeId = ObjectId & {readonly tree:unique symbol};
export type SourceRevision = ObjectId & {readonly revision:unique symbol};
export type SourceRevisionId = SourceRevision;
export type ChangeId = string & {readonly [identity]:'change'};
export type WorkspaceId = string & {readonly [identity]:'workspace'};
export type OperationId = string & {readonly [identity]:'operation'};
export type AuthorityGeneration = string & {readonly [identity]:'generation'};
export interface SourceScope {organisation_id:string;repository_id:string;security_domain_id:string}
export interface SourceObjectReference {scope:SourceScope;kind:SourceObjectKind;object_id:ObjectId}
export type EntryKind = 'file'|'directory'|'symlink';
export type EntryMode = '100644'|'100755'|'120000'|'040000';
export interface TreeEntry {name:string;kind:EntryKind;mode:EntryMode;object_id:ObjectId}
export interface GitIdentity {object_format:'sha1'|'sha256';oid:string;repository_url?:string}
export interface PublicProvenance {author:{name:string;email:string};message:string;timestamp:string}
export type RetryClass = 'NEVER'|'RETRY_SAME_OPERATION'|'REFRESH_AUTHORITY'|'RESUME';
export type OutcomeKnowledge = 'KNOWN'|'UNKNOWN';
export interface SourceError {code:string;message:string;retry:RetryClass;outcome:OutcomeKnowledge;details?:Record<string,unknown>}
export class SourceControlError extends Error {
 readonly code:string;readonly retry:RetryClass;readonly outcome:OutcomeKnowledge;readonly details:Record<string,unknown>|undefined;
 constructor(code:string,message:string,retry:RetryClass='NEVER',outcome:OutcomeKnowledge='KNOWN',details?:Record<string,unknown>){
  super(message);this.name='SourceControlError';this.code=code;this.retry=retry;this.outcome=outcome;this.details=details;
 }
}
export function sourceError(code:string,message:string):never {throw new SourceControlError(code,message);}
const utf8=new TextEncoder();
function text(value:unknown,label:string,max=65536):string {
 if(typeof value!=='string')sourceError('INVALID_REQUEST',label+' must be UTF-8 text');if(utf8.encode(value).length>max)sourceError('LIMIT_EXCEEDED',label+' exceeds its UTF-8 byte limit');
 for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))sourceError('INVALID_UTF8',label+' contains an unpaired surrogate');}else if(c>=0xdc00&&c<=0xdfff)sourceError('INVALID_UTF8',label+' contains an unpaired surrogate');}
 return value;
}
export function parseUUID(value:unknown,label='identity'):string {
 const result=text(value,label,36);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result))sourceError('INVALID_IDENTITY',label+' must be a lowercase UUID');return result;
}
export function parseObjectId(value:unknown):ObjectId {
 if(typeof value!=='string'||!/^sha256:[0-9a-f]{64}$/.test(value))sourceError('INVALID_IDENTITY','A typed native SHA-256 identity is required');return value as ObjectId;
}
export function parseGeneration(value:unknown):AuthorityGeneration {
 if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>18446744073709551615n)sourceError('INVALID_GENERATION','Generation must be a canonical unsigned 64-bit decimal string');return value as AuthorityGeneration;
}
function record(value:unknown,label:string):Record<string,unknown> {
 if(value===null||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))sourceError('INVALID_REQUEST',label+' must be an object');return value as Record<string,unknown>;
}
function fields(value:Record<string,unknown>,allowed:readonly string[],required:readonly string[],label:string):void {
 if(Object.keys(value).some(k=>!allowed.includes(k))||required.some(k=>!Object.hasOwn(value,k)))sourceError('INVALID_REQUEST',label+' has unknown or missing fields');
}
export function parseSourceScope(value:unknown):SourceScope {
 const x=record(value,'scope');fields(x,['organisation_id','repository_id','security_domain_id'],['organisation_id','repository_id','security_domain_id'],'scope');
 return {organisation_id:parseUUID(x.organisation_id,'organisation_id'),repository_id:parseUUID(x.repository_id,'repository_id'),security_domain_id:parseUUID(x.security_domain_id,'security_domain_id')};
}
export function parseRepositoryPath(value:unknown):string {
 const p=text(value,'path',4096);
 if(!p||p.includes('\0')||p.includes('\\')||p.startsWith('/')||/^[a-zA-Z]:/.test(p)||p.split('/').some(c=>!c||c==='.'||c==='..'||utf8.encode(c).length>255))sourceError('INVALID_PATH','Path must contain exact relative UTF-8 repository components');return p;
}
export function compareUTF8(a:string,b:string):number {
 const x=utf8.encode(text(a,'name')),y=utf8.encode(text(b,'name'));for(let i=0;i<Math.min(x.length,y.length);i++){if(x[i]!==y[i])return x[i]!-y[i]!;}return x.length-y.length;
}
export function parseTreeEntry(value:unknown):TreeEntry {
 const x=record(value,'entry');fields(x,['name','kind','mode','object_id'],['name','kind','mode','object_id'],'entry');const name=parseRepositoryPath(x.name);
 if(name.includes('/')||!['file','directory','symlink'].includes(String(x.kind))||!(x.kind==='file'&&['100644','100755'].includes(String(x.mode))||x.kind==='directory'&&x.mode==='040000'||x.kind==='symlink'&&x.mode==='120000'))sourceError('INVALID_TREE_ENTRY','Entry type, mode or component is invalid');
 return {name,kind:x.kind as EntryKind,mode:x.mode as EntryMode,object_id:parseObjectId(x.object_id)};
}
export function parseGitIdentity(value:unknown):GitIdentity {
 const x=record(value,'git identity');fields(x,['object_format','oid','repository_url'],['object_format','oid'],'git identity');
 if(!['sha1','sha256'].includes(String(x.object_format))||typeof x.oid!=='string'||!(x.object_format==='sha1'?/^[0-9a-f]{40}$/:/^[0-9a-f]{64}$/).test(x.oid))sourceError('INVALID_IDENTITY','Explicit Git format and raw OID required');
 const result:GitIdentity={object_format:x.object_format as 'sha1'|'sha256',oid:x.oid};if(x.repository_url!==undefined)result.repository_url=text(x.repository_url,'repository_url',4096);return result;
}
export function parsePublicProvenance(value:unknown):PublicProvenance {
 const x=record(value,'provenance');fields(x,['author','message','timestamp'],['author','message','timestamp'],'provenance');const author=record(x.author,'author');fields(author,['name','email'],['name','email'],'author');
 const timestamp=text(x.timestamp,'timestamp',32);if(!Number.isFinite(Date.parse(timestamp))||new Date(timestamp).toISOString()!==timestamp)sourceError('INVALID_REQUEST','Timestamp must be canonical UTC ISO-8601');
 return {author:{name:text(author.name,'author name',1024),email:text(author.email,'author email',1024)},message:text(x.message,'message',65536),timestamp};
}
export function canonicalJSON(value:unknown,maxStringBytes=65536):string {
 if(!Number.isSafeInteger(maxStringBytes)||maxStringBytes<1||maxStringBytes>12582912)sourceError('INVALID_REQUEST','Invalid canonical string byte bound');
 const active=new Set<object>();
 function encode(v:unknown,depth:number):string {
  if(depth>64)sourceError('LIMIT_EXCEEDED','Canonical value nesting exceeds the limit');
  if(v===null)return 'null';if(typeof v==='string')return JSON.stringify(text(v,'canonical string',maxStringBytes));
  if(typeof v==='boolean')return String(v);if(typeof v==='number'){if(!Number.isSafeInteger(v)||Object.is(v,-0))sourceError('INVALID_INTEGER','Canonical numbers must be safe integers');return String(v);}
  if(typeof v!=='object')sourceError('INVALID_REQUEST','Unsupported canonical value');
  if(active.has(v))sourceError('INVALID_REQUEST','Canonical values cannot contain cycles');active.add(v);
  let result:string;
  if(Array.isArray(v)){if(Object.keys(v).length!==v.length)sourceError('INVALID_REQUEST','Canonical arrays must be dense');result='['+v.map(item=>encode(item,depth+1)).join(',')+']';}
  else{const obj=record(v,'canonical value');const keys=Object.keys(obj).sort(compareUTF8);result='{'+keys.map(k=>JSON.stringify(text(k,'canonical key'))+':'+encode(obj[k],depth+1)).join(',')+'}';}
  active.delete(v);return result;
 }
 return encode(value,0);
}
export function canonicalBytes(value:unknown,maxStringBytes=65536):Uint8Array {return utf8.encode(canonicalJSON(value,maxStringBytes));}
export function canonicalEnvelope(kind:SourceObjectKind,payload:Uint8Array):Uint8Array {
 if(!SOURCE_OBJECT_KINDS.includes(kind)||!(payload instanceof Uint8Array))sourceError('INVALID_OBJECT','Known kind and exact payload bytes required');
 const header=utf8.encode('hyperfide-source-control\0v1\0'+kind+'\0'+payload.byteLength+'\0');const result=new Uint8Array(header.length+payload.length);result.set(header);result.set(payload,header.length);return result;
}
export function decodeCanonicalEnvelope(value:Uint8Array,expectedKind?:SourceObjectKind):{kind:SourceObjectKind;payload:Uint8Array} {
 if(!(value instanceof Uint8Array))sourceError('INVALID_OBJECT','Object envelope bytes required');let offset=0;
 const field=()=>{const end=value.indexOf(0,offset);if(end<0)sourceError('INVALID_OBJECT','Truncated object header');let out:string;try{out=new TextDecoder('utf-8',{fatal:true}).decode(value.subarray(offset,end));}catch{sourceError('INVALID_UTF8','Object header is not UTF-8');}offset=end+1;return out;};
 if(field()!=='hyperfide-source-control'||field()!=='v1')sourceError('UNSUPPORTED_VERSION','Unsupported native object envelope');const kind=field() as SourceObjectKind,length=field();
 if(!SOURCE_OBJECT_KINDS.includes(kind)||expectedKind!==undefined&&kind!==expectedKind)sourceError('OBJECT_KIND_MISMATCH','Object kind differs from the requested identity');
 if(!/^(0|[1-9][0-9]*)$/.test(length)||BigInt(length)!==BigInt(value.length-offset))sourceError('INVALID_OBJECT','Object payload length differs from its canonical header');return {kind,payload:value.slice(offset)};
}
export function parseStrictJSON(input:string|Uint8Array,maxBytes=1048576):unknown {
 let body:string;if(typeof input==='string')body=text(input,'JSON',maxBytes);else{if(!(input instanceof Uint8Array)||input.byteLength>maxBytes)sourceError('LIMIT_EXCEEDED','JSON exceeds the byte limit');try{body=new TextDecoder('utf-8',{fatal:true}).decode(input);}catch{sourceError('INVALID_UTF8','JSON is not valid UTF-8');}}
 let pos=0;const ws=()=>{while(/[ \n\r\t]/.test(body[pos]??'x'))pos++;};
 const string=()=>{const start=pos++;while(pos<body.length){const c=body[pos++];if(c==='"'){let result:unknown;try{result=JSON.parse(body.slice(start,pos));}catch{sourceError('INVALID_JSON','Malformed JSON string');}return text(result,'JSON string',maxBytes);}if(c==='\\')pos++;}return sourceError('INVALID_JSON','Unterminated JSON string');};
 const parse=(depth:number):unknown=>{if(depth>64)sourceError('LIMIT_EXCEEDED','JSON nesting exceeds the limit');ws();const c=body[pos];if(c==='"')return string();if(c==='['){pos++;ws();const out:unknown[]=[];if(body[pos]===']'){pos++;return out;}for(;;){out.push(parse(depth+1));ws();if(body[pos++]===']')return out;if(body[pos-1]!==',')sourceError('INVALID_JSON','Malformed JSON array');}}
  if(c==='{'){pos++;ws();const out:Record<string,unknown>=Object.create(null);if(body[pos]==='}'){pos++;return out;}for(;;){ws();if(body[pos]!=='"')sourceError('INVALID_JSON','JSON object key required');const key=string();if(Object.hasOwn(out,key))sourceError('DUPLICATE_FIELD','Duplicate JSON object key');ws();if(body[pos++]!==':')sourceError('INVALID_JSON','Missing JSON colon');out[key]=parse(depth+1);ws();if(body[pos++]==='}')return out;if(body[pos-1]!==',')sourceError('INVALID_JSON','Malformed JSON object');}}
  for(const [literal,result]of [['true',true],['false',false],['null',null]] as const){if(body.startsWith(literal,pos)){pos+=literal.length;return result;}}
  const match=/^-?(?:0|[1-9][0-9]*)/.exec(body.slice(pos));if(match){pos+=match[0].length;const result=Number(match[0]);if(!Number.isSafeInteger(result)||Object.is(result,-0))sourceError('INVALID_INTEGER','JSON number must be a safe canonical integer');return result;}return sourceError('INVALID_JSON','Malformed JSON value');};
 const result=parse(0);ws();if(pos!==body.length)sourceError('INVALID_JSON','Unexpected JSON trailing bytes');return result;
}
export const SOURCE_ACTIONS = ['source.capabilities','source.capabilities.manage','source.objects.put','source.objects.read','source.objects.inspect','source.uploads.prepare','source.uploads.complete','source.trees.entries','source.trees.lookup','source.trees.patch','source.revisions.create','source.revisions.read','source.changes.revisions','source.operations.read','source.operations.cancel','source.queries.ancestry','source.queries.merge-bases','source.queries.history','source.queries.diff','source.queries.blame','source.queries.line-map','source.workspaces.open','source.workspaces.detail','source.workspaces.checkpoint','source.workspaces.widen','source.workspaces.close','source.subscriptions.create','source.subscriptions.poll','source.subscriptions.ack','source.transfers.create','source.audit.read','source.transforms.merge','source.transforms.rebase','source.transforms.revert','source.transforms.read','source.transforms.resume'] as const;
export type SourceAction = typeof SOURCE_ACTIONS[number];
export interface SourceCodecOptions {action?:SourceAction}
const wireLimit=(action:unknown)=>action==='source.objects.put'||action==='source.objects.read'?12582912:1048576;
export type OperationState = 'ADMITTED'|'RUNNING'|'SUCCEEDED'|'CONFLICTED'|'FAILED'|'CANCELLED'|'OUTCOME_UNKNOWN';
export type WorkspaceState = 'OPEN'|'PREPARING'|'READY'|'DIRTY'|'CHECKPOINT_PENDING'|'CONFLICTED'|'CLOSED'|'REVOKED';
export type UploadState = 'UPLOADING'|'VERIFYING'|'VERIFIED'|'OUTCOME_UNKNOWN'|'ABANDONED';
export type ObjectState = 'UPLOADING'|'VERIFIED'|'QUARANTINED'|'DELETE_PENDING'|'ABSENT';
export type SourceLifecycle = 'CREATED'|'SUBMITTED'|'QUALIFIED'|'ACCEPTED'|'REMOTELY_PUBLISHED';
export interface SourceAuthority {authority_epoch:string;generation:string;policy_version:string;workspace?:{workspace_id:string;workspace_generation:string};managed?:{task_id:string;attempt_id:string;attempt_generation:string}}
export interface SourceRequest<T=unknown> {protocol_version:1;scope:SourceScope;operation_id:string;action:SourceAction;input:T;authority?:SourceAuthority;idempotency_key?:string}
export type SourceResponse<T=unknown> = {protocol_version:1;operation_id:string;result:T}|{protocol_version:1;operation_id:string;error:SourceError};
export interface SourcePage<T> {items:T[];next_cursor:string|null;coverage:'COMPLETE'|'PARTIAL'|'REDACTED'|'INDEX_PENDING';snapshot:ObjectId;index_generation?:string}
export function parseSourceAuthority(value:unknown):SourceAuthority {
 const x=record(value,'authority');fields(x,['authority_epoch','generation','policy_version','workspace','managed'],['authority_epoch','generation','policy_version'],'authority');
 const result:SourceAuthority={authority_epoch:parseGeneration(x.authority_epoch),generation:parseGeneration(x.generation),policy_version:text(x.policy_version,'policy_version',256)};
 if(x.workspace!==undefined){const w=record(x.workspace,'workspace authority');fields(w,['workspace_id','workspace_generation'],['workspace_id','workspace_generation'],'workspace authority');result.workspace={workspace_id:parseUUID(w.workspace_id),workspace_generation:parseGeneration(w.workspace_generation)};}
 if(x.managed!==undefined){const m=record(x.managed,'managed authority');fields(m,['task_id','attempt_id','attempt_generation'],['task_id','attempt_id','attempt_generation'],'managed authority');result.managed={task_id:parseUUID(m.task_id),attempt_id:parseUUID(m.attempt_id),attempt_generation:parseGeneration(m.attempt_generation)};}return result;
}
export function parseSourceRequest<T=unknown>(value:unknown):SourceRequest<T> {
 const x=record(value,'source request');fields(x,['protocol_version','scope','operation_id','action','input','authority','idempotency_key'],['protocol_version','scope','operation_id','action','input'],'source request');
 if(x.protocol_version!==SOURCE_PROTOCOL_VERSION)sourceError('UNSUPPORTED_VERSION','Source protocol version is unsupported');if(!SOURCE_ACTIONS.includes(x.action as SourceAction))sourceError('UNSUPPORTED_ACTION','Source action is unsupported');canonicalJSON(x.input,wireLimit(x.action));
 const result:SourceRequest<T>={protocol_version:1,scope:parseSourceScope(x.scope),operation_id:parseUUID(x.operation_id,'operation_id'),action:x.action as SourceAction,input:x.input as T};if(x.authority!==undefined)result.authority=parseSourceAuthority(x.authority);if(x.idempotency_key!==undefined)result.idempotency_key=parseUUID(x.idempotency_key,'idempotency_key');if(canonicalBytes(result,wireLimit(x.action)).byteLength>wireLimit(x.action))sourceError('LIMIT_EXCEEDED','Source request exceeds its byte limit');return result;
}
export function encodeSourceRequest(value:SourceRequest):Uint8Array {const parsed=parseSourceRequest(value);return canonicalBytes(parsed,wireLimit(parsed.action));}
export function decodeSourceRequest(value:string|Uint8Array):SourceRequest {return parseSourceRequest(parseStrictJSON(value,12582912));}
export function parseSourceResponse<T=unknown>(value:unknown,options:SourceCodecOptions={}):SourceResponse<T> {
 const x=record(value,'source response');const success=Object.hasOwn(x,'result');fields(x,['protocol_version','operation_id',success?'result':'error'],['protocol_version','operation_id',success?'result':'error'],'source response');
 if(x.protocol_version!==1)sourceError('UNSUPPORTED_VERSION','Source response version is unsupported');const operation_id=parseUUID(x.operation_id,'operation_id');if(success){const response={protocol_version:1 as const,operation_id,result:x.result as T};if(canonicalBytes(response,wireLimit(options.action)).byteLength>wireLimit(options.action))sourceError('LIMIT_EXCEEDED','Source response exceeds its byte limit');return response;}
 const e=record(x.error,'source error');fields(e,['code','message','retry','outcome','details'],['code','message','retry','outcome'],'source error');if(typeof e.code!=='string'||!/^[_A-Z][_A-Z0-9]{0,63}$/.test(e.code)||!['NEVER','RETRY_SAME_OPERATION','REFRESH_AUTHORITY','RESUME'].includes(String(e.retry))||!['KNOWN','UNKNOWN'].includes(String(e.outcome)))sourceError('INVALID_REQUEST','Invalid source error semantics');const error:SourceError={code:e.code,message:text(e.message,'error message',4096),retry:e.retry as RetryClass,outcome:e.outcome as OutcomeKnowledge};if(e.details!==undefined){error.details=record(e.details,'error details');canonicalJSON(error.details);}return {protocol_version:1,operation_id,error};
}
export function encodeSourceResponse(value:SourceResponse,options:SourceCodecOptions={}):Uint8Array {const encoded=canonicalBytes(parseSourceResponse(value,options),wireLimit(options.action));if(encoded.byteLength>wireLimit(options.action))sourceError('LIMIT_EXCEEDED','Source response exceeds its byte limit');return encoded;}
export function decodeSourceResponse(value:string|Uint8Array,options:SourceCodecOptions={}):SourceResponse {return parseSourceResponse(parseStrictJSON(value,wireLimit(options.action)),options);}
export interface SourceCapabilities {protocol_versions:number[];object_versions:number[];hash_algorithms:string[];actions:SourceAction[];capabilities:string[];limits:{request_bytes:number;response_bytes:number;content_transfer_bytes:number;page_items:number;object_bytes:number;tree_entries:number;tree_bytes:number}}
export const SOURCE_CAPABILITIES:SourceCapabilities={protocol_versions:[1],object_versions:[1],hash_algorithms:['sha256'],actions:[...SOURCE_ACTIONS],capabilities:['api-only','sparse-workspaces','scoped-objects','durable-operations'],limits:{request_bytes:1048576,response_bytes:1048576,content_transfer_bytes:12582912,page_items:256,object_bytes:SOURCE_FORMAT.max_object_bytes,tree_entries:SOURCE_FORMAT.max_tree_entries,tree_bytes:SOURCE_FORMAT.max_tree_bytes}};
export function negotiateSourceCapabilities(request:{protocol_versions:readonly number[];required_capabilities:readonly string[]},server:SourceCapabilities=SOURCE_CAPABILITIES):{protocol_version:1;object_version:1;hash_algorithm:'sha256'} {
 if(!request.protocol_versions.includes(1)||!server.protocol_versions.includes(1)||!server.object_versions.includes(1)||!server.hash_algorithms.includes('sha256'))sourceError('UNSUPPORTED_VERSION','No supported source protocol/object version');if(request.required_capabilities.some(c=>!server.capabilities.includes(c)))sourceError('UNSUPPORTED_CAPABILITY','A required source capability is unavailable');return {protocol_version:1,object_version:1,hash_algorithm:'sha256'};
}
export function assertOperationTransition(from:OperationState,to:OperationState):void {
 const allowed:Record<OperationState,readonly OperationState[]>={ADMITTED:['RUNNING','CANCELLED','FAILED','OUTCOME_UNKNOWN'],RUNNING:['SUCCEEDED','CONFLICTED','FAILED','CANCELLED','OUTCOME_UNKNOWN'],OUTCOME_UNKNOWN:['RUNNING','SUCCEEDED','CONFLICTED','FAILED','CANCELLED'],SUCCEEDED:[],CONFLICTED:[],FAILED:[],CANCELLED:[]};if(!Object.hasOwn(allowed,from)||!allowed[from].includes(to))sourceError('INVALID_STATE_TRANSITION','Operation lifecycle transition is not permitted');
}

function state<T extends string>(value:unknown,values:readonly T[]):T {if(typeof value!=='string'||!values.includes(value as T))sourceError('INVALID_STATE','Unknown source lifecycle state');return value as T;}
export const parseOperationState=(value:unknown):OperationState=>state(value,['ADMITTED','RUNNING','SUCCEEDED','CONFLICTED','FAILED','CANCELLED','OUTCOME_UNKNOWN']);
export const parseWorkspaceState=(value:unknown):WorkspaceState=>state(value,['OPEN','PREPARING','READY','DIRTY','CHECKPOINT_PENDING','CONFLICTED','CLOSED','REVOKED']);
export const parseUploadState=(value:unknown):UploadState=>state(value,['UPLOADING','VERIFYING','VERIFIED','OUTCOME_UNKNOWN','ABANDONED']);
export const parseObjectState=(value:unknown):ObjectState=>state(value,['UPLOADING','VERIFIED','QUARANTINED','DELETE_PENDING','ABSENT']);
export const parseSourceLifecycle=(value:unknown):SourceLifecycle=>state(value,['CREATED','SUBMITTED','QUALIFIED','ACCEPTED','REMOTELY_PUBLISHED']);
