import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
const [dist,components,policyPath]=process.argv.slice(2);
const request=JSON.parse(fs.readFileSync(0,'utf8')),d=request.payload,mode=request.case;
const mod=p=>import(pathToFileURL(dist+'/'+p));
const {ComponentRegistry}=await mod('components/registry.js');
const {validatePolicy}=await mod('policy/programme.js');
const {createProviderDatabase,bindProviderInvocation,readDeployment}=await mod('providers/pools.js');
const {createProviderBootstrap}=await mod('providers/bootstrap.js');
const {createBlaxelBootstrapTransport}=await mod('providers/blaxel/bootstrap.js');
const controller=new AbortController(),policy=JSON.parse(fs.readFileSync(policyPath,'utf8'));
const registry=new ComponentRegistry({role:'provisioner',policy:validatePolicy(policy,policy.spec_revision,'provisioner'),signal:controller.signal,env:process.env});
const assert=(v,m)=>{if(!v)throw Error(m)};
try{
 await registry.load(components,dist);
 const authority=registry.resolveCapability('14.1','identity.authority',v=>v&&typeof v.authenticate==='function');
 registry.installInvocationAuthorizer(i=>authority.authorize(i));
 const invocation=await authority.authenticate(Buffer.from(request.proof.body,'base64'),request.proof.headers,controller.signal);
 await authority.authorize(invocation);
 const store=registry.resolveCapability('15.2','artifact.store.v1',v=>v&&typeof v.invoke==='function');
 const gateway=registry.resolveCapability('4.2','storage.transactions.v1',v=>v&&typeof v.withPrimaryTransaction==='function');
 const resources={gateway};
 const context={role:'provisioner',env:process.env,signal:controller.signal,resources,dependencies:{require:(id,name,validate)=>{assert(id==='15.2'&&name==='artifact.store.v1'&&validate(store),'Actual artifact dependency required');return store}}};
 const config=await readDeployment(process.env),database=bindProviderInvocation(createProviderDatabase(context),config,invocation),bootstrap=createProviderBootstrap(context),actual=createBlaxelBootstrapTransport(context);
 const journal=async()=>{const rows=await database.query('SELECT state,process_id,manifest_digest,grant_id,descriptor_digest,last_error FROM hyperfide.provider_native_bootstraps WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3',[d.org,d.run,d.intent]);return rows.rows[0]};
 let markEntered=0,markCommitted=0,childSeen=false,childAborted=false,error=null,result=null,lastInput=null;
 const parent=new AbortController(),started=Date.now();
 const transport={...actual,deliverBootstrap:async(input,signal)=>{
  lastInput=input;
  const selected={...input,...(mode==='precas'?{deadline_at:new Date(Date.now()+5000).toISOString()}:{}),markSubmitting:async child=>{
   markEntered++;childSeen=child instanceof AbortSignal;
   try{await input.markSubmitting(child);markCommitted++;}finally{childAborted=child?.aborted??false;}
   if(mode==='postcas')parent.abort(new Error('Owned abort after actual committed submission fence'));
  }};
  return actual.deliverBootstrap(selected,signal);
 }};
 try{result=await bootstrap(database,config,d.intent,parent.signal,transport)}catch(e){error={code:e.code??e.name,message:e.message}}
 const retained=await journal(),elapsed=Date.now()-started;
 if(mode==='budget'){
  assert(!error,'Protected total setup budget failed: '+JSON.stringify({error,retained,elapsed}));
  assert(result?.bootstrap==='RUNNING'&&retained.state==='OBSERVING'&&markEntered===1&&markCommitted===1&&childSeen,'One actual final submission required: '+JSON.stringify({result,retained,markEntered,markCommitted,childSeen}));
  assert(elapsed>60000&&elapsed<config.maximum_operation_ms,'Actual aggregate SDK setup must cross old60s budget within protected bound');
 }else if(mode==='precas'){
  assert(error&&markEntered===1&&markCommitted===0&&childSeen&&childAborted&&retained.state==='GRANTED','Child deadline must roll back actual blocked CAS: '+JSON.stringify({error,markEntered,markCommitted,childSeen,childAborted,retained,elapsed}));
 }else{
  assert(error&&markEntered===1&&markCommitted===1&&childSeen&&retained.state==='DELIVERING','Post-CAS abort must retain actual fence: '+JSON.stringify({error,markEntered,markCommitted,childSeen,retained}));
  const replay=await bootstrap(database,config,d.intent,controller.signal,{...actual,deliverBootstrap:async input=>{assert(input.resume_only,'Retained post-CAS attempt must be lookup-only');return actual.deliverBootstrap(input,controller.signal)}});
  const after=await journal();assert(replay.bootstrap==='UNKNOWN'&&after.process_id===retained.process_id&&after.manifest_digest===retained.manifest_digest&&after.grant_id===retained.grant_id,'Replay changed original attempt or invented completion');
 }
 console.log(JSON.stringify({status:'PASS',case:mode,scope:'actual signed coordinator/PG/pinned SDK/native protected-stage component; no READY qualification',elapsed_ms:elapsed,protected_budget_ms:config.maximum_operation_ms,mark_entered:markEntered,mark_committed:markCommitted,child_signal_seen:childSeen,child_aborted:childAborted,error,result,journal:retained,deadline_at:lastInput?.deadline_at}));
}catch(error){console.error(JSON.stringify({status:'FAIL',case:mode,code:error.code??error.name,message:error.message,stack:error.stack}));process.exitCode=1;}
finally{controller.abort();await registry.close();}
