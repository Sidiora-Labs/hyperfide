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
  updated={**budget,'profile_ids':f.profile_ids[:]};proposal={'kind':'UPDATE_DELEGATION_BUDGET','package_id':i['wave_package'],'manager_session_id':i['manager2'],'expected_manager_generation':'2','expected_budget_digest':digest(budget),'budget':updated,'reason':'Permit a separately registered declared TEST profile before compute'}
  def refused(change,code):
   value=copy.deepcopy(proposal);change(value);decision=record('REPLAN',{'proposal':value});response=api('fleet.decision.apply',{'decision':decision});assert response.get('error',{}).get('code')==code,response
  refused(lambda v:v.update(expected_budget_digest=sha(b'stale')),'FLEET_BUDGET_REPLAN_STALE');refused(lambda v:v['budget'].update(max_sandboxes=2),'FLEET_BUDGET_PROFILE_ADDITION_ONLY');refused(lambda v:v['budget'].update(profile_ids=[f.profile_ids[0],uid()]),'FLEET_BUDGET_PROFILE_UNAPPROVED');checks.append('stale budget, quantitative widening and unregistered profile refuse')
  attempt=uid();f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','CURRENT',$7,$8,1,clock_timestamp()+interval '1 hour')",[i['organisation'],i['run'],attempt,f.budget_task,i['epoch'],sha(b'isolated current compute snapshot'),i['sandbox'],i['slot']])
  refused(lambda v:None,'FLEET_BUDGET_COMPUTE_UNSETTLED');checks.append('current compute snapshot refuses budget revision')
  f.sql("UPDATE hyperfide.attempts SET compute_authority='REVOKED',execution_state='CANCELLED',state_version=state_version+1 WHERE id=$1",[attempt])
  account,reservation=uid(),uid();f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,reserved,provenance_digest,qualification_state) VALUES($1,$2,$3,'SANDBOX','PHYSICAL',1,1,$4,'UNQUALIFIED')",[i['organisation'],account,f.pool_ids[0],sha(b'historical held fixture')]);f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour','RELEASE_PENDING')",[i['organisation'],i['run'],reservation,uid(),account]);hold=f.sql('SELECT state,quantity::text FROM hyperfide.reservations WHERE id=$1',[reservation])[0]
  accepted_decision=record('REPLAN',{'proposal':proposal});accepted=ok('fleet.decision.apply',{'decision':accepted_decision});assert accepted['manager_generation']=='2' and accepted['previous_manager_plan_generation']=='0' and accepted['manager_plan_generation']=='1' and accepted['old_budget']==budget and accepted['new_budget']==updated and accepted['ownership_changed'] is False,accepted
  assert f.sql('SELECT state,quantity::text FROM hyperfide.reservations WHERE id=$1',[reservation])[0]==hold;checks.append('registered profile addition records old/new budget and advances manager plan while preserving held historical capacity')
  replay=ok('fleet.decision.apply',{'decision':accepted_decision});assert replay['replayed'] is True and replay['manager_plan_generation']=='1';checks.append('exact decision replay does not advance either plan again')
  stale=api('fleet.decision.apply',{'decision':stale_manager},key='manager2');assert stale.get('error',{}).get('code')=='FLEET_PLAN_STALE',stale;checks.append('previously recorded manager decision fails FLEET_PLAN_STALE after budget revision')
  audit=f.sql("SELECT payload FROM hyperfide.hierarchy_ownership_events WHERE organisation_id=$1 AND run_id=$2 AND kind='DELEGATION_BUDGET_REPLANNED'",[i['organisation'],i['run']]);assert len(audit)==1 and audit[0]['payload']['decision_id']==accepted_decision['decision_id'];checks.append('immutable ownership audit links old/new digests to exact admitted Primary decision')
  print(json.dumps({'status':'PASS','assertions':checks,'scope':'isolated actual PostgreSQL and signed component API; persisted fixture decision inputs','model_inference':'NOT_CLAIMED'}))
 finally:f.close()
if __name__=='__main__':main()
