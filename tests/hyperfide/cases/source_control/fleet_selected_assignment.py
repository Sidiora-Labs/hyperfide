#!/usr/bin/env python3
"""Real PG/TLS selected assignment; prior model/install history is controlled input, not runtime proof."""
import copy,importlib.util,json,os,socket,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid,sha
spec=importlib.util.spec_from_file_location('selected_assignment_adoption',ROOT/'tests/hyperfide/cases/tasks/3_4.py');adoption=importlib.util.module_from_spec(spec);spec.loader.exec_module(adoption)
scheduler=adoption.sched
class AssignmentFixture(scheduler.SchedulerFixture):
 def task_definition(self,**overrides):return super().task_definition(required_interfaces=["interface.read"],provided_interfaces=["interface.write"],**overrides)
def digest(value):return sha(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())
def insert(f,table,value):
 columns=list(value);f.sql('INSERT INTO hyperfide.'+table+'('+','.join(columns)+') VALUES('+','.join('$'+str(n+1) for n in range(len(columns)))+')',[json.dumps(v) if isinstance(v,dict) else v for v in value.values()])
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=AssignmentFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects']),extra_setup=adoption.native_profiles,provider_config={'provider':'fixture','account':'fixture','workspace':'selected-assignment','region':'fixture','image_digest':sha(b'CONTROLLED_PRIOR_IMAGE_PIN'),'runtime_platform':'linux-amd64'})
 checks=[]
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']]
  cohort=f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
  cohort_row=f.sql('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]
  budget={'allowed_actions':['ASSIGN_WORKER'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':1,'max_concurrent_workers':1,'task_ids':[i['task_a'],i['task_overlap']]}
  insert(f,'fleet_delegations',{**scope,'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'budget':budget,'decision_id':uid()})
  binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}
  f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
  def record(value,action='ASSIGN_WORKER'):
   operation,decision,observation,reasoning=[uid() for _ in range(4)]
   plan=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',common+[i['manager']])[0]['plan_generation']
   body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':sha(operation.encode()),'action':action,'input':value,'input_digest':digest(value),'expected_version':plan,'rationale_summary':'Controlled admitted component input; no model inference or native readiness qualification'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(cohort_row['cohort_generation']),'context_digest':body['context_digest'],'body':{'component_fixture':True}})
   insert(f,'fleet_reasoning',{**scope,'id':reasoning,'actor_id':i['manager'],'request_digest':body['context_digest'],'observation_id':observation,'state':'COMPLETED','result':{'component_fixture':True}})
   insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':action,'context_digest':body['context_digest'],'payload_digest':digest(body),'reasoning_id':reasoning,'body':body})
   return body
  previous=record({'fixture':'CONTROLLED_PRIOR_PROVISION_INPUT'},'PROVISION_SANDBOX')
  insert(f,'fleet_effect_receipts',{**scope,'operation_id':previous['operation_id'],'decision_id':previous['decision_id'],'payload_digest':digest(previous),'result':{'kind':'PROVISION_SANDBOX','delegation_id':i['package'],'sandbox_id':i['sandbox'],'fixture':'CONTROLLED_PRIOR_PROVISION_INPUT'}})
  pin=sha(b'CONTROLLED_HISTORICAL_READY_INPUT');runner=uid();root='/component/selected-worker';slot={'slot':0,'worker_slot_id':i['slot_a'],'uid':41302,'gid':41302,'slot_generation':'1','worker_root':root,'source':root+'/source','home':root+'/home','build':root+'/build','temporary':root+'/tmp','dirty':root+'/dirty'}
  insert(f,'runner_registry',{**scope,'session_id':runner,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':i['slot_a'],'repository_id':i['repository'],'state_dir':'/component/prior-runner','runner_binary':'/component/prior-native','workspace_path':slot['source'],'home_path':slot['home'],'tmp_path':slot['temporary'],'runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'readiness_digest':pin,'source_digest':pin,'source_object_id':f.source,'source_tree_id':'b'*40,'slot_generation':1,'uid':slot['uid'],'gid':slot['gid'],'observation_digest':pin,'state':'CURRENT'})
  reservation=uid();insert(f,'reservations',{**scope,'id':reservation,'request_id':uid(),'capacity_account_id':f.accounts['PREPARATION'],'quantity':'1','expires_at':'2099-01-01T00:00:00Z','state':'RELEASED','released_at':'2026-01-01T00:00:00Z'})
  job=uid();insert(f,'runner_remote_jobs',{**scope,'operation_id':job,'session_id':runner,'job_class':'PREPARATION','plan':{'fixture':'CONTROLLED_PRIOR_REGISTRATION'},'plan_digest':pin,'principal':{'fixture':True},'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':reservation,'expires_at':'2000-01-01T00:00:00Z'})
  f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3",common+[job])
  def installed(read_scope,interfaces=None):
   operation=uid();input_digest=digest({'fixture':'CONTROLLED_PRIOR_READY_INPUT','operation':operation});source_config_digest=digest({'read_scope':read_scope});environment='selected-component-'+operation
   package={'environment':{'platform':'linux-amd64','image_digest':sha(b'CONTROLLED_PRIOR_IMAGE_PIN')},'workers':{'slots':1}}
   source={'workspace':{'read_scope':read_scope,'write_scope':read_scope}}
   insert(f,'fleet_environment_specs',{**scope,'input_digest':input_digest,'package_digest':pin,'source_config_digest':source_config_digest,'source_manifest_digest':pin,'plan_digest':pin,'package_spec':package,'source_config':source,'install_plan':{'fixture':'CONTROLLED_PRIOR_READY_INPUT'},'registered_by':i['manager']})
   admission={**scope,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','package_digest':pin,'source_revision':'git:'+f.source,'slot_bindings':[slot]};receipt={'fixture':'CONTROLLED_PRIOR_READY_INPUT','slots':[slot],'source_config_digest':source_config_digest,'interfaces':{'selected_ids':['interface.read','interface.write','interface.unrelated'] if interfaces is None else interfaces}}
   insert(f,'fleet_environment_installs',{**scope,'operation_id':operation,'input_digest':input_digest,'environment_id':environment,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'authority_epoch':i['epoch'],'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'cohort_id':cohort_row['id'],'cohort_generation':int(cohort_row['cohort_generation']),'admission':admission,'admission_digest':digest(admission),'expires_at':'2099-01-01T00:00:00Z','state':'READY','receipt':receipt,'receipt_digest':digest(receipt),'completed_at':'2026-01-01T00:00:00Z'})
   insert(f,'fleet_install_heads',{**scope,'environment_id':environment,'environment_generation':1,'logical_operation_id':operation,'current_operation_id':operation})
   insert(f,'fleet_runtime_readiness',{**scope,'id':uid(),'install_operation_id':operation,'runner_operation_id':job,'runner_result_digest':pin,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'slot_id':i['slot_a'],'slot_generation':1,'runner_session_id':runner,'readiness_digest':digest({'prior':operation}),'receipt_digest':digest(receipt),'input_digest':input_digest,'measurement_digest':pin,'source_digest':pin,'source_object_id':f.source,'source_tree_id':'b'*40,'publication':{'fixture':'CONTROLLED_PRIOR_READY_INPUT'}})
   return {'operation_id':operation,'environment_id':environment,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','input_digest':input_digest}
  good=installed(f.definitions['a']['touches']);narrow=installed(['unrelated']);missing_interface=installed(f.definitions['a']['touches'],['interface.read'])
  generation=f.sql('SELECT generation::text FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]['generation']
  value={'selection':{'task_id':i['task_a'],'expected_task_generation':generation,'worker_slot':0,'lease_ms':300000,'max_runtime_seconds':3600,'max_output_bytes':1048576,'capacity':f.capacity(),'optional_context':[]},'install_binding':good}
  def apply(decision):return f.invoke('fleet.decision.apply',{'decision':decision},key='manager',component='fleet-orchestration')[1]
  def state():return {'ledger':scheduler.ledger(f),'packets':f.sql('SELECT id::text,digest,attempt_id::text FROM hyperfide.hierarchy_execution_packets ORDER BY id'),'workers':f.sql('SELECT session_id::text,attempt_id::text,packet_digest FROM hyperfide.hierarchy_worker_registrations ORDER BY session_id'),'effects':f.sql('SELECT operation_id::text FROM hyperfide.fleet_effect_receipts ORDER BY operation_id'),'plan':f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions ORDER BY session_id')}
  for name,change,expected in [('stale-task',lambda v:v['selection'].update(expected_task_generation=str(int(generation)+1)),'STALE_ATTEMPT_GENERATION'),('wrong-pin',lambda v:v['install_binding'].update(input_digest=sha(b'wrong')),'FLEET_INSTALL_SCOPE'),('narrow-scope',lambda v:v.update(install_binding=narrow),'FLEET_INSTALL_SCOPE_DENIED'),('missing-provided-interface',lambda v:v.update(install_binding=missing_interface),'FLEET_INTERFACE_MISSING')]:
   negative=copy.deepcopy(value);change(negative);decision=record(negative);before=state();response=apply(decision);assert response.get('ok') is False and response.get('error',{}).get('code')==expected,(name,response);assert state()==before,(name,'refusal leaked packet/claim/capacity/worker/effect');checks.append(name+' refuses atomically')
  decision=record(value);result=apply(decision);assert result.get('ok'),result;answer=result['result'];assignment=answer['assignment'];assert assignment['assignment_id']==assignment['worker_id']==decision['decision_id'] and assignment['tasks'][0]['attempt_id']==decision['operation_id'],assignment
  assert assignment['tasks'][0]['required_interfaces']==['interface.read'] and assignment['tasks'][0]['provided_interfaces']==['interface.write'],assignment
  checks.append('accepted required/provided interface roles preserved without promoting unrelated installed interfaces')
  packets=f.sql('SELECT digest,packet FROM hyperfide.hierarchy_execution_packets WHERE attempt_id=$1',[decision['operation_id']]);assert len(packets)==1,packets
  attempt=f.sql('SELECT id::text,task_id::text,input_packet_digest,compute_authority FROM hyperfide.attempts WHERE id=$1',[decision['operation_id']]);assert len(attempt)==1 and attempt[0]['compute_authority']=='CURRENT' and attempt[0]['input_packet_digest']==packets[0]['digest'],attempt
  worker=f.sql('SELECT session_id::text,attempt_id::text,packet_digest FROM hyperfide.hierarchy_worker_registrations WHERE session_id=$1',[decision['decision_id']]);assert len(worker)==1 and worker[0]['attempt_id']==decision['operation_id'] and worker[0]['packet_digest']==packets[0]['digest'],worker
  checks.append('selected API creates actual immutable server packet, scheduler claim and deterministic worker registration')
  before=state();replay=apply(decision);assert replay.get('ok') and replay['result']['replayed'] is True,replay;assert state()==before,'exact replay forked packet/claim/worker/capacity';checks.append('exact decision replay has no new effects')
  print(json.dumps({'status':'PASS','scope':'actual PostgreSQL/TLS packet/claim/registration; controlled admitted decision and prior READY/registry inputs; no model/native/provider qualification','assertions':checks,'provider_live':'UNRUN','native_execution':'UNRUN'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
