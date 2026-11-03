import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function modelSourceCaller({f,ids,resources,controlRoot,identityAuthority,request,sourceCall,signal}){
 const load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
 const [{createComponent},{validateDecision,digest},{readFleetRepositoryPins,fleetSourceRevision},{observePrimarySources},{createComponent:registerSource}]=await Promise.all([load('agents/fleet_orchestration'),import(pathToFileURL(path.join(controlRoot,'contracts/fleet/index.mjs'))),load('source_control/fleet-pins'),load('agents/fleet_source_actions'),load('agents/fleet_source_registration')]);
 const component=createComponent({env:process.env,resources,signal,dependencies:{require(name,key){assert.equal(name,'source-control');assert.equal(key,'source.service.v1');return f.service;}}});
 registerSource({env:process.env,resources,signal,dependencies:{require(name,key){if(name==='source-control'){assert.equal(key,'source.service.v1');return f.service;}assert.equal(name,'fleet-orchestration');assert.equal(key,'fleet.source.bridge');return component.capabilities[key];}}});
 const bootstrapKey=generateKeyPairSync('ed25519');
 const cohort=(await f.pool.query('SELECT id,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',[ids.organisation,ids.run])).rows[0];
 const bootstrapInput={session_id:ids.leader,public_key_b64:bootstrapKey.publicKey.export({format:'jwk'}).x,allowed_actions:['fleet.decision.apply','fleet.observe'],ttl_seconds:300,authority_epoch:ids.epoch,leader_generation:'1',delegation_id:null,manager_generation:null,host_id:hostname(),cohort_id:cohort.id,cohort_generation:cohort.cohort_generation,source_capabilities:[{scope:f.scope,actions:['source.fleet.select','source.fleet.selection']}]};
 const bootstrapOperation=randomUUID();
 const bootstrap=async(input,operation)=>{
  const signed=await request('operator','fleet-orchestration','fleet.identity.bootstrap',input,operation);
  const invocation=await identityAuthority.authenticate(signed.body,Object.entries(signed.headers).flat(),signal);
  return component.actions['fleet.identity.bootstrap'](input,{invocation});
 };
 const grant=await bootstrap(bootstrapInput,bootstrapOperation);
 assert.deepEqual(await bootstrap(bootstrapInput,bootstrapOperation),grant);
 assert.equal(grant.source_capabilities.length,1);
 const capability=(await f.pool.query('SELECT principal_id,actions,path_prefixes FROM hyperfide.source_capabilities WHERE credential_id=$1',[grant.credential_id])).rows[0];
 assert.equal(capability.principal_id,ids.leader);assert.deepEqual(capability.actions,bootstrapInput.source_capabilities[0].actions);assert.deepEqual(capability.path_prefixes,['']);
 const count=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.identity_principals WHERE organisation_id=$1 AND actor_id=$2',[ids.organisation,ids.leader])).rows[0].n;
 await assert.rejects(()=>bootstrap({...bootstrapInput,public_key_b64:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,source_capabilities:[{scope:{...f.scope,repository_id:randomUUID()},actions:['source.fleet.select']}]},randomUUID()),error=>error.code==='SCOPE_DENIED');
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.identity_principals WHERE organisation_id=$1 AND actor_id=$2',[ids.organisation,ids.leader])).rows[0].n,count);
 const decisions=new Map();
 const call=async(key,action,input,operation=randomUUID())=>{
  if(action!=='source.fleet.select')return sourceCall(key,action,input,operation);
  assert.equal(key,'leader');
  let decision=decisions.get(operation);
  if(!decision){
   const bound=await resources.gateway.withPrimaryTransaction({timeoutMs:15000},async tx=>{
    const pins=await readFleetRepositoryPins(tx,ids.organisation,ids.run);
    const run=(await tx.query('SELECT spec_revision_id FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[ids.organisation,ids.run])).rows[0];
    const actor=(await tx.query('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[ids.organisation,ids.run,ids.leader])).rows[0];
    return {source:fleetSourceRevision(pins[0]),spec:run.spec_revision_id,plan:actor.plan_generation};
   });
   const observation=randomUUID(),reasoning=randomUUID(),decisionId=randomUUID(),context=digest({fixture:'DECLARED_PRIOR_MODEL_DECISION',operation});
   const modelInput={scope:f.scope,action,input};
   decision=validateDecision({schema_version:1,kind:'hyperfide.fleet-decision',decision_id:decisionId,operation_id:operation,run_id:ids.run,actor_id:ids.leader,actor_role:'PRIMARY',authority_epoch:ids.epoch,leader_generation:'1',delegation_id:null,manager_generation:null,source_revision:bound.source,spec_revision:bound.spec,context_digest:context,action:'SOURCE_OPERATION',input:modelInput,input_digest:digest(modelInput),expected_version:bound.plan,rationale_summary:'Declared model choice exercises native source admission and replay.'});
   await f.pool.query('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) SELECT $1,$2,$3,$4,cohort_generation,$5,$6 FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',[ids.organisation,ids.run,observation,ids.leader,context,{fixture:'DECLARED_PRIOR_MODEL_DECISION'}]);
   await f.pool.query("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7)",[ids.organisation,ids.run,reasoning,ids.leader,context,observation,{fixture:'DECLARED_PRIOR_MODEL_DECISION'}]);
   await f.pool.query('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ids.organisation,ids.run,decisionId,operation,ids.leader,decision.action,context,digest(decision),reasoning,decision]);
   decisions.set(operation,decision);
  }
  const signed=await request('leader','fleet-orchestration','fleet.decision.apply',{decision});
  const invocation=await identityAuthority.authenticate(signed.body,Object.entries(signed.headers).flat(),signal);
  const result=await component.actions['fleet.decision.apply']({decision},{invocation});
  if(result.state==='REFUSED'){const error=new Error(result.error.message);Object.assign(error,result.error);throw error;}
  assert.equal(result.state,'COMMITTED');assert.equal(result.source_operation_id,operation);
  const observation=await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>observePrimarySources(tx,invocation));
  assert(observation.results.some(row=>row.operation_id===operation));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.fleet_native_source_results WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[ids.organisation,ids.run,operation])).rows[0].n,1);
  return result.response;
 };
 return call;
}
