import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {hostname} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function modelSourceCaller({f,ids,resources,controlRoot,identityAuthority,request,sourceCall,signal}){
 const load=name=>import(pathToFileURL(path.join(controlRoot,name+'.js')));
 const [{createComponent},{validateDecision,digest},{readFleetRepositoryPins,fleetSourceRevision},{observePrimarySources,primarySourceRequest,parsePrimarySourceCapabilities},{createComponent:registerSource},{signingBytes}]=await Promise.all([load('agents/fleet_orchestration'),import(pathToFileURL(path.join(controlRoot,'contracts/fleet/index.mjs'))),load('source_control/fleet-pins'),load('agents/fleet_source_actions'),load('agents/fleet_source_registration'),load('transport/protocol')]);
 const component=createComponent({env:process.env,resources,signal,dependencies:{require(name,key){assert.equal(name,'source-control');assert.equal(key,'source.service.v1');return f.service;}}});
 registerSource({env:process.env,resources,signal,dependencies:{require(name,key){if(name==='source-control'){assert.equal(key,'source.service.v1');return f.service;}assert.equal(name,'fleet-orchestration');assert.equal(key,'fleet.source.bridge');return component.capabilities[key];}}});
 const bootstrapKey=generateKeyPairSync('ed25519');
 const cohort=(await f.pool.query('SELECT id,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',[ids.organisation,ids.run])).rows[0];
 const initial=(await f.pool.query('SELECT revision_id,root_tree_id FROM hyperfide.source_fleet_runs WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3 AND security_domain_id=$4',[ids.organisation,ids.run,f.scope.repository_id,f.scope.security_domain_id])).rows[0];
 assert(initial,'The fixture must have a native revision admitted before Primary bootstrap');
 const bootstrapInput={session_id:ids.leader,public_key_b64:bootstrapKey.publicKey.export({format:'jwk'}).x,allowed_actions:['fleet.decision.apply','fleet.observe'],ttl_seconds:300,authority_epoch:ids.epoch,leader_generation:'1',delegation_id:null,manager_generation:null,host_id:hostname(),cohort_id:cohort.id,cohort_generation:cohort.cohort_generation,source_capabilities:[{scope:f.scope,actions:['source.fleet.select','source.fleet.selection','source.revisions.read','source.fleet.bind-run'],initial_revision_ids:[initial.revision_id]}]};
 const bootstrapOperation=randomUUID();
 const bootstrap=async(input,operation)=>{
  const signed=await request('operator','fleet-orchestration','fleet.identity.bootstrap',input,operation);
  const invocation=await identityAuthority.authenticate(signed.body,Object.entries(signed.headers).flat(),signal);
  return component.actions['fleet.identity.bootstrap'](input,{invocation});
 };
 const grant=await bootstrap(bootstrapInput,bootstrapOperation);
 assert.deepEqual(await bootstrap(bootstrapInput,bootstrapOperation),grant);
 assert.equal(grant.source_capabilities.length,1);
 const capabilities=(await f.pool.query('SELECT id,principal_id,actions,path_prefixes,revision_ids FROM hyperfide.source_capabilities WHERE credential_id=$1',[grant.credential_id])).rows;
 assert.equal(capabilities.length,2);
 const capability=capabilities.find(row=>row.id===grant.source_capabilities[0].capability_id),discovery=capabilities.find(row=>row.id===grant.source_capabilities[0].discovery_capability_id);
 assert.equal(capability.principal_id,ids.leader);assert.deepEqual(capability.actions,bootstrapInput.source_capabilities[0].actions);assert.deepEqual(capability.path_prefixes,['']);assert.equal(capability.revision_ids,null);
 assert.equal(discovery.principal_id,ids.leader);assert.deepEqual(discovery.actions,['source.revisions.read']);assert.deepEqual(discovery.revision_ids,[initial.revision_id]);
 assert.deepEqual(grant.source_capabilities[0].initial_revision_ids,[initial.revision_id]);
 const count=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.identity_principals WHERE organisation_id=$1 AND actor_id=$2',[ids.organisation,ids.leader])).rows[0].n;
 await assert.rejects(()=>bootstrap({...bootstrapInput,public_key_b64:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,source_capabilities:[{scope:{...f.scope,repository_id:randomUUID()},actions:['source.fleet.select']}]},randomUUID()),error=>error.code==='SCOPE_DENIED');
 for(const [capabilities,code] of [
  [[{scope:f.scope,actions:['source.fleet.select'],initial_revision_ids:[initial.revision_id]}],'FLEET_SOURCE_CAPABILITIES_INVALID'],
  [[{scope:{...f.scope,security_domain_id:randomUUID()},actions:['source.revisions.read'],initial_revision_ids:[initial.revision_id]}],'SCOPE_DENIED'],
  [[{scope:f.scope,actions:['source.revisions.read'],initial_revision_ids:['sha256:'+createHash('sha256').update(randomUUID()).digest('hex')]}],'FLEET_SOURCE_INITIAL_REVISION_UNAVAILABLE'],
 ])await assert.rejects(()=>bootstrap({...bootstrapInput,public_key_b64:generateKeyPairSync('ed25519').publicKey.export({format:'jwk'}).x,source_capabilities:capabilities},randomUUID()),error=>error.code===code);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.identity_principals WHERE organisation_id=$1 AND actor_id=$2',[ids.organisation,ids.leader])).rows[0].n,count);
 const authenticatePrimary=async(action,input)=>{
  const operation=randomUUID(),payload=Buffer.from(JSON.stringify({run_id:ids.run,component:'fleet-orchestration',action,input,expected_version:null,authority:null}));
  const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:'sha256:'+createHash('sha256').update(payload).digest('hex'),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')}));
  const proof={id:grant.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
  const headers=['HF-Credential-Id',proof.id,'HF-Request-Time',proof.time,'HF-Request-Nonce',proof.nonce,'HF-Request-Signature',sign(null,signingBytes(identityAuthority.origin,'/v1/invoke',proof,body),bootstrapKey.privateKey).toString('base64url')];
  const invocation=await identityAuthority.authenticate(body,headers,signal);
  return invocation;
 };
 const invokePrimary=async(action,input)=>{const invocation=await authenticatePrimary(action,input);return {invocation,result:await component.actions[action](input,{invocation})};};
 const binding={actor_id:ids.leader,actor_role:'PRIMARY',authority_epoch:ids.epoch,leader_generation:'1',delegation_id:null,manager_generation:null};
 const observationInvocation=await authenticatePrimary('fleet.observe',{binding,after:null,limit:1});
 const observed=await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>observePrimarySources(tx,observationInvocation));
 const bindRequest={action:'SOURCE_OPERATION',input:{scope:f.scope,action:'source.fleet.bind-run',input:{run_id:ids.run,revision_id:initial.revision_id,leader_generation:'1'}}};
 assert.deepEqual(observed.initial_revisions,[{scope:f.scope,revision_id:initial.revision_id,root_tree_id:initial.root_tree_id,bind_request:bindRequest}]);
 const bindOperation=randomUUID(),parsedBind=primarySourceRequest({actor_role:'PRIMARY',action:bindRequest.action,input:bindRequest.input,operation_id:bindOperation,run_id:ids.run,leader_generation:'1'});
 assert.deepEqual(parsedBind,{protocol_version:1,scope:f.scope,action:'source.fleet.bind-run',input:bindRequest.input.input,operation_id:bindOperation,idempotency_key:bindOperation});
 assert.equal(observed.initial_revisions_budget_bytes,16384);
 assert.equal(observed.initial_revisions_omitted,false);
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
   for(const action of ['source.transforms.merge','source.queue.read','source.publications.create','source.queries.batch']){
    const value={...decision,input:{scope:f.scope,action,input:{}}};
    assert.equal(primarySourceRequest(value).operation_id,operation);
    assert.throws(()=>primarySourceRequest({...value,actor_role:'WAVE_MANAGER'}),error=>error.code==='FLEET_PRIMARY_REQUIRED');
   }
   for(const action of ['source.capabilities.manage','source.retention.configure','source.recovery.activate']){
    assert.throws(()=>primarySourceRequest({...decision,input:{scope:f.scope,action,input:{}}}),error=>error.code==='FLEET_SOURCE_ACTION_INVALID');
    assert.throws(()=>parsePrimarySourceCapabilities([{scope:f.scope,actions:[action]}]),error=>error.code==='FLEET_SOURCE_CAPABILITIES_INVALID');
   }
   await f.pool.query('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) SELECT $1,$2,$3,$4,cohort_generation,$5,$6 FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',[ids.organisation,ids.run,observation,ids.leader,context,{fixture:'DECLARED_PRIOR_MODEL_DECISION'}]);
   await f.pool.query("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7)",[ids.organisation,ids.run,reasoning,ids.leader,context,observation,{fixture:'DECLARED_PRIOR_MODEL_DECISION'}]);
   await f.pool.query('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[ids.organisation,ids.run,decisionId,operation,ids.leader,decision.action,context,digest(decision),reasoning,decision]);
   decisions.set(operation,decision);
  }
  const {invocation,result}=await invokePrimary('fleet.decision.apply',{decision});
  if(result.state==='REFUSED'){const error=new Error(result.error.message);Object.assign(error,result.error);throw error;}
  assert.equal(result.state,'COMMITTED');assert.equal(result.source_operation_id,operation);
  const observation=await resources.gateway.withPrimaryTransaction({timeoutMs:15000},tx=>observePrimarySources(tx,invocation));
  assert(observation.results.some(row=>row.operation_id===operation));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.fleet_native_source_results WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[ids.organisation,ids.run,operation])).rows[0].n,1);
  return result.response;
 };
 return call;
}
