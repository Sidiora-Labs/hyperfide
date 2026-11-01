#!/usr/bin/env python3
"""Signed API/actual PostgreSQL budget semantics with explicit fixture decision inputs, not model qualification."""
import copy,importlib.util,json,os,socket,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure,hierarchy_type
from identity_fixture import sha
spec=importlib.util.spec_from_file_location('budget_preparation_fixture',ROOT/'tests/hyperfide/cases/tasks/11_1.py');pre=importlib.util.module_from_spec(spec);spec.loader.exec_module(pre)
def uid():return str(uuid.uuid4())
def digest(value):return sha(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())
def main():
 def setup(f):
  secrets=f.path/'budget-private-secrets';attachments=f.path/'budget-private-attachments';secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700)
  credentials=f.path/'budget-credentials.json';credentials.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}));credentials.chmod(0o600);f.env['HF_CREDENTIAL_CONFIG_FILE']=str(credentials)
  f.budget_task=uid();f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,'budget-test',$4,$5,$6,'{\"feature_key\":\"beta\",\"purpose\":\"Isolated budget contract\",\"touches\":[\"src/b.c\"]}',1)",[f.ids['organisation'],f.ids['run'],f.budget_task,f.ids['wave_package'],f.ids['spec'],sha(b'budget criteria')])
  native=json.loads((ROOT/'build/fleet/worker/private/native-profile.json').read_text());native['profiles']=native['profiles'][:1];profile=native['profiles'][0]
  binary=ROOT/'build/fleet/worker/private/claude-2.1.300';assert sha(binary.read_bytes())==profile['binary']['digest'];home=f.path/'budget-native-home';home.mkdir(mode=0o700);os.chown(home,int(profile['target_uid']),int(profile['target_uid']));profile['binary']['path']=str(binary);profile['runtime_home']=str(home)
  inventory=f.path/'budget-native-profiles.json';inventory.write_text(json.dumps(native));inventory.chmod(0o600);f.env['HF_NATIVE_AUTH_PROFILES_FILE']=str(inventory)
  f.profile_ids=[uid(),uid()];f.pool_ids=[uid(),uid()];f.manifests=[]
  for index in range(2):
   fixture=pre.Fixture(f.path/('declared-profile-'+str(index)));fixture.profile['profile_version']='1.0.'+str(index);fixture.profile['repositories'][0]['url']='https://example.invalid/fixture.git';f.manifests.append(fixture.create())
  limits={'SANDBOX':'2','PROVISIONING':'2','CPU_MILLIS':'10000','MEMORY_BYTES':'8589934592','DISK_BYTES':'64424509440'}
  f.pool_config={'schema_version':1,'organisation_id':f.ids['organisation'],'revision':'ISOLATED_COMPONENT_APPROVAL','accounts':[{'provider':'railway','account_key':'budget-account','approved_limits':limits,'planning_limits':limits}],'pools':[{'id':f.pool_ids[n],'provider':'railway','account_key':'budget-account','environment_key':'budget-env','region':'budget-region','profile_id':f.profile_ids[n],'preparation_digest':f.manifests[n]['digest'],'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'ISOLATED_NOT_PROVISIONED','network':'ISOLATED','stdin_required':False}} for n in range(2)],'maximum_operation_ms':120000}
  file=f.path/'budget-pools.json';file.write_text(json.dumps(f.pool_config));file.chmod(0o600);f.env['HYPERFIDE_POOL_CONFIG']=str(file)
 f=hierarchy_type()(extra_components=component_closure(['fleet-orchestration']),extra_setup=setup,bootstrap=False,seed_historical_runtime=False,parent_managers=True)
 checks=[]
 try:
  i=f.ids
  def api(action,value,key='leader',component='fleet-orchestration'):
   return f.invoke(action,value,component=component,key=key)[1]
  def ok(action,value,**kwargs):
   response=api(action,value,**kwargs);assert response.get('ok'),response;return response['result']
  ok('hierarchy.leader.acquire',{'idempotency_key':'budget-leader','expected_generation':'0','reason':'Isolated component leadership'},component='3.1')
  ok('hierarchy.package.configure',{'idempotency_key':'budget-wave','leader_generation':'1','package_id':i['wave_package'],'feature_key':'beta','allocation_policy':'WAVE'},component='3.1')
  cohort=uid();ok('fleet.cohort.bind',{'cohort_id':cohort,'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'})
  for n in range(2):
   registered=ok('provider.profiles.register',{'profile_id':f.profile_ids[n],'runtime_platform':'linux-amd64','manifest':f.manifests[n]},key='operator',component='8.2');assert registered['created'] is True and registered['qualified'] is False
   pool=f.pool_config['pools'][n];f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'railway','budget-account','budget-env','budget-region',$3)",[i['organisation'],pool['id'],pool['profile_id']]);document={'pool':pool,'account':f.pool_config['accounts'][0]};f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document,active) VALUES($1,$2,$3,$4,true)',[i['organisation'],pool['id'],digest(document),json.dumps(document)])
  budget={'allowed_actions':['PROVISION_SANDBOX','REPLAN'],'provider_ids':['railway'],'profile_ids':[f.profile_ids[0]],'max_sandboxes':1,'max_concurrent_workers':1,'task_ids':[f.budget_task]}
  def record(action,value,role='PRIMARY',expected=None):
   actor=i['leader'] if role=='PRIMARY' else i['manager2'];plan=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[i['organisation'],i['run'],actor])[0]['plan_generation'];decision={'schema_version':1,'kind':'hyperfide.fleet-decision','decision_id':uid(),'operation_id':uid(),'run_id':i['run'],'actor_id':actor,'actor_role':role,'authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':None if role=='PRIMARY' else i['wave_package'],'manager_generation':None if role=='PRIMARY' else '2','source_revision':'git:'+'a'*40,'spec_revision':i['spec'],'context_digest':sha(('ISOLATED_FIXTURE_INPUT:'+uid()).encode()),'action':action,'input':value,'input_digest':digest(value),'expected_version':plan if expected is None else expected,'rationale_summary':'Explicit isolated component input; no model inference or runtime proof claimed'}
   observation,reason=uid(),uid();f.sql('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,$6)',[i['organisation'],i['run'],observation,actor,decision['context_digest'],json.dumps({'component_fixture':True})]);f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED','{\"component_fixture\":true}')",[i['organisation'],i['run'],reason,actor,decision['context_digest'],observation]);f.sql('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[i['organisation'],i['run'],decision['decision_id'],decision['operation_id'],actor,action,decision['context_digest'],digest(decision),reason,json.dumps(decision)]);return decision
  initial=record('DELEGATE_WAVE',{'package_id':i['wave_package'],'manager_session_id':i['manager2'],'expected_generation':'1','budget':budget});ok('fleet.decision.apply',{'decision':initial})
  binding={'actor_id':i['manager2'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['wave_package'],'manager_generation':'2'};ok('fleet.session.bind',{'binding':binding},key='manager2')
  stale_manager=record('REPLAN',{'proposal':{'component_fixture':'old manager plan'}},role='WAVE_MANAGER')
  # Explicit prior compute and uncertain debt are inputs, never model/native qualification.
  sandbox,agent_slot,prep_slot,prep_session,attempt=[uid() for _ in range(5)]
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'controlled-budget-existing-guest','RUNNING',$4)",[i['organisation'],sandbox,f.pool_ids[0],f.manifests[0]['digest']])
  boot=f.sql('SELECT boot_id::text FROM hyperfide.sandbox_boots WHERE sandbox_id=$1',[sandbox])[0]['boot_id']
  for slot,kind in [(agent_slot,'AGENT'),(prep_slot,'PREPARATION')]:f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$4,1,$5,'ALLOCATED')",[i['organisation'],slot,sandbox,'budget-'+kind,kind])
  f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '1 hour')",[i['organisation'],i['run'],attempt,f.budget_task,i['epoch'],sha(b'controlled current compute input'),sandbox,agent_slot])
  f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,parent_session_id,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,state) VALUES($1,$2,$3,'WORKER',$4,'fixture','fixture','controlled-budget-preparer',$5,$6,1,'REGISTERED')",[i['organisation'],i['run'],prep_session,i['manager2'],prep_slot,sandbox])
  request,allocation,preparation_reservation,unknown_job=[uid() for _ in range(4)]
  task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[f.budget_task])[0]
  f.sql("INSERT INTO hyperfide.resource_waiters(organisation_id,run_id,id,request_id,pool_id,owner_session_id,task_id,spec_revision_id,spec_generation,criteria_digest,resource_policy_digest,job_kind,priority,state,deadline_at,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PREPARATION',0,'ADMITTED',clock_timestamp()+interval '1 hour',clock_timestamp())",[i['organisation'],i['run'],uid(),request,f.pool_ids[0],i['manager2'],f.budget_task,task['spec_revision_id'],task['spec_generation'],task['criteria_digest'],sha(b'controlled prior allocation policy')])
  logical=[]
  for dimension in ['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
   account=uid();reservation=preparation_reservation if dimension=='PREPARATION' else uid();logical.append(reservation)
   f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,allocated,provenance_digest,qualification_state) VALUES($1,$2,$3,$4,'EXECUTION',1,1,$5,'UNQUALIFIED')",[i['organisation'],account,f.pool_ids[0],dimension,sha(b'controlled held logical capacity')])
   f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour','ALLOCATED')",[i['organisation'],i['run'],reservation,request,account])
  f.sql("INSERT INTO hyperfide.resource_job_allocations(organisation_id,run_id,id,request_id,task_id,reservation_id,job_kind,slot_id,sandbox_id,sandbox_boot_generation,assignee_session_id) VALUES($1,$2,$3,$4,$5,$6,'PREPARATION',$7,$8,1,$9)",[i['organisation'],i['run'],allocation,request,f.budget_task,preparation_reservation,prep_slot,sandbox,prep_session])
  credential=uid()
  f.sql("INSERT INTO hyperfide.identity_principals(credential_id,organisation_id,run_id,actor_id,role,public_key_b64,deployment_epoch,allowed_actions,expires_at,sandbox_id,boot_id,boot_generation) VALUES($1,$2,$3,$1,'RUNNER',$4,$5,$6,clock_timestamp()+interval '1 hour',$7,$8,1)",[credential,i['organisation'],i['run'],f.keys['runner']['public_key_b64'],i['epoch'],['identity.describe'],sandbox,boot])
  f.sql("INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,repository_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,boot_preparation_digest,preparation_digest,slot_generation,uid,gid,observation_digest,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,'/component/budget/state','/component/budget/native','/component/budget/source','/component/budget/home','/component/budget/tmp',$9,$10,$10,1,64031,64031,$9,'PREPARING')",[i['organisation'],i['run'],prep_session,credential,sandbox,boot,prep_slot,i['repository'],sha(b'controlled prior runner metadata'),f.manifests[0]['digest']])
  plan={'controlled_prior_unknown_job':True,'binding':{'sandbox_id':sandbox,'boot_id':boot,'boot_generation':'1','session_id':prep_session,'slot_id':prep_slot},'allocation':{'allocation_id':allocation,'generation':'1','request_id':request}}
  f.sql("INSERT INTO hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id,session_id,job_class,plan,plan_digest,principal,admission_digest,authority_epoch,reservation_id,expires_at) VALUES($1,$2,$3,$4,'PREPARATION',$5,$6,'{\"controlled_prior_claim\":true}',$6,$7,$8,clock_timestamp()+interval '1 hour')",[i['organisation'],i['run'],unknown_job,prep_session,plan,digest(plan),i['epoch'],preparation_reservation])
  f.sql("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp() WHERE operation_id=$1",[unknown_job,uid(),i['provisioner']])
  f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[unknown_job])
  physical_account,physical_reservation=uid(),uid()
  f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,reserved,provenance_digest,qualification_state) VALUES($1,$2,$3,'SANDBOX','PHYSICAL',1,1,$4,'UNQUALIFIED')",[i['organisation'],physical_account,f.pool_ids[0],sha(b'controlled historical provider debt')])
  f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour','RELEASE_PENDING')",[i['organisation'],i['run'],physical_reservation,uid(),physical_account])
  def execution_snapshot():
   tables=['attempts','resource_waiters','resource_job_allocations','runner_remote_jobs','runner_registry','identity_principals','provider_remote_operations','reservations','capacity_accounts','sandboxes','worker_slots','agent_sessions']
   fields=[]
   for table in tables:
    scope="t.organisation_id=$1"+(" AND t.run_id=$2" if table not in ['capacity_accounts','sandboxes','worker_slots'] else '')
    fields.append("'"+table+"',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM hyperfide."+table+" t WHERE "+scope+")")
   return f.sql('SELECT jsonb_build_object('+','.join(fields)+') AS body',[i['organisation'],i['run']])[0]['body']
  held=execution_snapshot()
  current_budget=copy.deepcopy(budget)
  def proposal(next_budget=None):return {'kind':'UPDATE_DELEGATION_BUDGET','package_id':i['wave_package'],'manager_session_id':i['manager2'],'expected_manager_generation':'2','expected_budget_digest':digest(current_budget),'budget':copy.deepcopy(current_budget if next_budget is None else next_budget),'reason':'Extend declared budget while preserving original work and retained accounting'}
  def control_snapshot():return {'delegation':f.sql('SELECT to_jsonb(d) AS row FROM hyperfide.fleet_delegations d WHERE package_id=$1',[i['wave_package']]),'plans':f.sql('SELECT session_id::text,plan_generation::text FROM hyperfide.fleet_actor_sessions ORDER BY session_id'),'audit':f.sql("SELECT id::text,payload FROM hyperfide.hierarchy_ownership_events WHERE kind='DELEGATION_BUDGET_REPLANNED' ORDER BY id")}
  def refused(name,change,code,role='PRIMARY'):
   value=proposal();change(value);chosen=record('REPLAN',{'proposal':value},role=role);before=control_snapshot();response=api('fleet.decision.apply',{'decision':chosen},key='leader' if role=='PRIMARY' else 'manager2')
   assert response.get('error',{}).get('code')==code,(name,response)
   assert execution_snapshot()==held and control_snapshot()==before,name
   checks.append(name+' refuses without changing retained execution, accounting or authority');return response
  numeric={**current_budget,'max_sandboxes':2,'max_concurrent_workers':2}
  numeric_decision=record('REPLAN',{'proposal':proposal(numeric)});numeric_result=ok('fleet.decision.apply',{'decision':numeric_decision})
  assert numeric_result['old_budget']==budget and numeric_result['new_budget']==numeric and numeric_result['added_profile_ids']==[] and numeric_result['limit_increases']=={'max_sandboxes':{'previous':1,'next':2},'max_concurrent_workers':{'previous':1,'next':2}},numeric_result
  assert numeric_result['previous_manager_plan_generation']=='0' and numeric_result['manager_plan_generation']=='1' and numeric_result['existing_execution_unchanged'] is True and numeric_result['capacity_admission_unchanged'] is True and numeric_result['new_work_dispatched'] is False
  assert execution_snapshot()==held;current_budget=copy.deepcopy(numeric);checks.append('numeric-only expansion admits under CURRENT compute, ACTIVE allocation and claimed UNKNOWN job while all debt and counters stay byte-identical')
  expanded={**current_budget,'profile_ids':f.profile_ids[:]}
  profile_decision=record('REPLAN',{'proposal':proposal(expanded)});profile_result=ok('fleet.decision.apply',{'decision':profile_decision})
  assert profile_result['old_budget']==numeric and profile_result['new_budget']==expanded and profile_result['added_profile_ids']==[f.profile_ids[1]] and profile_result['limit_increases']=={} and profile_result['manager_generation']=='2' and profile_result['previous_manager_plan_generation']=='1' and profile_result['manager_plan_generation']=='2' and profile_result['ownership_changed'] is False,profile_result
  assert execution_snapshot()==held;current_budget=copy.deepcopy(expanded);checks.append('approved profile-only addition also preserves active work and advances only manager plan generation')
  refused('no-op',lambda v:None,'FLEET_BUDGET_NO_CHANGE')
  refused('sandbox-limit-shrink',lambda v:v['budget'].update(max_sandboxes=1),'FLEET_BUDGET_ADDITIVE_ONLY')
  refused('worker-limit-shrink',lambda v:v['budget'].update(max_concurrent_workers=1),'FLEET_BUDGET_ADDITIVE_ONLY')
  refused('profile-removal',lambda v:v['budget'].update(profile_ids=[f.profile_ids[0]]),'FLEET_BUDGET_ADDITIVE_ONLY')
  for field,values in [('allowed_actions',['PROVISION_SANDBOX']),('provider_ids',['railway','blaxel']),('task_ids',[])]:refused('unauthorized-'+field,lambda v,k=field,x=values:v['budget'].update({k:x}),'FLEET_BUDGET_ADDITIVE_ONLY')
  refused('over-ceiling',lambda v:v['budget'].update(max_sandboxes=10001),'FLEET_BUDGET_INVALID')
  refused('stale-budget-digest',lambda v:v.update(expected_budget_digest=digest(budget)),'FLEET_BUDGET_REPLAN_STALE')
  refused('wrong-owner',lambda v:v.update(manager_session_id=i['manager']),'FLEET_BUDGET_MANAGER_STALE')
  refused('unapproved-profile',lambda v:v['budget'].update(profile_ids=f.profile_ids+[uid()]),'FLEET_BUDGET_PROFILE_UNAPPROVED')
  refused('manager-cannot-expand-own-authority',lambda v:v['budget'].update(max_sandboxes=3),'FLEET_PRIMARY_REQUIRED',role='WAVE_MANAGER')
  replay_before=control_snapshot()
  for chosen in [numeric_decision,profile_decision]:
   replay=ok('fleet.decision.apply',{'decision':chosen});assert replay['replayed'] is True and execution_snapshot()==held and control_snapshot()==replay_before,replay
  checks.append('both exact Primary decision replays preserve final budget, plan generations, audit and all execution rows')
  stale=api('fleet.decision.apply',{'decision':stale_manager},key='manager2');assert stale.get('error',{}).get('code')=='FLEET_PLAN_STALE' and execution_snapshot()==held and control_snapshot()==replay_before,stale
  checks.append('old manager decision remains fenced FLEET_PLAN_STALE after additive revisions')
  audit=f.sql("SELECT id::text,payload FROM hyperfide.hierarchy_ownership_events WHERE organisation_id=$1 AND run_id=$2 AND kind='DELEGATION_BUDGET_REPLANNED' ORDER BY created_at,id",[i['organisation'],i['run']])
  assert len(audit)==2 and [row['payload']['decision_id'] for row in audit]==[numeric_decision['decision_id'],profile_decision['decision_id']],audit
  for row,result in zip(audit,[numeric_result,profile_result]):
   for field in ['old_budget_digest','new_budget_digest','old_budget','new_budget','limit_increases']:assert row['payload'][field]==result[field],(field,row,result)
  try:f.sql("UPDATE hyperfide.hierarchy_ownership_events SET payload='{}' WHERE id=$1",[audit[0]['id']])
  except AssertionError as error:assert '23514' in str(error),str(error)
  else:raise AssertionError('Retained budget audit was mutable')
  assert f.sql("SELECT id::text,payload FROM hyperfide.hierarchy_ownership_events WHERE organisation_id=$1 AND run_id=$2 AND kind='DELEGATION_BUDGET_REPLANNED' ORDER BY created_at,id",[i['organisation'],i['run']])==audit and execution_snapshot()==held
  checks.append('two immutable audits retain exact previous/new budgets, quantitative deltas and original Primary decisions')
  print(json.dumps({'status':'PASS','assertions':checks,'scope':'isolated actual PostgreSQL and signed component API; persisted fixture decision inputs','model_inference':'NOT_CLAIMED','numeric_revision':numeric_result,'profile_revision':profile_result,'retained_state':{'attempt_compute':'CURRENT','allocation':'ACTIVE','runner_job':'UNKNOWN','physical_debt':'RELEASE_PENDING'}}))
 finally:f.close()
if __name__=='__main__':main()
