import {parsePrimarySourceCapabilities} from './fleet_source_actions.js';
import {authorizeInvocationSource,grantSourceCapability} from '../source_control/capabilities.js';
import {readFleetManagerHandoff} from './fleet_manager_handoff.js';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import fs from 'node:fs/promises';
import {hostname} from 'node:os';
import type {ComponentContext} from '../components/registry.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext, Principal} from '../transport/protocol.js';
import {assertInvocation,base64,decimal,exact,fail,NAME,uuid} from '../transport/protocol.js';
import {object,FoundationError} from '../policy/programme.js';
import {SourceControlError} from '../source_control/contracts.js';
import {hash,requireAuthority} from '../hierarchy/packages.js';
import {recorded} from '../identity/enrollment.js';

const commonActions=['fleet.session.bind','fleet.observe','fleet.session.reason','fleet.decision.inspect','fleet.decision.apply'];
const actionNames=(role:string):readonly string[]=>role==='LEADER'?[...commonActions,'fleet.cohort.bind','hierarchy.leader.acquire','spec.amendment.admit','hierarchy.package.configure']:[...commonActions,'hierarchy.package.handoff.acknowledge'];
function deny(code:string):never{return fail(code,'Fleet supervisor bootstrap refused');}
function currentProcess(value:unknown):void {
 if(!object(value)||!Number.isSafeInteger(value.pid)||Number(value.pid)<1)deny('FLEET_BOOTSTRAP_HOST_STALE');
 try{
  const pid=Number(value.pid),stat=readFileSync('/proc/'+pid+'/stat','utf8');
  const actual={pid,start_time:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]!,kernel_boot_id:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()};
  if(hash(actual)!==hash(value))deny('FLEET_BOOTSTRAP_HOST_STALE');
 }catch{deny('FLEET_BOOTSTRAP_HOST_STALE');}
}
export async function assertFleetBootstrapIdentity(tx:PrimaryTransaction,p:Principal,action?:string):Promise<boolean>{
 assertPrimaryTransaction(tx);
 if(!['LEADER','FEATURE_MANAGER'].includes(p.role))return false;
 if(!(await tx.query("SELECT to_regclass('hyperfide.fleet_bootstrap_credentials') IS NOT NULL AS present")).rows[0]?.present)return false;
 const b=(await tx.query('SELECT * FROM hyperfide.fleet_bootstrap_credentials WHERE credential_id=$1 FOR SHARE',[p.credential_id])).rows[0];
 if(!b)return false;
 if(b.organisation_id!==p.organisation_id||b.run_id!==p.run_id||b.session_id!==p.actor_id||b.authority_epoch!==p.deployment_epoch||p.sandbox_id!==null||p.attempt_id!==null||p.allowed_actions.some(a=>!actionNames(p.role).includes(a)))deny('FLEET_BOOTSTRAP_SCOPE');
 const current=(await tx.query('SELECT authority_epoch,leader_session_id,generation::text AS leader_generation FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',[p.organisation_id,p.run_id])).rows[0];
 if(!current){
  if(p.role!=='LEADER'||String(b.leader_generation)!=='0'||String(b.cohort_generation)!=='0'||action!==undefined&&action!=='hierarchy.leader.acquire')deny('FLEET_BOOTSTRAP_LEADERSHIP_REQUIRED');
  return true;
 }
 if(String(b.leader_generation)==='0'){
  if(p.role!=='LEADER'||current.leader_session_id!==p.actor_id||current.authority_epoch!==b.authority_epoch||current.leader_generation!=='1')deny('FLEET_BOOTSTRAP_STALE');
  await tx.query('UPDATE hyperfide.fleet_bootstrap_credentials SET leader_generation=1 WHERE credential_id=$1 AND leader_generation=0',[p.credential_id]);
  b.leader_generation='1';
 }
 if(current.authority_epoch!==b.authority_epoch||current.leader_generation!==String(b.leader_generation))deny('FLEET_BOOTSTRAP_STALE');
 const session=(await tx.query('SELECT role,parent_session_id,state FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[p.organisation_id,p.run_id,p.actor_id])).rows[0];
 if(!session||session.role!==p.role||!['REGISTERED','RUNNING','DISCONNECTED'].includes(session.state))deny('FLEET_BOOTSTRAP_STALE');
 if(p.role==='LEADER'&&(p.actor_id!==current.leader_session_id||b.delegation_id!==null))deny('FLEET_BOOTSTRAP_STALE');
 if(p.role==='FEATURE_MANAGER'){
  if(session.parent_session_id!==current.leader_session_id||!b.delegation_id||!b.manager_generation)deny('FLEET_BOOTSTRAP_STALE');
  if(b.handoff_id!==null){
   if(action!==undefined&&action!=='hierarchy.package.handoff.acknowledge'||p.allowed_actions.length!==1||p.allowed_actions[0]!=='hierarchy.package.handoff.acknowledge')deny('FLEET_BOOTSTRAP_SCOPE');
   const handoff=await readFleetManagerHandoff(tx,{organisation_id:p.organisation_id,run_id:p.run_id},String(b.handoff_id));
   if(handoff.successor_id!==p.actor_id||handoff.package_id!==b.delegation_id||handoff.manager_generation!==String(b.manager_generation)||handoff.primary_id!==current.leader_session_id||handoff.leader_generation!==current.leader_generation||handoff.authority_epoch!==p.deployment_epoch)deny('FLEET_BOOTSTRAP_STALE');
  }else{
  await requireAuthority(tx,{organisation_id:p.organisation_id,run_id:p.run_id,session_id:p.actor_id,authority_epoch:p.deployment_epoch,leader_generation:String(b.leader_generation),roles:['FEATURE_MANAGER'],package_id:b.delegation_id,package_generation:String(b.manager_generation)});
  }
 }
 const cohort=(await tx.query('SELECT * FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',[p.organisation_id,p.run_id])).rows[0];
 if(!cohort){
  if(p.role!=='LEADER'||String(b.cohort_generation)!=='0'||action!==undefined&&!['fleet.cohort.bind','hierarchy.leader.acquire'].includes(action))deny('FLEET_BOOTSTRAP_COHORT_REQUIRED');
  return true;
 }
 if(b.replacement_from_generation!==null&&String(cohort.cohort_generation)===String(b.replacement_from_generation)){
  if(p.role!=='LEADER'||cohort.id!==b.cohort_id||cohort.authority_epoch!==b.authority_epoch||cohort.leader_session_id!==p.actor_id||String(cohort.leader_generation)!==String(b.leader_generation)||action!==undefined&&action!=='fleet.cohort.bind')deny('FLEET_BOOTSTRAP_COHORT_STALE');
  return true;
 }
 if(cohort.id!==b.cohort_id||cohort.host_id!==b.host_id||cohort.authority_epoch!==b.authority_epoch||cohort.leader_session_id!==current.leader_session_id||String(cohort.leader_generation)!==String(b.leader_generation))deny('FLEET_BOOTSTRAP_COHORT_STALE');
 currentProcess(cohort.controller_identity);
 if(String(b.cohort_generation)==='0'){
  if(p.role!=='LEADER'||String(cohort.cohort_generation)!=='1')deny('FLEET_BOOTSTRAP_COHORT_STALE');
  await tx.query('UPDATE hyperfide.fleet_bootstrap_credentials SET cohort_generation=1 WHERE credential_id=$1 AND cohort_generation=0',[p.credential_id]);
 }else if(String(b.cohort_generation)!==String(cohort.cohort_generation))deny('FLEET_BOOTSTRAP_COHORT_STALE');
 return true;
}
export async function assertFleetBootstrapCohortBind(tx:PrimaryTransaction,i:InvocationContext,expected:string):Promise<void>{
 const b=(await tx.query('SELECT cohort_generation,replacement_from_generation FROM hyperfide.fleet_bootstrap_credentials WHERE credential_id=$1 FOR SHARE',[i.principal.credential_id])).rows[0];
 if(!b)return;
 if(String(b.cohort_generation)==='0'&&expected==='0')return;
 if(b.replacement_from_generation!==null&&String(b.replacement_from_generation)===expected)return;
 deny('FLEET_BOOTSTRAP_REPLACEMENT_REQUIRED');
}
export async function bootstrapFleetIdentity(ctx:ComponentContext,input:unknown,i:InvocationContext):Promise<Record<string,unknown>>{
 assertInvocation(i);
 if(i.principal.role!=='OPERATOR')deny('FLEET_BOOTSTRAP_OPERATOR_REQUIRED');
 const replaces=object(input)&&Object.hasOwn(input,'replace_cohort'),pendingHandoff=object(input)&&Object.hasOwn(input,'handoff_id');
 exact(input,['session_id','public_key_b64','allowed_actions','ttl_seconds','authority_epoch','leader_generation','delegation_id','manager_generation','host_id','cohort_id','cohort_generation',...(replaces?['replace_cohort']:[]),...(pendingHandoff?['handoff_id']:[]),...(object(input)&&Object.hasOwn(input,'source_capabilities')?['source_capabilities']:[])]);
 if(replaces&&typeof input.replace_cohort!=='boolean')deny('FLEET_BOOTSTRAP_INVALID');
 const replacing=input.replace_cohort===true;
 const sourceCapabilities=input.source_capabilities===undefined?[]:parsePrimarySourceCapabilities(input.source_capabilities);
 if(pendingHandoff&&(!uuid(input.handoff_id)||replacing))deny('FLEET_BOOTSTRAP_INVALID');
 if(!uuid(input.session_id)||!uuid(input.authority_epoch)||!uuid(input.cohort_id)||!decimal(input.leader_generation)||!decimal(input.cohort_generation)||typeof input.host_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.host_id)||!Number.isInteger(input.ttl_seconds)||Number(input.ttl_seconds)<60||Number(input.ttl_seconds)>900)deny('FLEET_BOOTSTRAP_INVALID');
 if((input.delegation_id===null)!==(input.manager_generation===null)||input.delegation_id!==null&&(!uuid(input.delegation_id)||!decimal(input.manager_generation,true)))deny('FLEET_BOOTSTRAP_INVALID');
 base64(input.public_key_b64,32);
 if(!Array.isArray(input.allowed_actions)||input.allowed_actions.length<1||input.allowed_actions.length>16||input.allowed_actions.some(a=>typeof a!=='string'||!NAME.test(a))||new Set(input.allowed_actions).size!==input.allowed_actions.length)deny('FLEET_BOOTSTRAP_INVALID');
 const allowed=input.allowed_actions as string[],host=ctx.env.HYPERFIDE_FLEET_HOST_ID??hostname();
 if(input.authority_epoch!==i.principal.deployment_epoch||input.host_id!==host||allowed.some(a=>!i.principal.allowed_actions.includes(a)))deny('FLEET_BOOTSTRAP_SCOPE');
 const configFile=ctx.env.HF_IDENTITY_CONFIG_FILE;
 if(!configFile)deny('IDENTITY_CONFIG_REQUIRED');
 const config:unknown=JSON.parse(await fs.readFile(configFile,'utf8'));
 if(!object(config)||!Number.isInteger(config.credential_ttl_seconds)||Number(input.ttl_seconds)>Number(config.credential_ttl_seconds))deny('FLEET_BOOTSTRAP_INVALID');
 return ctx.resources.gateway.withPrimaryTransaction({signal:i.signal,guard:tx=>i.guard(tx),timeoutMs:5000},async tx=>recorded(tx,i.principal.credential_id,'fleet.identity.bootstrap',i.operation,async()=>{
  const scope=[i.principal.organisation_id,i.principal.run_id];
  const run=(await tx.query('SELECT authority_epoch,state FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2 FOR SHARE',scope)).rows[0];
  if(!run||run.authority_epoch!==input.authority_epoch||run.state!=='RUNNING')deny('FLEET_BOOTSTRAP_STALE');
  const current=(await tx.query('SELECT authority_epoch,leader_session_id,generation::text AS leader_generation FROM hyperfide.hierarchy_leaders WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',scope)).rows[0];
  if(current&&(current.authority_epoch!==input.authority_epoch||current.leader_generation!==input.leader_generation)||!current&&input.leader_generation!=='0')deny('FLEET_BOOTSTRAP_STALE');
  const session=(await tx.query('SELECT * FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...scope,input.session_id])).rows[0];
  if(!session||!['LEADER','FEATURE_MANAGER'].includes(session.role)||!['REGISTERED','RUNNING','DISCONNECTED'].includes(session.state)||session.sandbox_id!==null||session.sandbox_boot_generation!==null||session.attempt_id!==null||allowed.some(a=>!actionNames(session.role).includes(a)))deny('FLEET_BOOTSTRAP_SCOPE');
  if(sourceCapabilities.length&&session.role!=='LEADER')deny('FLEET_BOOTSTRAP_SCOPE');
  if(session.role==='LEADER'){
   if(pendingHandoff)deny('FLEET_BOOTSTRAP_SCOPE');
   if(current&&session.id!==current.leader_session_id||input.delegation_id!==null||input.manager_generation!==null||!current&&input.cohort_generation!=='0')deny('FLEET_BOOTSTRAP_STALE');
  }else{
   if(!current||session.parent_session_id!==current.leader_session_id||input.delegation_id===null||input.manager_generation===null||input.cohort_generation==='0')deny('FLEET_BOOTSTRAP_SCOPE');
   if(pendingHandoff){
    if(allowed.length!==1||allowed[0]!=='hierarchy.package.handoff.acknowledge')deny('FLEET_BOOTSTRAP_SCOPE');
    const handoff=await readFleetManagerHandoff(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id},String(input.handoff_id));
    if(handoff.acknowledged||handoff.successor_id!==session.id||handoff.package_id!==input.delegation_id||handoff.manager_generation!==input.manager_generation||handoff.primary_id!==current.leader_session_id||handoff.authority_epoch!==input.authority_epoch||handoff.leader_generation!==input.leader_generation)deny('FLEET_BOOTSTRAP_STALE');
   }else{
    if(allowed.includes('hierarchy.package.handoff.acknowledge'))deny('FLEET_BOOTSTRAP_SCOPE');
   await requireAuthority(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,session_id:session.id,authority_epoch:i.principal.deployment_epoch,leader_generation:String(input.leader_generation),roles:['FEATURE_MANAGER'],package_id:String(input.delegation_id),package_generation:String(input.manager_generation)});
   const delegation=(await tx.query('SELECT manager_session_id,manager_generation,leader_generation FROM hyperfide.fleet_delegations WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3 FOR SHARE',[...scope,input.delegation_id])).rows[0];
   if(!delegation||delegation.manager_session_id!==session.id||String(delegation.manager_generation)!==input.manager_generation||String(delegation.leader_generation)!==input.leader_generation)deny('FLEET_BOOTSTRAP_STALE');
   }
  }
  const cohort=(await tx.query('SELECT * FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 FOR SHARE',scope)).rows[0];
  if(!cohort){if(replacing||session.role!=='LEADER'||input.cohort_generation!=='0')deny('FLEET_BOOTSTRAP_COHORT_REQUIRED');}
  else{
   if(!current||cohort.id!==input.cohort_id||!replacing&&cohort.host_id!==host||cohort.authority_epoch!==input.authority_epoch||cohort.leader_session_id!==current.leader_session_id||String(cohort.leader_generation)!==input.leader_generation||String(cohort.cohort_generation)!==input.cohort_generation||replacing&&session.role!=='LEADER')deny('FLEET_BOOTSTRAP_COHORT_STALE');
   if(!replacing)currentProcess(cohort.controller_identity);
  }
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fleet-bootstrap-key:'+input.public_key_b64]);
  const foreignKey=(await tx.query('SELECT EXISTS(SELECT 1 FROM hyperfide.identity_principals p LEFT JOIN hyperfide.fleet_bootstrap_credentials b ON b.credential_id=p.credential_id WHERE p.public_key_b64=$1 AND (p.organisation_id<>$2 OR p.run_id<>$3 OR p.actor_id<>$4 OR p.role<>$5 OR b.credential_id IS NULL)) AS found',[input.public_key_b64,...scope,session.id,session.role])).rows[0];
  if(foreignKey?.found)deny('FLEET_BOOTSTRAP_KEY_REUSED');
  const reused=(await tx.query("SELECT p.credential_id,p.organisation_id,p.run_id,p.actor_id,p.role,b.authority_epoch,b.leader_generation,b.cohort_id,b.cohort_generation,b.delegation_id,b.manager_generation,b.replacement_from_generation FROM hyperfide.identity_principals p LEFT JOIN hyperfide.fleet_bootstrap_credentials b ON b.credential_id=p.credential_id WHERE p.public_key_b64=$1 AND p.state='ACTIVE' AND p.expires_at>clock_timestamp() FOR UPDATE OF p",[input.public_key_b64])).rows;
  for(const old of reused){
   const oldLeader=String(old.leader_generation),oldCohort=String(old.cohort_generation);
   const initialLeaderPin=oldLeader==='0'&&input.leader_generation==='1'&&session.role==='LEADER'&&current?.leader_session_id===session.id;
   const initialCohortPin=oldCohort==='0'&&input.cohort_generation==='1'&&session.role==='LEADER'&&cohort?.id===input.cohort_id;
   if(old.organisation_id!==i.principal.organisation_id||old.run_id!==i.principal.run_id||old.actor_id!==session.id||old.role!==session.role||old.authority_epoch!==input.authority_epoch||old.cohort_id!==input.cohort_id||oldLeader!==input.leader_generation&&!initialLeaderPin||oldCohort!==input.cohort_generation&&!initialCohortPin||old.delegation_id!==input.delegation_id||String(old.manager_generation??'')!==String(input.manager_generation??''))deny('FLEET_BOOTSTRAP_KEY_REUSED');
  }
  for(const old of reused)await tx.query("UPDATE hyperfide.identity_principals SET state='REVOKED',credential_version=credential_version+1 WHERE credential_id=$1 AND state='ACTIVE'",[old.credential_id]);
  const cohortGeneration=replacing?(BigInt(String(input.cohort_generation))+1n).toString():String(input.cohort_generation);
  if(!decimal(cohortGeneration))deny('FLEET_BOOTSTRAP_INVALID');
  const id=randomUUID();
  const principal=(await tx.query("INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,allowed_actions,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,LEAST($9::timestamptz,clock_timestamp()+($10::int*interval '1 second'))) RETURNING *",[id,...scope,session.id,session.role,input.public_key_b64,input.authority_epoch,allowed,i.principal.expires_at,input.ttl_seconds])).rows[0]!;
  await tx.query('INSERT INTO hyperfide.fleet_bootstrap_credentials(credential_id,organisation_id,run_id,session_id,authority_epoch,leader_generation,cohort_id,cohort_generation,host_id,replacement_from_generation,delegation_id,manager_generation,issued_by_credential_id,handoff_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,...scope,session.id,input.authority_epoch,input.leader_generation,input.cohort_id,cohortGeneration,host,replacing?input.cohort_generation:null,input.delegation_id,input.manager_generation,i.principal.credential_id,pendingHandoff?input.handoff_id:null]);
  const sourceGrants=[];
  for(const requested of sourceCapabilities){
   if(requested.scope.organisation_id!==i.principal.organisation_id)deny('FLEET_BOOTSTRAP_SCOPE');
   let administrator;try{administrator=await authorizeInvocationSource(tx,{invocation:i,scope:requested.scope,action:'source.capabilities.manage',mutation:true,paths:['']});}catch(error){if(error instanceof SourceControlError)throw new FoundationError(error.code,error.message);throw error;}
   const expires_at=new Date(Math.min(new Date(principal.expires_at).getTime(),Date.parse(administrator.expires_at))).toISOString();
   for(const revision_id of requested.initial_revision_ids??[]){
    let reader;try{reader=await authorizeInvocationSource(tx,{invocation:i,scope:requested.scope,action:'source.revisions.read',mutation:false,paths:[''],revision_id});}catch(error){if(error instanceof SourceControlError)throw new FoundationError(error.code,error.message);throw error;}
    const revision=(await tx.query(`SELECT r.revision_id FROM hyperfide.source_revisions r JOIN hyperfide.source_repositories repository USING(organisation_id,repository_id,security_domain_id)
     WHERE r.organisation_id=$1 AND r.repository_id=$2 AND r.security_domain_id=$3 AND r.revision_id=$4 AND repository.authority_epoch=$5 FOR SHARE OF r,repository`,[requested.scope.organisation_id,requested.scope.repository_id,requested.scope.security_domain_id,revision_id,reader.authority_epoch])).rows;
    if(revision.length!==1)deny('FLEET_SOURCE_INITIAL_REVISION_UNAVAILABLE');
   }
   const capability_id=await grantSourceCapability(tx,administrator,{scope:requested.scope,principal_id:session.id,credential_id:id,principal_kind:'automation',authority_epoch:administrator.authority_epoch,policy_version:administrator.policy_version,actions:requested.actions,path_prefixes:[''],expires_at});
   const discovery_capability_id=requested.initial_revision_ids?await grantSourceCapability(tx,administrator,{scope:requested.scope,principal_id:session.id,credential_id:id,principal_kind:'automation',authority_epoch:administrator.authority_epoch,policy_version:administrator.policy_version,actions:['source.revisions.read'],path_prefixes:[''],revision_ids:requested.initial_revision_ids,expires_at}):undefined;
   sourceGrants.push({scope:requested.scope,actions:requested.actions,capability_id,expires_at,...(discovery_capability_id?{discovery_capability_id,initial_revision_ids:requested.initial_revision_ids}:{})});
  }
  return {protocol_version:1,credential_id:id,actor_id:session.id,run_id:i.principal.run_id,role:session.role,deployment_epoch:input.authority_epoch,credential_version:String(principal.credential_version),allowed_actions:allowed,expires_at:new Date(principal.expires_at).toISOString(),phase:'SUPERVISOR_BOOTSTRAP',source_capabilities:sourceGrants,model_observed:false,cohort_id:input.cohort_id,cohort_generation:cohortGeneration,...(replacing?{cohort_replacement:{expected_generation:input.cohort_generation,target_generation:cohortGeneration}}:{})};
 }));
}
