import assert from 'node:assert/strict';
import {createHash,createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
export const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
export const canonical=value=>JSON.stringify(value);
export const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const hash=value=>createHash('sha256').update(value).digest('hex');
export function s3Configuration(env){
 const required=(...names)=>{for(const name of names)if(env[name])return env[name];throw Error('Missing mailbox storage configuration');};
 return {endpoint:required('HF_SOURCE_S3_ENDPOINT','HF_ARTIFACT_S3_ENDPOINT','HF_ARTIFACT_S3_URL'),region:required('HF_SOURCE_S3_REGION','HF_ARTIFACT_S3_REGION'),bucket:required('HF_SOURCE_S3_BUCKET','HF_ARTIFACT_S3_BUCKET'),access_key:required('HF_SOURCE_S3_ACCESS_KEY_ID','HF_ARTIFACT_S3_ACCESS_KEY_ID','HF_ARTIFACT_S3_ACCESS_KEY'),secret_key:required('HF_SOURCE_S3_SECRET_ACCESS_KEY','HF_ARTIFACT_S3_SECRET_ACCESS_KEY','HF_ARTIFACT_S3_SECRET_KEY'),session_token:env.HF_SOURCE_S3_SESSION_TOKEN??env.HF_ARTIFACT_S3_SESSION_TOKEN};
}
export function mailboxStorage(config){
 const origin=new URL(config.endpoint);assert.equal(origin.protocol,'https:');assert.equal(origin.pathname,'/');assert(!origin.search&&!origin.hash&&!origin.username&&!origin.password);assert(config.bucket&&config.region&&config.access_key&&config.secret_key);
 const signing=(day)=>hmac(hmac(hmac(hmac('AWS4'+config.secret_key,day),config.region),'s3'),'aws4_request');
 const target=key=>{assert(typeof key==='string'&&key.startsWith('campaign-mailbox/v1/')&&!key.split('/').some(x=>!x||x==='.'||x==='..'));return '/'+encode(config.bucket)+'/'+key.split('/').map(encode).join('/');};
 function signed(method,key,{query=[],body=Buffer.alloc(0),conditional=false,presignSeconds}={}){
  const date=new Date().toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=day+'/'+config.region+'/s3/aws4_request',pathname=key===null?'/'+encode(config.bucket):target(key),headers={host:origin.host};
  if(conditional)headers['if-none-match']='*';
  let parameters=[...query],payload;
  if(presignSeconds){assert(Number.isSafeInteger(presignSeconds)&&presignSeconds>0&&presignSeconds<=604800);parameters.push(['X-Amz-Algorithm','AWS4-HMAC-SHA256'],['X-Amz-Credential',config.access_key+'/'+scope],['X-Amz-Date',date],['X-Amz-Expires',String(presignSeconds)],['X-Amz-SignedHeaders',Object.keys(headers).sort().join(';')]);if(config.session_token)parameters.push(['X-Amz-Security-Token',config.session_token]);payload='UNSIGNED-PAYLOAD';}
  else{headers['x-amz-date']=date;headers['x-amz-content-sha256']=hash(body);if(config.session_token)headers['x-amz-security-token']=config.session_token;payload=hash(body);}
  const queryText=parameters.map(([k,v])=>[encode(k),encode(v)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([k,v])=>k+'='+v).join('&'),names=Object.keys(headers).sort();
  const request=[method,pathname,queryText,names.map(k=>k+':'+headers[k].trim()+'\n').join(''),names.join(';'),payload].join('\n');
  const signature=hmac(signing(day),'AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+hash(request)).toString('hex');
  if(presignSeconds)return new URL(pathname+'?'+queryText+'&X-Amz-Signature='+signature,origin).href;
  headers.authorization='AWS4-HMAC-SHA256 Credential='+config.access_key+'/'+scope+', SignedHeaders='+names.join(';')+', Signature='+signature;
  return {url:new URL(pathname+(queryText?'?'+queryText:''),origin),headers};
 }
 return {presign:(method,key,seconds,conditional=false)=>signed(method,key,{presignSeconds:seconds,conditional}),async request(method,key,options={}){const body=options.body??Buffer.alloc(0),request=signed(method,key,{...options,body});return fetch(request.url,{method,headers:request.headers,redirect:'error',signal:AbortSignal.timeout(30000),...(['PUT','POST'].includes(method)?{body}: {})});}};
}
export async function boundedBody(response,limit){
 assert(Number.isSafeInteger(limit)&&limit>0);const chunks=[];let size=0;const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw Error('Mailbox payload exceeds bound');}chunks.push(value);}}finally{reader.releaseLock();}return Buffer.concat(chunks);
}
export async function jsonGet(url,limit){const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});if(response.status===404){await response.body?.cancel();return null;}assert.equal(response.status,200,'Mailbox response read failed');return JSON.parse((await boundedBody(response,limit)).toString('utf8'));}
export function exactScope(actual,config){assert.deepEqual(actual.scope,config.scope);assert.deepEqual(actual.deployment_identity,config.deployment_identity);}
export function equalSecret(a,b){const left=Buffer.from(a??''),right=Buffer.from(b??'');return left.length===right.length&&timingSafeEqual(left,right);}
export async function atomicJSON(filename,value){await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o700});const tmp=filename+'.tmp-'+randomUUID(),handle=await fs.open(tmp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(canonical(value)+'\n');await handle.sync();}finally{await handle.close();}await fs.rename(tmp,filename);}
export async function packageEvidence(directory,result,limit=16777216){
 assert.equal(result.status,'PASS');assert(Array.isArray(result.evidence)&&result.evidence.length);const files=[];let total=0;
 for(const evidence of result.evidence){assert(typeof evidence.path==='string'&&!path.isAbsolute(evidence.path));const filename=path.resolve(directory,evidence.path);assert(filename.startsWith(path.resolve(directory)+path.sep));assert((await fs.realpath(filename)).startsWith((await fs.realpath(directory))+path.sep));const stat=await fs.lstat(filename);assert(stat.isFile()&&!stat.isSymbolicLink());total+=stat.size;assert(total<=limit);const bytes=await fs.readFile(filename);assert.equal(stat.size,evidence.size);assert.equal(digest(bytes),evidence.sha256);files.push({...evidence,data_base64:bytes.toString('base64')});}
 return files;
}
export async function privateDirectory(directory){
 assert(path.isAbsolute(directory));const resolved=path.resolve(directory);let current=path.parse(resolved).root;
 for(const component of resolved.slice(current.length).split(path.sep).filter(Boolean)){current=path.join(current,component);let stat;try{stat=await fs.lstat(current);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(current,{mode:0o700});stat=await fs.lstat(current);}assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Evidence ancestor must be an ordinary directory');}
 const stat=await fs.lstat(resolved);assert.equal(stat.uid,process.getuid());assert.equal(stat.mode&0o077,0,'Evidence root must be private');return resolved;
}
export async function unpackEvidence(directory,files){
 assert(Array.isArray(files)&&files.length<=256);const root=await privateDirectory(directory);let total=0;
 for(const file of files){
  assert(typeof file.path==='string'&&!path.isAbsolute(file.path));const parts=file.path.split('/');assert(parts.length&&parts.every(value=>value&&value!=='.'&&value!=='..'&&!value.includes('\\')),'Invalid evidence path');
  const bytes=Buffer.from(file.data_base64,'base64');assert.equal(bytes.length,file.size);assert.equal(digest(bytes),file.sha256);total+=bytes.length;assert(total<=16777216);
  let parent=root;for(const component of parts.slice(0,-1)){parent=path.join(parent,component);let stat;try{stat=await fs.lstat(parent);}catch(error){if(error.code!=='ENOENT')throw error;await fs.mkdir(parent,{mode:0o700});stat=await fs.lstat(parent);}assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Evidence ancestor must be an ordinary directory');assert.equal(stat.uid,process.getuid());assert.equal(stat.mode&0o077,0);}
  const filename=path.join(parent,parts.at(-1));let handle;
  try{handle=await fs.open(filename,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}}
  catch(error){if(error.code!=='EEXIST')throw error;handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();assert(stat.isFile()&&stat.nlink===1&&stat.uid===process.getuid()&&!(stat.mode&0o077));assert.equal(digest(await handle.readFile()),file.sha256);}finally{await handle.close();}}
 }
}
