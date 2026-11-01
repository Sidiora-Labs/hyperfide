#!/usr/bin/env python3
"""Actual PG authority/trigger races; declared expired job inputs, no executor/native qualification."""
import copy,importlib.util,json,os,socket,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid,sha
s=importlib.util.spec_from_file_location('not_started_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
insert=a.insert;digest=a.digest
EXPIRED='2000-01-01T00:00:00Z'
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 image=sha(b'CONTROLLED_PRIOR_IMAGE_PIN');f=a.AssignmentFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects','fleet-install','fleet-install-delivery']),extra_setup=a.adoption.native_profiles,provider_config={'provider':'fixture','account':'fixture','workspace':'not-started','region':'fixture','image_digest':image,'runtime_platform':'linux-amd64'})
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];pin=sha(b'CONTROLLED_INITIAL_NOT_STARTED_METADATA')
  f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration');cohort=f.sql('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]
  insert(f,'fleet_delegations',{**scope,'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'budget':{'allowed_actions':['fleet.install.admit'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':1,'max_concurrent_workers':4,'task_ids':[i['task_a']]},'decision_id':uid()})
  binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'};f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
  def record(value,action='fleet.install.admit'):
   operation,decision,observation,reason=[uid() for _ in range(4)];generation=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE session_id=$1',[i['manager']])[0]['plan_generation'];body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':sha(operation.encode()),'action':action,'input':value,'input_digest':digest(value),'expected_version':generation,'rationale_summary':'Controlled historical manager decision input; no model inference evidence'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(cohort['cohort_generation']),'context_digest':body['context_digest'],'body':{'controlled_fixture_input':True}});insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':i['manager'],'request_digest':body['context_digest'],'observation_id':observation,'state':'COMPLETED','result':{'controlled_fixture_input':True}});insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':action,'context_digest':body['context_digest'],'payload_digest':digest(body),'reasoning_id':reason,'body':body});return body
  previous=record({},'PROVISION_SANDBOX');insert(f,'fleet_effect_receipts',{**scope,'operation_id':previous['operation_id'],'decision_id':previous['decision_id'],'payload_digest':digest(previous),'result':{'kind':'PROVISION_SANDBOX','delegation_id':i['package'],'sandbox_id':i['sandbox'],'fixture':'CONTROLLED_PRIOR_OWNERSHIP_INPUT'}})
  def seed(name):
   operation,prep_slot,session,reservation,request,allocation,waiter=[uid() for _ in range(7)];root='/component/not-started/'+operation;env='not-started-'+operation
   insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':prep_slot,'sandbox_id':i['sandbox'],'slot_key':'prep-'+operation,'boot_generation':1,'capacity_kind':'PREPARATION','state':'ALLOCATED'})
   insert(f,'agent_sessions',{**scope,'id':session,'role':'WORKER','parent_session_id':i['manager'],'connector':'fixture','account_key':'fixture','native_session_id':'CONTROLLED_PRIOR_PREPARATION-'+operation,'slot_id':prep_slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'state':'REGISTERED'})
   insert(f,'runner_registry',{**scope,'session_id':session,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':prep_slot,'state_dir':root+'/state','runner_binary':'/component/native','workspace_path':root+'/prep-source','home_path':root+'/prep-home','tmp_path':root+'/prep-tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':41401,'gid':41401,'observation_digest':pin,'state':'PREPARING'})
   worker_slot=uid();worker_session=uid();worker_root=root+'/workers/0'
   insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':worker_slot,'sandbox_id':i['sandbox'],'slot_key':'agent-'+operation,'boot_generation':1,'capacity_kind':'AGENT','state':'READY'})
   insert(f,'runner_registry',{**scope,'session_id':worker_session,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':worker_slot,'state_dir':root+'/worker-state','runner_binary':'/component/native','workspace_path':worker_root+'/source','home_path':worker_root+'/home','tmp_path':worker_root+'/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':41402+len(cases),'gid':41402+len(cases),'observation_digest':pin,'state':'PREPARING'})
   package={'environment':{'environment_id':env,'environment_generation':1,'root':root,'platform':'linux-amd64','image_digest':image},'workers':{'slots':1,**{n+'_template':root+'/workers/{slot}/'+v for n,v in [('source','source'),('home','home'),('build','build'),('temporary','tmp'),('dirty','dirty')]}}};source={'source':{'revision':'git:'+f.source},'workspace':{'authority_epoch':i['epoch'],'read_scope':['src/**'],'write_scope':['src/**']}};input_digest=digest({'case':operation});insert(f,'fleet_environment_specs',{**scope,'input_digest':input_digest,'package_digest':pin,'source_config_digest':pin,'source_manifest_digest':pin,'plan_digest':pin,'package_spec':package,'source_config':source,'install_plan':{'controlled_prior_spec':True},'registered_by':i['manager']})
   slot={'slot':0,'worker_slot_id':worker_slot,'uid':41402+len(cases),'gid':41402+len(cases),'slot_generation':'1','worker_root':worker_root,**{n:worker_root+'/'+v for n,v in [('source','source'),('home','home'),('build','build'),('temporary','tmp'),('dirty','dirty')]}}
   admission={**scope,'operation_id':operation,'logical_operation_id':operation,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','authority_epoch':i['epoch'],'input_digest':input_digest,'environment_id':env,'environment_generation':1,'slot_bindings':[slot],'expires_at':EXPIRED};admission_digest=digest(admission);admission['admission_digest']=admission_digest
   install={**scope,'operation_id':operation,'input_digest':input_digest,'environment_id':env,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'authority_epoch':i['epoch'],'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'cohort_id':cohort['id'],'cohort_generation':int(cohort['cohort_generation']),'admission':admission,'admission_digest':admission_digest,'expires_at':EXPIRED};insert(f,'fleet_environment_installs',install);insert(f,'fleet_install_heads',{**scope,'environment_id':env,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'logical_operation_id':operation,'current_operation_id':operation})
   task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]
   insert(f,'resource_waiters',{**scope,'id':waiter,'request_id':request,'pool_id':i['pool'],'owner_session_id':i['manager'],'task_id':i['task_a'],'spec_revision_id':task['spec_revision_id'],'spec_generation':int(task['spec_generation']),'criteria_digest':task['criteria_digest'],'resource_policy_digest':pin,'job_kind':'PREPARATION','priority':0,'state':'ADMITTED','admitted_at':'1999-12-31T23:59:59Z','enqueued_at':'1999-12-31T23:59:58Z','deadline_at':EXPIRED})
   insert(f,'reservations',{**scope,'id':reservation,'request_id':request,'capacity_account_id':f.accounts['PREPARATION'],'quantity':'1','expires_at':EXPIRED,'state':'ALLOCATED'});f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,state_version=state_version+1 WHERE id=$1',[f.accounts['PREPARATION']])
   extra_reservations=[]
   for dimension in ['CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
    ident=uid();extra_reservations.append(ident);insert(f,'reservations',{**scope,'id':ident,'request_id':request,'capacity_account_id':f.accounts[dimension],'quantity':'1','expires_at':EXPIRED,'state':'ALLOCATED'});f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,state_version=state_version+1 WHERE id=$1',[f.accounts[dimension]])
   insert(f,'resource_job_allocations',{**scope,'id':allocation,'request_id':request,'task_id':i['task_a'],'reservation_id':reservation,'job_kind':'PREPARATION','slot_id':prep_slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':session})
   plan={'operation_id':operation,'binding':{'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','session_id':session,'slot_id':prep_slot},'allocation':{'allocation_id':allocation,'generation':'1','request_id':request},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':operation,'input_packet_digest':admission_digest}}};plan_digest=digest(plan)
   insert(f,'runner_remote_jobs',{**scope,'operation_id':operation,'session_id':session,'job_class':'PREPARATION','plan':plan,'plan_digest':plan_digest,'principal':{'controlled_historical_input':True},'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':reservation,'expires_at':'2099-01-01T00:00:00Z' if name=='live-expiry' else EXPIRED})
   value={'input_digest':input_digest,'environment_id':env,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','ttl_seconds':300,'slot_bindings':[{'slot':0,'worker_slot_id':worker_slot}],'recovery_of':{'kind':'NOT_STARTED','install_operation_id':operation,'admission_digest':admission_digest,'runner_operation_id':operation,'runner_plan_digest':plan_digest}}
   out={'name':name,'install':install,'binding':value['recovery_of'],'input':value,'reservation':reservation,'reservation_ids':[reservation,*extra_reservations],'allocation':allocation,'session':session};cases.append(out);return out
  f.sql('UPDATE hyperfide.capacity_accounts SET configured_limit=100,state_version=state_version+1 WHERE id=$1',[f.accounts['PREPARATION']])
  cases=[]
  for name in ['proof-first','proof-first-serial','claim-first','unknown','provider-operation','live-expiry','wrong-plan','public-admit']:seed(name)
  by={c['name']:c for c in cases}
  f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[by['unknown']['install']['operation_id']])
  c=by['provider-operation'];insert(f,'provider_remote_operations',{**scope,'id':c['install']['operation_id'],'session_id':c['session'],'sandbox_id':i['sandbox'],'boot_generation':1,'request_digest':pin,'runner_binding_evidence_digest':pin,'operation':{'controlled_possible_provider_effect_input':True},'state':'UNKNOWN'})
  by['wrong-plan']['binding']['runner_plan_digest']=sha(b'wrong')
  observed=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},key='manager',component='fleet-orchestration')
  alternatives=observed['action_contracts']['fleet.install.admit']['recovery_of']['one_of'];assert any(set(row['required'])=={'kind','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest'} for row in alternatives),alternatives
  for c in cases:
   row=next(row for row in observed['install_recovery_jobs'] if row['runner_operation_id']==c['install']['operation_id']);assert 'observed_runner_plan' not in row
   recovery=row['not_started_recovery']
   if c['name'] in ['unknown','provider-operation','live-expiry']:assert recovery['eligibility']=='UNKNOWN' and 'recovery_of' not in recovery,(c['name'],recovery)
   else:
    assert recovery['eligibility']=='ELIGIBLE_FOR_AUTHORITY_RECHECK',(c['name'],recovery)
    expected=copy.deepcopy(c['binding'])
    if c['name']=='wrong-plan':expected['runner_plan_digest']=f.sql('SELECT plan_digest FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[c['install']['operation_id']])[0]['plan_digest']
    assert recovery['recovery_of']==expected,(c['name'],recovery)
  print(json.dumps({'status':'PASS','scope':'actual signed manager fleet.observe recovery candidates and closed NOT_STARTED schema; no inferred native outcome'}),flush=True)
  principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['credential_id']==i['operator'])
  payload={'scope':scope,'cases':cases,'principal':principal,'epoch':i['epoch']}
  script=r"""
import fs from 'node:fs';import pg from './core/control-plane/node_modules/pg/lib/index.js';
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {authenticatedInvocation} from './core/control-plane/dist/transport/protocol.js';
import {proveInstallNotStarted} from './core/control-plane/dist/preparation/fleet_not_started.js';
const d=JSON.parse(fs.readFileSync(0)),r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal}),s=[d.scope.organisation_id,d.scope.run_id];
const assert=(v,m)=>{if(!v)throw Error(m)},i=authenticatedInvocation({principal:d.principal,signal:new AbortController().signal,guard:async tx=>{const row=(await tx.query('SELECT authority_epoch FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[...s])).rows[0];assert(row?.authority_epoch===d.epoch,'Actual current run authority required')}}),cases=Object.fromEntries(d.cases.map(c=>[c.name,c]));
const tx=(body,retries=2)=>r.gateway.withPrimaryTransaction({timeoutMs:10000,maxRetries:retries,guard:i.guard},body),proof=c=>tx(t=>proveInstallNotStarted(t,i,c.binding,c.install));
const read=c=>tx(async t=>({job:(await t.query('SELECT * FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[...s,c.install.operation_id])).rows[0],reservations:(await t.query('SELECT state FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',[...s,c.reservation_ids])).rows,allocation:(await t.query('SELECT state FROM hyperfide.resource_job_allocations WHERE id=$1',[c.allocation])).rows[0],proofs:(await t.query('SELECT * FROM hyperfide.runner_not_started_proofs WHERE runner_operation_id=$1',[c.install.operation_id])).rows}));
const claimSql="UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$4,executor_credential_id=$5,claimed_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3";
const args=c=>[...s,c.install.operation_id,'11111111-1111-4111-8111-111111111111',d.principal.credential_id];
let tests=[];
try{
 for(const name of ['unknown','provider-operation','live-expiry','wrong-plan']){const c=cases[name],before=await read(c);let code;try{await proof(c)}catch(e){code=e.code}assert(code==='FLEET_INSTALL_NOT_STARTED_UNPROVEN',name+': '+code);assert(JSON.stringify(await read(c))===JSON.stringify(before),name+' refusal changed authority');tests.push(name+' refuses atomically')}
 for(const name of ['proof-first','proof-first-serial']){
  const c=cases[name],before=await read(c);let enter,release;const entered=new Promise(v=>enter=v),latch=new Promise(v=>release=v);
  const proving=tx(async t=>{const result=await proveInstallNotStarted(t,i,c.binding,c.install);enter();await latch;return result});await entered;
  let claimant;
  if(name==='proof-first'){
   const client=new pg.Client({connectionString:process.env.HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL??process.env.DATABASE_URL});await client.connect();await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');const pending=client.query(claimSql,args(c)).then(()=>null,e=>e.code);release();await proving;const code=await pending;await client.query('ROLLBACK');await client.end();assert(code==='23514','Late READ COMMITTED claim was not fenced: '+code)
  }else{
   let snap;const snapshot=new Promise(v=>snap=v);claimant=tx(async t=>{await t.query('SELECT id FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',s);snap();await t.query(claimSql,args(c))},0).then(()=>null,e=>e.code);await snapshot;release();await proving;assert(['TX_RETRY_EXHAUSTED','DB_UNAVAILABLE'].includes(await claimant),'Old SERIALIZABLE claim snapshot was not aborted')
  }
  const after=await read(c);for(const k of ['state','expires_at','result','result_digest','result_signature','claim_id','executor_credential_id','claimed_at','completed_at'])assert(JSON.stringify(after.job[k])===JSON.stringify(before.job[k]),name+' rewrote original '+k);assert(after.proofs.length===1&&after.job.not_started_proof_id===after.proofs[0].id,'Append-only proof marker missing');assert(after.reservations.length===4&&after.reservations.every(x=>x.state==='RELEASED')&&after.allocation.state==='RELEASED','Exact logical preparation allocation not released');tests.push(name+' fences late controlled SQL claim; old ADMITTED/expiry/empty result retained, logical allocation released')
 }
 {
  const c=cases['claim-first'];let enter,release;const entered=new Promise(v=>enter=v),latch=new Promise(v=>release=v);const claiming=tx(async t=>{await t.query('SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE operation_id=$1 FOR UPDATE',[c.install.operation_id]);enter();await latch;await t.query(claimSql,args(c))});await entered;const proving=proof(c).then(()=>null,e=>e.code);release();await claiming;assert(await proving==='FLEET_INSTALL_NOT_STARTED_UNPROVEN','Claim-first not refused');const after=await read(c);assert(after.proofs.length===0&&after.reservations.every(x=>x.state==='ALLOCATED')&&after.allocation.state==='ACTIVE','Claim-first released logical capacity');tests.push('claim-first wins row lock; production proof refuses and preserves held capacity')
 }
 console.log(JSON.stringify({status:'PASS',scope:'actual PostgreSQL production proof/release and0731trigger races against explicitly controlled SQL claim contenders; not executor API/native qualification',assertions:tests}));
}finally{await r.close()}
"""
  p=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(payload),text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=90);print(p.stdout,end='');print(p.stderr,end='',file=sys.stderr)
  if p.returncode:return p.returncode
  c=by['public-admit'];decision=record(c['input']);answer=f.invoke('fleet.install.admit',{'decision':decision},key='manager',component='fleet-install')[1];assert answer.get('ok'),answer;admission=answer['result']['admission'];assert admission['operation_id']==admission['logical_operation_id']==decision['operation_id'] and 'recovery_of' not in admission,admission
  head=f.sql('SELECT logical_operation_id::text,current_operation_id::text FROM hyperfide.fleet_install_heads WHERE environment_id=$1 AND environment_generation=$2 AND sandbox_id=$3 AND boot_id=$4 AND boot_generation=$5',[c['install']['environment_id'],c['install']['environment_generation'],c['install']['sandbox_id'],c['install']['boot_id'],c['install']['boot_generation']])[0];assert head=={'logical_operation_id':c['install']['operation_id'],'current_operation_id':decision['operation_id']},head
  print(json.dumps({'status':'PASS','scope':'actual signed manager fleet.install.admit after production NOT_STARTED proof; controlled prior state only','native_logical_self':True,'global_database_root_preserved':True,'provider_live':'UNRUN','native_execution':'UNRUN'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
