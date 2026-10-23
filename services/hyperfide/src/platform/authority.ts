import {randomUUID} from 'node:crypto';
import type {Component,ComponentContext} from '../components/registry.js';
import {identityTransaction,isIdentityAuthority,recorded} from '../identity/enrollment.js';
import {readFile} from 'node:fs/promises';
import {base64,DIGEST,exact,fail,hash,uuid} from '../transport/protocol.js';
import type {AuthorityTransaction,InvocationContext} from '../transport/protocol.js';

// Platform records are observations, never publication permission or qualification authority.
const namespace='platform.authority';
async function read(tx:AuthorityTransaction,i:InvocationContext,kind:string,key:string):Promise<unknown>{
 const row=(await tx.query("SELECT result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND principal_scope=$3 AND operation=$4 AND idempotency_key=$5 AND state='COMPLETED'",
  [i.principal.organisation_id,i.principal.run_id,namespace,kind,key])).rows[0];
 return row?.result??null;
}
async function put(tx:AuthorityTransaction,i:InvocationContext,kind:string,key:string,value:unknown):Promise<void>{
 const bytes=JSON.stringify(value),digest=hash(bytes),p=i.principal;
 await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[namespace+':'+p.organisation_id+':'+p.run_id+':'+kind+':'+key]);
 const old=await read(tx,i,kind,key);
 if(old!==null){if(hash(JSON.stringify(old))!==digest){
  // PostgreSQL jsonb reorders object fields; compare canonical database JSON instead.
  const equal=(await tx.query('SELECT $1::jsonb=$2::jsonb AS equal',[JSON.stringify(old),bytes])).rows[0]?.equal;
  if(!equal)fail('AUTHORITY_RECORD_CONFLICT','Immutable record identity was reused');
 }return;}
 await tx.query("INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result) VALUES($1,$2,$3,$4,$5,$6,$7,'COMPLETED',$8::jsonb)",
  [p.organisation_id,p.run_id,randomUUID(),namespace,kind,key,digest,bytes]);
}
export async function createComponent(ctx:ComponentContext):Promise<Component>{
 const identity=ctx.dependencies.require('14.1','identity.authority',isIdentityAuthority);
 const config=JSON.parse(await readFile(ctx.env.HF_IDENTITY_CONFIG_FILE!,'utf8')) as {principals:{credential_id:string;role:string}[]};
 const operators=new Set(config.principals.filter(p=>p.role==='OPERATOR').map(p=>p.credential_id));
 const action=(fn:(tx:AuthorityTransaction,i:InvocationContext,v:unknown)=>Promise<unknown>)=>
  (v:unknown,context:ComponentContext)=>identityTransaction(context,async(tx,i)=>{
   await identity.authorize(i);
   if(i.principal.role!=='OPERATOR'||i.principal.sandbox_id!==null)fail('ROLE_DENIED','Platform authority requires an operator');
   // The service-owned credential UUID allow-list is already loaded and validated by identity startup.
   // A delegated operator outside that list cannot acquire platform authority.
   if(!operators.has(i.principal.credential_id))fail('AUTH_SCOPE_DENIED','Operator is outside the service allow-list');
   if(i.payload.action==='authority.transaction')return recorded(tx,i.principal.credential_id,i.payload.action,i.operation,()=>fn(tx,i,v));
   return fn(tx,i,v);
  });
 return {apiVersion:1,actions:{
  'authority.operator':action(async(_tx,i,v)=>{exact(v,[]);return i.principal;}),
  'authority.health':action(async(_tx,_i,v)=>{exact(v,[]);return {status:'ready'};}),
  'authority.receipt.read':action(async(tx,i,v)=>{exact(v,['id']);if(!uuid(v.id))fail('INVALID_REQUEST','Receipt UUID required');return read(tx,i,'receipt',v.id);}),
  'authority.evidence.read':action(async(tx,i,v)=>{exact(v,['digest']);if(typeof v.digest!=='string'||!DIGEST.test(v.digest))fail('INVALID_REQUEST','Evidence digest required');return read(tx,i,'evidence',v.digest);}),
  'authority.transaction':action(async(tx,i,v)=>{
   exact(v,['writes']);if(!Array.isArray(v.writes)||v.writes.length<1||v.writes.length>32)fail('INVALID_REQUEST','One to 32 writes required');
   const writes=v.writes.map(value=>{
    if(value?.kind==='receipt'){
     exact(value,['kind','receipt']);const r=value.receipt;exact(r,['id','kind','subject','commit','evidence_digest','details']);
     if(!uuid(r.id)||!['lane','publication'].includes(String(r.kind))||typeof r.subject!=='string'||!r.subject.length||r.subject.length>255||
       typeof r.commit!=='string'||!/^[0-9a-f]{40,64}$/.test(r.commit)||typeof r.evidence_digest!=='string'||!DIGEST.test(r.evidence_digest)||
       !r.details||typeof r.details!=='object'||Array.isArray(r.details))fail('INVALID_REQUEST','Invalid receipt');
     return {kind:'receipt',key:r.id,value:r};
    }
    exact(value,['kind','digest','bytes_b64']);if(value.kind!=='evidence'||typeof value.digest!=='string'||!DIGEST.test(value.digest))fail('INVALID_REQUEST','Invalid evidence');
    const bytes=base64(value.bytes_b64);if(bytes.length>256*1024||hash(bytes)!==value.digest)fail('INVALID_REQUEST','Evidence bytes differ from digest or exceed limit');
    return {kind:'evidence',key:value.digest,value:{digest:value.digest,bytes_b64:value.bytes_b64}};
   });
   // Stable lock order prevents batches with opposite write order from deadlocking.
   writes.sort((a,b)=>(a.kind+':'+a.key).localeCompare(b.kind+':'+b.key));
   for(const write of writes)await put(tx,i,write.kind,write.key,write.value);
   await i.guard(tx);
   return {committed:true,count:writes.length};
  }),
 }};
}
