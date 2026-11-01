import {validInventoryJournal,retainedInventoryEvidenceSQL} from './inventory_journal.js';
import {randomUUID} from 'node:crypto';
import {foreignInventoryPolicy} from './foreign_inventory.js';
import {configuredScope,currentPool,digestDocument,fail,providerInvocation,providerOwnershipProbe,transaction} from './pools.js';
import type {DeploymentConfig,ProviderDatabase,OwnershipObservation} from './pools.js';

/** Read-only maintenance: no provisioning intent, allocation or model selection is created. */
export async function refreshRetainedInventory(database:ProviderDatabase,config:DeploymentConfig,signal:AbortSignal,index:number):Promise<{has_more:boolean;retry_after_ms:number}>{
 const invocation=providerInvocation(database),policy=foreignInventoryPolicy(config);
 if(invocation.principal.role!=='PROVISIONER')fail('AUTH_SCOPE_DENIED','Inventory maintenance requires the provisioner');
 if(!policy)return{has_more:false,retry_after_ms:60000};
 const pools=config.pools.filter(p=>p.provider===policy.document.provider&&p.account_key===policy.document.provider_account_id&&p.environment_key===policy.document.environment_id&&p.create_policy.inventory_namespace).sort((a,b)=>a.id.localeCompare(b.id));
 const groups=[...new Map(pools.map(p=>[p.provider+':'+p.account_key+':'+p.environment_key+':'+p.region,p])).values()];
 if(!groups.length)return{has_more:false,retry_after_ms:60000};
 const selected=groups[index%groups.length]!,{scope}=await currentPool(database,config,selected.id);
 const evidence=(await database.query(retainedInventoryEvidenceSQL(),[config.organisation_id,scope.provider,scope.provider_account_id])).rows;
 if(evidence.length>30000)fail('PROVIDER_INVENTORY_BOUND','Retained inventory exceeds bounded maintenance');
 const latest=new Map<string,{native_sandbox_id:string;observation:Record<string,any>|null;observed_at:string|null}>();
 for(const row of evidence){const proof=row.observation;if(digestDocument(proof)!==row.evidence_digest||row.journal_result!==null&&!validInventoryJournal(row.journal_result,row.journal_request_digest,digestDocument,row.journal_run_id)||proof.scope?.organisation_id!==config.organisation_id||typeof proof.native_sandbox_id!=='string'||!proof.native_sandbox_id||proof.native_sandbox_id.length>256)fail('CAPACITY_UNKNOWN','Retained inventory journal integrity requires reconciliation');if(proof.scope.environment_id!==scope.environment_id)continue;if(!latest.has(proof.native_sandbox_id))latest.set(proof.native_sandbox_id,{native_sandbox_id:proof.native_sandbox_id,observation:proof,observed_at:new Date(row.observed_at).toISOString()});}
 const orphans=(await database.query("SELECT o.native_sandbox_id FROM hyperfide.provider_orphans o JOIN hyperfide.provider_pools p ON p.organisation_id=o.organisation_id AND p.id=o.pool_id WHERE o.organisation_id=$1 AND p.provider=$2 AND p.account_key=$3 AND p.environment_key=$4 AND p.region=$5 AND o.state<>'DELETED' ORDER BY o.native_sandbox_id LIMIT 1001",[config.organisation_id,scope.provider,scope.provider_account_id,scope.environment_id,scope.region])).rows;
 for(const row of orphans)if(!latest.has(row.native_sandbox_id))latest.set(row.native_sandbox_id,{native_sandbox_id:row.native_sandbox_id,observation:null,observed_at:null});
 const managed=(await database.query("SELECT s.native_sandbox_id FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id WHERE s.organisation_id=$1 AND p.provider=$2 AND p.account_key=$3 AND p.environment_key=$4 AND s.observed_state<>'DESTROYED'",[config.organisation_id,scope.provider,scope.provider_account_id,scope.environment_id])).rows;
 const known=new Set(managed.map(row=>row.native_sandbox_id));
 const rows=[...latest.values()].filter(row=>!known.has(row.native_sandbox_id)&&(!row.observation||row.observation.scope?.region===scope.region||row.observation.classification==='UNKNOWN')).sort((a,b)=>(Date.parse(a.observed_at??'')||0)-(Date.parse(b.observed_at??'')||0)||a.native_sandbox_id.localeCompare(b.native_sandbox_id));
 if(rows.length>1000||orphans.length>1000)fail('PROVIDER_INVENTORY_BOUND','Retained inventory exceeds bounded maintenance');
 const retainedUnknown=rows.some(row=>row.observation?.classification==='UNKNOWN'&&row.observation?.presence!=='ABSENT');
 const due=rows.filter(row=>{const previous=row.observation,origin=config.pools.find(p=>p.id===previous?.scope?.pool_id),age=Date.now()-Date.parse(row.observed_at??'');const ttl=previous?.classification==='UNKNOWN'&&previous?.presence!=='ABSENT'?1000:policy.document.max_age_seconds*500;return !(origin&&previous?.policy_digest===policy.digest&&digestDocument(previous.scope)===digestDocument(configuredScope(config,origin))&&age>=0&&age<ttl);});
 const timeout=Math.min(config.maximum_operation_ms,10000),deadline=Date.now()+timeout,bounded=AbortSignal.any([signal,AbortSignal.timeout(timeout)]);let cursor=0,unresolved=0;
 const probe=providerOwnershipProbe(scope.provider,database.runtime);
 await Promise.all(Array.from({length:Math.min(4,due.length)},async()=>{while(cursor<Math.min(32,due.length)&&Date.now()<deadline&&!bounded.aborted){
  const candidate=due[cursor++]!,operationId=randomUUID();let measured:OwnershipObservation|null=null;
  try{let finish:(()=>void)|undefined;try{measured=await Promise.race([probe(scope,operationId,candidate.native_sandbox_id,bounded),new Promise<never>((_,reject)=>{finish=()=>reject(new Error('INVENTORY_DEADLINE'));if(bounded.aborted)finish();else bounded.addEventListener('abort',finish,{once:true});})]);}finally{if(finish)bounded.removeEventListener('abort',finish);}}catch{}
  const exact=measured?.operation_id===operationId&&measured.native_sandbox_id===candidate.native_sandbox_id;
  const classification=exact&&measured?.matches?'OWNED':exact&&measured?.foreign&&measured.foreign_policy_digest===policy.digest?'FOREIGN':'UNKNOWN';
  const observation={kind:'PROVIDER_INVENTORY_ATTRIBUTION_V1',policy_digest:policy.digest,scope,native_sandbox_id:candidate.native_sandbox_id,classification,presence:exact?measured?.presence??'UNKNOWN':'UNKNOWN',foreign:classification==='FOREIGN'?measured!.foreign:null,probe_evidence_digest:exact?measured!.evidence_digest:null,observed_at:measured?.observed_at??new Date().toISOString()};
  if(classification==='UNKNOWN'&&observation.presence!=='ABSENT')unresolved++;
  const request={schema_version:1,run_id:invocation.principal.run_id,scope,policy_digest:policy.digest,native_sandbox_id:candidate.native_sandbox_id,credential_id:invocation.principal.credential_id},evidence=digestDocument(observation);
  if(signal.aborted)return;
  await transaction(database,async tx=>{const current=await currentPool(tx,config,selected.id);if(digestDocument(current.scope)!==digestDocument(scope)||foreignInventoryPolicy(config)?.digest!==policy.digest)fail('PROVIDER_INVENTORY_SCOPE_CHANGED','Maintenance scope changed');await tx.query("INSERT INTO hyperfide.command_inbox(organisation_id,run_id,id,principal_scope,operation,idempotency_key,request_digest,state,result) VALUES($1,$2,$3,'PROVISIONER_INVENTORY','provider.inventory.observe',$4,$5,'COMPLETED',$6)",[config.organisation_id,invocation.principal.run_id,operationId,operationId,digestDocument(request),{request,observation,evidence_digest:evidence}]);});
 }}));
 return{has_more:cursor<due.length||unresolved>0||retainedUnknown,retry_after_ms:Math.max(1000,Math.min(60000,policy.document.max_age_seconds*250))};
}
