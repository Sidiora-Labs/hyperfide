import {parseGeneration,parseObjectId,parseSourceScope,parseStrictJSON,parseUUID,SourceControlError} from './contracts.js';
import {sourceDigest,sourceScopeValues,type SourceContext,type SourceMetadata} from './metadata.js';
import type {SourceObjectService} from './objects.js';
import {assertSourceRecoveryAdmission} from './recovery.js';

const unavailable=()=>new SourceControlError('CAUSAL_UNAVAILABLE','Committed source state is not currently readable','RETRY_SAME_OPERATION','KNOWN');
/** A causal token is an opaque reference to a committed receipt, never authority. */
export async function validateSourceCausalRead(metadata:SourceMetadata,objects:SourceObjectService,context:SourceContext,action:string,token:string|undefined,callerSignal?:AbortSignal):Promise<void> {
 if(token===undefined)return;
 let tuple:unknown;
 try {
  if(token.length>2048||!/^[A-Za-z0-9_-]+$/.test(token))throw new Error();
  const bytes=Buffer.from(token,'base64url');
  if(bytes.toString('base64url')!==token)throw new Error();
  tuple=parseStrictJSON(bytes,1536);
  if(!Array.isArray(tuple)||tuple.length!==5||tuple[0]!==1)throw new Error();
  parseSourceScope(tuple[1]);parseGeneration(tuple[2]);parseUUID(tuple[3]);parseObjectId(tuple[4]);
 }catch {throw new SourceControlError('INVALID_CAUSAL_TOKEN','Malformed source causal token');}
 const [,_scope,epoch,operation,digest]=tuple as [number,SourceContext['scope'],string,string,string];
 if(sourceDigest(_scope)!==sourceDigest(context.scope))throw new SourceControlError('INVALID_CAUSAL_TOKEN','Causal token belongs to another source scope');
 if(epoch!==context.authority_epoch)throw new SourceControlError('STALE_CAUSAL_TOKEN','Causal token authority epoch differs');
 const controller=new AbortController();
 const abort=()=>controller.abort();
 callerSignal?.addEventListener('abort',abort,{once:true});
 if(callerSignal?.aborted)abort();
 let timer:ReturnType<typeof setTimeout>|undefined;
 const verify=async()=>{
  if(controller.signal.aborted)throw unavailable();
  const root=await metadata.transaction(async tx=>{
   await metadata.guard(tx,context,action);
   if(controller.signal.aborted)throw unavailable();
   // Recovery reads ordinarily remain available; causally current reads cannot
   // use a restored snapshot until its external activation fence is satisfied.
   await assertSourceRecoveryAdmission(tx,context.scope,'source.causal.dependent',true);
   const row=(await tx.query(`SELECT o.result,o.result_digest,r.root_tree_id,r.authority_epoch::text AS revision_epoch
    FROM hyperfide.source_metadata_operations o JOIN hyperfide.source_revisions r
    ON r.organisation_id=o.organisation_id AND r.repository_id=o.repository_id AND r.security_domain_id=o.security_domain_id AND r.revision_id=o.result->>'revision_id'
    WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3 AND o.principal_id=$4 AND o.operation_id=$5
    AND o.action='source.revisions.create' AND o.state='COMMITTED'`,[...sourceScopeValues(context.scope),context.principal_id,operation])).rows[0];
   if(!row)throw unavailable();
   const receipt=row.result,{causal_token,result_digest,...body}=receipt;
   if(causal_token!==token||result_digest!==digest||row.result_digest!==digest||sourceDigest(body)!==digest||receipt.operation_id!==operation||receipt.authority_epoch!==epoch||sourceDigest(receipt.scope)!==sourceDigest(context.scope)||receipt.root_tree_id!==row.root_tree_id)
    throw new SourceControlError('INVALID_CAUSAL_TOKEN','Causal token does not match its committed receipt');
   return parseObjectId(row.root_tree_id);
  });
  if(controller.signal.aborted)throw unavailable();
  try {await objects.read(context.scope,root,controller.signal);}catch {throw unavailable();}
  if(controller.signal.aborted)throw unavailable();
  await metadata.transaction(async tx=>{
   await metadata.guard(tx,context,action);
   if(controller.signal.aborted)throw unavailable();
   await assertSourceRecoveryAdmission(tx,context.scope,'source.causal.dependent',true);
  });
 };
 try {
  await Promise.race([verify(),new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(unavailable()),{once:true});if(controller.signal.aborted)reject(unavailable());timer=setTimeout(abort,5000);timer.unref();})]);
 }finally {if(timer)clearTimeout(timer);callerSignal?.removeEventListener('abort',abort);}
}
