#!/usr/bin/env python3
"""Signed independent boot-scoped heads; controlled enrollment metadata grants no native qualification."""
import copy,importlib.util,json,os,socket,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid,sha
import fleet_live_qualification as oracle
spec=importlib.util.spec_from_file_location('parallel_head_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
insert,digest=a.insert,a.digest

def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 image=sha(b'CONTROLLED_PARALLEL_IMAGE_PIN')
 f=a.AssignmentFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects','fleet-install']),extra_setup=a.adoption.native_profiles,provider_config={'provider':'fixture','account':'fixture','workspace':'parallel-heads','region':'fixture','image_digest':image,'runtime_platform':'linux-amd64'})
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']]
  cohort=f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
  insert(f,'fleet_delegations',{**scope,'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'budget':{'allowed_actions':['fleet.install.admit'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':2,'max_concurrent_workers':2,'task_ids':[i['task_a']]},'decision_id':uid()})
  binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}
  f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
  def record(value,action='fleet.install.admit'):
   operation,decision,observation,reason=[uid() for _ in range(4)]
   generation=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE session_id=$1',[i['manager']])[0]['plan_generation']
   body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':sha(operation.encode()),'action':action,'input':value,'input_digest':digest(value),'expected_version':generation,'rationale_summary':'Controlled component decision prerequisite; no model inference or native qualification'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(cohort['cohort_generation']),'context_digest':body['context_digest'],'body':{'controlled_component_prerequisite':True}})
   insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':i['manager'],'request_digest':body['context_digest'],'observation_id':observation,'state':'COMPLETED','result':{'controlled_component_prerequisite':True}})
   insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':action,'context_digest':body['context_digest'],'payload_digest':digest(body),'reasoning_id':reason,'body':body});return body
  environment='parallel-'+uid();root='/component/'+environment;pin=sha(b'CONTROLLED_REGISTERED_PLAN')
  package={'environment':{'environment_id':environment,'environment_generation':1,'root':root,'platform':'linux-amd64','image_digest':image},'workers':{'slots':1,**{name+'_template':root+'/workers/{slot}/'+path for name,path in [('source','source'),('home','home'),('build','build'),('temporary','tmp'),('dirty','dirty')]}}}
  source={'source':{'revision':'git:'+f.source,'repository':i['repository']},'workspace':{'authority_epoch':i['epoch'],'read_scope':['src/**'],'write_scope':['src/**']}}
  input_digest=digest({'package':package,'source':source})
  insert(f,'fleet_environment_specs',{**scope,'input_digest':input_digest,'package_digest':digest(package),'source_config_digest':digest(source),'source_manifest_digest':pin,'plan_digest':pin,'package_spec':package,'source_config':source,'install_plan':{'controlled_registered_input':True},'registered_by':i['manager']})
  guests=[]
  for label in ['a','b']:
   sandbox=i['sandbox'] if label=='a' else uid()
   if label=='b':insert(f,'sandboxes',{'organisation_id':i['organisation'],'id':sandbox,'pool_id':i['pool'],'native_sandbox_id':'controlled-parallel-'+uid(),'observed_state':'RUNNING','preparation_digest':f.preparation})
   boot=f.sql('SELECT boot_id::text FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[i['organisation'],sandbox])[0]['boot_id']
   prep,worker,session,worker_session=[uid() for _ in range(4)]
   for slot,kind,session_id,owner,workspace in [(prep,'PREPARATION',session,41801,root+'/preparation'),(worker,'AGENT',worker_session,41802,root+'/workers/0')]:
    insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':slot,'sandbox_id':sandbox,'slot_key':label+'-'+kind,'boot_generation':1,'capacity_kind':kind,'state':'READY'})
    insert(f,'runner_registry',{**scope,'session_id':session_id,'credential_id':uid(),'sandbox_id':sandbox,'boot_id':boot,'boot_generation':1,'slot_id':slot,'repository_id':i['repository'],'state_dir':workspace+'/state','runner_binary':'/component/native','workspace_path':workspace+'/source','home_path':workspace+'/home','tmp_path':workspace+'/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':owner,'gid':owner,'observation_digest':pin,'state':'PREPARING'})
   ownership=record({},'PROVISION_SANDBOX')
   insert(f,'fleet_effect_receipts',{**scope,'operation_id':ownership['operation_id'],'decision_id':ownership['decision_id'],'payload_digest':digest(ownership),'result':{'kind':'PROVISION_SANDBOX','delegation_id':i['package'],'sandbox_id':sandbox,'controlled_component_prerequisite':True}})
   guests.append({'sandbox':sandbox,'boot':boot,'prep':prep,'session':session,'worker':worker})
  def value(guest,ttl=300):return {'input_digest':input_digest,'environment_id':environment,'environment_generation':1,'sandbox_id':guest['sandbox'],'boot_id':guest['boot'],'boot_generation':'1','ttl_seconds':ttl,'slot_bindings':[{'slot':0,'worker_slot_id':guest['worker']}]}
  def apply(decision):return f.invoke('fleet.install.admit',{'decision':decision},key='manager',component='fleet-install')[1]
  def heads():return f.sql('SELECT environment_id,environment_generation::text,sandbox_id::text,boot_id::text,boot_generation::text,logical_operation_id::text,current_operation_id::text FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2 AND environment_id=$3 ORDER BY sandbox_id',common+[environment])
  def seed_job(guest,old,unknown=False):
   request,allocation,reservation=[uid() for _ in range(3)]
   task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]
   insert(f,'agent_sessions',{**scope,'id':guest['session'],'role':'WORKER','parent_session_id':i['manager'],'connector':'fixture','account_key':'fixture','native_session_id':'CONTROLLED_UNCLAIMED_PREPARATION','slot_id':guest['prep'],'sandbox_id':guest['sandbox'],'sandbox_boot_generation':1,'state':'REGISTERED'})
   f.sql("UPDATE hyperfide.worker_slots SET state='ALLOCATED',state_version=state_version+1 WHERE id=$1",[guest['prep']])
   insert(f,'resource_waiters',{**scope,'id':uid(),'request_id':request,'pool_id':i['pool'],'owner_session_id':i['manager'],'task_id':i['task_a'],'spec_revision_id':task['spec_revision_id'],'spec_generation':int(task['spec_generation']),'criteria_digest':task['criteria_digest'],'resource_policy_digest':pin,'job_kind':'PREPARATION','priority':0,'state':'ADMITTED','admitted_at':'2000-01-01T00:00:00Z','deadline_at':'2000-01-01T00:00:00Z'})
   reservations=[]
   for dimension in ['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
    ident=reservation if dimension=='PREPARATION' else uid();reservations.append(ident)
    insert(f,'reservations',{**scope,'id':ident,'request_id':request,'capacity_account_id':f.accounts[dimension],'quantity':'1','expires_at':'2000-01-01T00:00:00Z','state':'ALLOCATED'})
    f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,state_version=state_version+1 WHERE id=$1',[f.accounts[dimension]])
   insert(f,'resource_job_allocations',{**scope,'id':allocation,'request_id':request,'task_id':i['task_a'],'reservation_id':reservation,'job_kind':'PREPARATION','slot_id':guest['prep'],'sandbox_id':guest['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':guest['session']})
   plan={'operation_id':old['operation_id'],'binding':{'sandbox_id':guest['sandbox'],'boot_id':guest['boot'],'boot_generation':'1','session_id':guest['session'],'slot_id':guest['prep']},'allocation':{'allocation_id':allocation,'generation':'1','request_id':request},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':old['operation_id'],'input_packet_digest':old['admission_digest']}}}
   insert(f,'runner_remote_jobs',{**scope,'operation_id':old['operation_id'],'session_id':guest['session'],'job_class':'PREPARATION','plan':plan,'plan_digest':digest(plan),'principal':{'controlled_expired_unclaimed_input':True},'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':reservation,'expires_at':'2000-01-01T00:00:00Z'})
   if unknown:
    f.sql("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp() WHERE operation_id=$1",[old['operation_id'],uid(),i['provisioner']])
    f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[old['operation_id']])
   return {'kind':'NOT_STARTED','install_operation_id':old['operation_id'],'admission_digest':old['admission_digest'],'runner_operation_id':old['operation_id'],'runner_plan_digest':digest(plan)}
  decisions=[];admissions=[]
  for guest in guests:
   decision=record(value(guest,ttl=1 if guest==guests[1] else 300));response=apply(decision);assert response.get('ok'),response
   decisions.append(decision);admissions.append(response['result']['admission'])
   if guest==guests[0]:
    seed_job(guest,admissions[0],unknown=True)
    uncertain_job=f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[admissions[0]['operation_id']])[0]['row']
    held_accounts=f.sql('SELECT id::text,reserved::text,allocated::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])
  initial=heads();assert len(initial)==2 and len({row['boot_id'] for row in initial})==2 and {row['current_operation_id'] for row in initial}=={d['operation_id'] for d in decisions},initial
  print(json.dumps({'phase':'independent_heads_admitted','heads':initial}),flush=True)
  assert f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[admissions[0]['operation_id']])[0]['row']==uncertain_job
  assert f.sql('SELECT id::text,reserved::text,allocated::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])==held_accounts
  observed=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},key='manager',component='fleet-orchestration')
  assert observed['uncertainty_contract']['retry_scope']=='EXACT_OPERATION_AND_PHYSICAL_BOOT' and observed['uncertainty_contract']['independent_intent']
  retained=next(row for row in observed['install_recovery_jobs'] if row['runner_operation_id']==admissions[0]['operation_id'])
  assert retained['state']=='UNKNOWN' and retained['claim_id']==uncertain_job['claim_id'] and retained['result_absent'] is True,retained
  installs=f.sql('SELECT to_jsonb(e) AS row FROM hyperfide.fleet_environment_installs e WHERE operation_id=ANY($1::uuid[])',[[d['operation_id'] for d in decisions]])
  for row in installs:
   selected=oracle.verified_install_head({'fleet_install_heads':initial},row['row']);assert selected['sandbox_id']==row['row']['sandbox_id']
   for mutation in ['wrong-current','wrong-boot']:
    bad=copy.deepcopy(initial)
    selected_bad=next(head for head in bad if head['sandbox_id']==row['row']['sandbox_id'])
    selected_bad['current_operation_id' if mutation=='wrong-current' else 'boot_id']=uid()
    try:oracle.verified_install_head({'fleet_install_heads':bad},row['row'])
    except oracle.Refused:pass
    else:raise AssertionError('Oracle accepted '+mutation)

  replay=apply(decisions[0]);assert replay.get('ok') and replay['result']['admission']==admissions[0] and heads()==initial,replay
  duplicate=apply(record(value(guests[0])));assert duplicate.get('error',{}).get('code')=='FLEET_INSTALL_CONFLICT' and heads()==initial,duplicate
  old=admissions[1];guest=guests[1];recovery=seed_job(guest,old)
  cross={**value(guests[0]),'recovery_of':recovery};cross_response=apply(record(cross));assert cross_response.get('error',{}).get('code')=='FLEET_INSTALL_RECOVERY_DENIED' and heads()==initial,cross_response
  time.sleep(1.1)
  next_decision=record({**value(guest),'recovery_of':recovery});next_response=apply(next_decision);assert next_response.get('ok'),next_response
  advanced=heads();expected=copy.deepcopy(initial)
  for row in expected:
   if row['sandbox_id']==guest['sandbox']:row['current_operation_id']=next_decision['operation_id']
  assert advanced==expected,advanced
  proofs=f.sql('SELECT id::text FROM hyperfide.runner_not_started_proofs WHERE runner_operation_id=$1',[old['operation_id']]);assert len(proofs)==1,proofs
  replay_recovery=apply(next_decision);assert replay_recovery.get('ok') and heads()==advanced and f.sql('SELECT id::text FROM hyperfide.runner_not_started_proofs WHERE runner_operation_id=$1',[old['operation_id']])==proofs,replay_recovery
  branch=apply(record({**value(guest),'recovery_of':recovery}));assert branch.get('error',{}).get('code')=='FLEET_INSTALL_SUPERSEDED' and heads()==advanced,branch
  assert f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[admissions[0]['operation_id']])[0]['row']==uncertain_job
  assert f.sql('SELECT id::text,reserved::text,allocated::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])==held_accounts
  print(json.dumps({'status':'PASS','scope':'actual signed admission and recovery over isolated PostgreSQL; controlled registered plan/enrollment/job inputs, no model/native/provider qualification','initial_heads':initial,'advanced_heads':advanced,'duplicate':duplicate['error'],'cross_boot':cross_response['error'],'branch':branch['error'],'uncertainty_retry_scope':observed['uncertainty_contract']['retry_scope'],'old_unknown_retained':True,'checks':['same environment generation admits independent heads on two native boots','same boot duplicate and old-predecessor branch refuse','recovery advances only its exact boot and preserves global root','original and recovery decisions replay without extra heads or proofs']}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
