#!/usr/bin/env python3
"""Real PG/TLS scoped feedback projection; native plan/event/checkpoint history is declared input only."""
import copy,importlib.util,json,os,socket,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid,sha
s=importlib.util.spec_from_file_location('feedback_assignment_fixture',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');selected=importlib.util.module_from_spec(s);s.loader.exec_module(selected)
insert=selected.insert;digest=selected.digest
RAW='RAW_NATIVE_TEXT_MUST_NOT_ENTER_FEEDBACK'
class FeedbackFixture(selected.AssignmentFixture):
 def packet_request(self,name='a',**overrides):return super().packet_request(name,attempt_generation='2' if name=='a' else '1',**overrides)
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 def setup(f):
  selected.adoption.native_profiles(f);i=f.ids;f.old_attempt=uid();f.old_worker=uid();scope={'organisation_id':i['organisation'],'run_id':i['run']};pin=sha(b'DECLARED_HISTORICAL_INPUT_NOT_EXECUTION_PROOF')
  insert(f,'attempts',{**scope,'id':f.old_attempt,'task_id':i['task_a'],'generation':1,'authority_epoch':i['epoch'],'input_packet_digest':pin,'execution_state':'FAILED','compute_authority':'RELEASED','sandbox_id':i['sandbox'],'slot_id':i['slot_a'],'sandbox_boot_generation':1,'created_at':'2026-01-01T00:00:00Z'})
  f.sql('UPDATE hyperfide.tasks SET generation=1,state_version=state_version+1 WHERE id=$1',[i['task_a']])
  insert(f,'agent_sessions',{**scope,'id':f.old_worker,'role':'WORKER','parent_session_id':i['manager'],'connector':'codex','account_key':'fixture-model-account','native_session_id':'declared-old-native','slot_id':i['slot_a'],'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'attempt_id':f.old_attempt,'state':'STOPPED'})
  f.page_attempts=[]
  for n in range(6):
   task,attempt=uid(),uid();definition=copy.deepcopy(f.definitions['a']);definition['touches']=['src/page-'+str(n)+'.ts'];insert(f,'tasks',{**scope,'id':task,'task_key':'alpha.feedback-page-'+str(n),'feature_package_id':i['package'],'spec_revision_id':i['accepted_spec'],'spec_generation':f.spec_generation,'criteria_digest':sha(str(n).encode()),'definition':definition,'wave':1})
   insert(f,'attempts',{**scope,'id':attempt,'task_id':task,'generation':1,'authority_epoch':i['epoch'],'input_packet_digest':pin,'execution_state':'PLANNED','compute_authority':'RELEASED','created_at':'2026-01-02T00:00:0'+str(n)+'Z'});f.sql('UPDATE hyperfide.tasks SET generation=1,current_attempt_id=$2,state_version=state_version+1 WHERE id=$1',[task,attempt]);f.page_attempts.append(attempt)
 f=FeedbackFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects']),extra_setup=setup,agent_limit=4)
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];pin=sha(b'DECLARED_HISTORICAL_INPUT_NOT_EXECUTION_PROOF');checks=[]
  claims={};workers={}
  for name,key in [('a','manager'),('b','manager2')]:
   claim=f.claim(name);token=claim['token'];claims[name]=token
   workers[name]=f.ok('hierarchy.worker.register',{'idempotency_key':'feedback-'+name,'leader_generation':'1','package_generation':'2','token':token},key=key,component='hierarchy-worker-registration')['session_id']
  f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
  bindings={}
  for name,key,package in [('a','manager','package'),('b','manager2','wave_package')]:
   insert(f,'fleet_delegations',{**scope,'package_id':i[package],'manager_session_id':i[key],'manager_generation':2,'leader_generation':1,'budget':{'allowed_actions':['REPLAN'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':1,'max_concurrent_workers':4,'task_ids':[claims[name]['task_id']]},'decision_id':uid()})
   bindings[name]={'actor_id':i[key],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i[package],'manager_generation':'2'};f.ok('fleet.session.bind',{'binding':bindings[name]},key=key,component='fleet-orchestration')
  runner=uid();root='/component/feedback-worker'
  insert(f,'runner_registry',{**scope,'session_id':runner,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':i['slot_a'],'repository_id':i['repository'],'state_dir':root+'/runner','runner_binary':root+'/native','workspace_path':root+'/source','home_path':root+'/home','tmp_path':root+'/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'readiness_digest':pin,'source_digest':pin,'source_object_id':f.source,'source_tree_id':'b'*40,'slot_generation':1,'uid':41302,'gid':41302,'observation_digest':pin,'state':'CURRENT'})
  versions={}
  def plan(token,worker,state,created):
   command,launch,reservation=uid(),uid(),uid();versions[token['attempt_id']]=versions.get(token['attempt_id'],0)+1;version=versions[token['attempt_id']];quota='declared-'+command;event=uid();request={'fixture':'CONTROLLED_PRIOR_NATIVE_PLAN_INPUT','launch_id':launch};packet=f.sql('SELECT input_packet_digest FROM hyperfide.attempts WHERE id=$1',[token['attempt_id']])[0]['input_packet_digest']
   insert(f,'outbox_events',{**scope,'id':event,'aggregate_type':'attempt.instructions','aggregate_id':token['attempt_id'],'aggregate_version':version,'event_type':'instruction.start','payload':{'fixture':'DECLARED_START_HISTORY'}})
   insert(f,'scheduler_dispatches',{**scope,'id':command,'request_id':command,'task_id':token['task_id'],'attempt_id':token['attempt_id'],'attempt_generation':int(token['attempt_generation']),'authority_epoch':i['epoch'],'sandbox_id':token['sandbox_id'],'slot_id':token['slot_id'],'sandbox_boot_generation':1,'payload_digest':pin,'state':'FAILED' if state=='REFUSED' else 'UNKNOWN','event_id':event})
   insert(f,'agent_admission_accounts',{**scope,'quota_key':quota,'policy_digest':pin,'max_concurrent':1})
   insert(f,'agent_admission_reservations',{**scope,'id':reservation,'quota_key':quota,'session_id':worker,'payload_digest':pin,'policy_digest':pin,'state':'RESERVED'})
   insert(f,'native_launch_plans',{**scope,'command_id':command,'launch_id':launch,'agent_session_id':worker,'slot_id':token['slot_id'],'attempt_id':token['attempt_id'],'attempt_generation':int(token['attempt_generation']),'connector':'codex','connector_plan_digest':pin,'admission_reservation_id':reservation,'reservation_attempt':1,'admission_policy_digest':pin,'run_policy_digest':pin,'qualification_receipt_digest':pin,'packet_digest':packet,'payload_digest':pin,'plan':request,'created_at':created})
   if token['slot_id']==i['slot_a']:insert(f,'fleet_worker_launches',{**scope,'command_id':command,'launch_id':launch,'runner_session_id':runner,'executor_credential_id':uid(),'authority_epoch':i['epoch'],'request':request,'request_digest':digest(request),'state':state,'failure_code':'DECLARED_OUTCOME_UNKNOWN' if state=='UNKNOWN' else 'DECLARED_PRIOR_REFUSAL','completed_at':created})
   return {'command':command,'launch':launch,'worker':worker,'request_digest':digest(request)}
  old={'task_id':i['task_a'],'attempt_id':f.old_attempt,'attempt_generation':'1','sandbox_id':i['sandbox'],'slot_id':i['slot_a']}
  stale_plan=plan(old,f.old_worker,'REFUSED','2026-01-01T00:01:00Z');previous={'command':uid(),'launch':uid(),'worker':workers['a']};current=plan(claims['a'],workers['a'],'UNKNOWN','2026-01-01T00:03:00Z')
  def event(which,attempt,sequence,run=None,principal=None,boot=None):
   ident,journal=uid(),uid();payload={**scope,'schema_version':1,'event_id':ident,'launch_id':which['launch'],'command_id':which['command'],'sandbox_id':i['sandbox'],'boot_id':boot or i['boot'],'sandbox_boot_generation':1,'sequence':sequence,'kind':'native.question','observed_at_seconds':1,'data':{'connector':'codex','agent_session_id':which['worker'],'event':{'method':'error','params':{'willRetry':True,'error':{'codexErrorInfo':'component-wait'}}},'raw_text':RAW*100}}
   insert(f,'command_inbox',{**scope,'run_id':run or i['run'],'id':journal,'principal_scope':principal or 'runner:'+i['sandbox']+':'+i['boot'],'operation':'runner.launch-event','idempotency_key':ident,'request_digest':digest(payload),'state':'COMPLETED','result':{'recorded':True,'event_id':ident,'launch_id':which['launch'],'sequence':sequence,'kind':'native.question','attempt_id':attempt,'signal':'MODEL_WAITING','payload':payload}});return ident
  event(stale_plan,f.old_attempt,999);event(previous,claims['a']['attempt_id'],998);first_event=event(current,claims['a']['attempt_id'],1);latest=event(current,claims['a']['attempt_id'],2)
  event(current,claims['a']['attempt_id'],1000,principal='runner:'+uid()+':'+i['boot']);event(current,claims['a']['attempt_id'],2000,boot=uid());event(current,claims['b']['attempt_id'],3000)
  def checkpoint(attempt,generation,packet,worker):
   artifact,checkpoint=uid(),uid();content=sha(artifact.encode());insert(f,'artifacts',{**scope,'id':artifact,'digest':content,'size_bytes':0,'storage_backend':'CONTROLLED_HISTORICAL_METADATA_ONLY','storage_key':artifact,'status':'COMPLETE'})
   insert(f,'checkpoints',{**scope,'id':checkpoint,'attempt_id':attempt,'attempt_generation':generation,'agent_session_id':worker,'artifact_id':artifact,'repository_id':i['repository'],'source_object_id':f.source,'input_packet_digest':packet,'support_level':'SOURCE_ONLY'});return checkpoint
  packet=f.sql('SELECT input_packet_digest FROM hyperfide.attempts WHERE id=$1',[claims['a']['attempt_id']])[0]['input_packet_digest'];checkpoints=[checkpoint(claims['a']['attempt_id'],2,packet,workers['a']) for _ in range(3)];wrong_checkpoint=checkpoint(claims['a']['attempt_id'],2,pin,workers['a']);old_checkpoint=checkpoint(f.old_attempt,1,pin,f.old_worker)
  def finding(run,package,summary,state='OPEN'):
   ident=uid();insert(f,'findings',{**scope,'run_id':run,'id':ident,'dedup_digest':sha(ident.encode()),'owner_package_id':package,'repository_id':i['repository'],'source_object_id':f.source,'severity':'WARNING','summary':summary,'state':state});return ident
  existing_findings={r['id'] for r in f.sql("SELECT id::text FROM hyperfide.findings WHERE organisation_id=$1 AND run_id=$2 AND owner_package_id=$3 AND state IN('OPEN','ACKNOWLEDGED')",common+[i['package']])};findings=[finding(i['run'],i['package'],'界'*2048) for _ in range(9)];other_finding=finding(i['run'],i['wave_package'],'OTHER_MANAGER_ONLY');finding(i['run'],i['package'],'RESOLVED_NOT_CURRENT','RESOLVED')
  foreign_run,foreign_package,foreign_attempt=uid(),uid(),uid();insert(f,'runs',{'organisation_id':i['organisation'],'id':foreign_run,'project_id':i['project'],'spec_revision_id':i['accepted_spec'],'policy_digest':pin,'authority_epoch':i['epoch'],'state':'RUNNING'});insert(f,'run_repositories',{'organisation_id':i['organisation'],'run_id':foreign_run,'repository_id':i['repository'],'source_object_id':f.source,'integration_ref':'refs/heads/main'});insert(f,'feature_packages',{'organisation_id':i['organisation'],'run_id':foreign_run,'id':foreign_package,'package_key':'foreign','wave':1})
  foreign_finding=finding(foreign_run,foreign_package,'FOREIGN_RUN_ONLY');event(current,claims['a']['attempt_id'],4000,run=foreign_run)
  before=selected.scheduler.ledger(f)
  def observe(name='a'):
   return f.ok('fleet.observe',{'binding':bindings[name],'after':None,'limit':100},key='manager' if name=='a' else 'manager2',component='fleet-orchestration')['worker_feedback']
  shown=observe();rows=shown['attempts']['items'];mine=next(row for row in rows if row['id']==claims['a']['attempt_id']);assert mine['attempt_generation']=='2' and mine['launch']['launch_id']==current['launch'] and mine['launch']['state']=='UNKNOWN' and mine['launch']['request_digest']==current['request_digest'],mine
  assert mine['launch']['signature_recorded'] is False and mine['launch']['result_digest'] is None and mine['progress']['event_id']==latest and mine['progress']['signal']=='MODEL_WAITING',mine
  assert mine['checkpoint_count']==3 and len(mine['checkpoints'])==2 and mine['checkpoint_details_omitted'] is True,mine
  assert not shown['execution_authority'] and not shown['task_qualified'] and shown['attempts']['reported_result_is_not_independent_qualification'] is True,shown
  assert len(rows)<=4 and shown['attempts']['has_more'] and shown['attempts']['next_cursor'] and shown['findings']['has_more'] and len(json.dumps(shown,ensure_ascii=False,separators=(',',':')).encode())<=16384,shown
  assert RAW not in json.dumps(shown) and claims['b']['attempt_id'] not in [r['id'] for r in rows] and f.old_attempt not in [r['id'] for r in rows]
  assert set(r['id'] for r in shown['findings']['items'])<=(set(findings)|existing_findings) and other_finding not in json.dumps(shown) and foreign_finding not in json.dumps(shown)
  checks.append('owner sees current UNKNOWN launch/request digest and authenticated current-plan signal; stale plan/attempt/run/boot/principal excluded')
  others=observe('b');assert all(row['package_id']==i['wave_package'] for row in others['attempts']['items']) and claims['a']['attempt_id'] not in json.dumps(others),others
  checks.append('cross-manager and cross-run rows remain outside scoped observation')
  def read(collection,attempt=None,cursor=None,limit=8,expected=None):
   actor=i['manager'];context=sha(uid().encode());decision_id,operation,observation,reason=[uid() for _ in range(4)];request={'collection':collection,'cursor':cursor,'limit':limit}
   if attempt is not None:request['attempt_id']=attempt
   plan=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',common+[actor])[0]['plan_generation'];body={'schema_version':1,'kind':'hyperfide.fleet-decision','decision_id':decision_id,'operation_id':operation,'run_id':i['run'],**bindings['a'],'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':context,'action':'REPLAN','input':{'history_request':request},'input_digest':digest({'history_request':request}),'expected_version':plan,'rationale_summary':'Declared component advisory-history request; no inference or execution proof'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':actor,'cohort_generation':1,'context_digest':context,'body':{'fixture':True}});insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':actor,'request_digest':context,'observation_id':observation,'state':'COMPLETED','result':{'fixture':True}});insert(f,'fleet_decisions',{**scope,'id':decision_id,'operation_id':operation,'actor_id':actor,'action':'REPLAN','context_digest':context,'payload_digest':digest(body),'reasoning_id':reason,'body':body})
   answer=f.invoke('fleet.decision.apply',{'decision':body},key='manager',component='fleet-orchestration')[1]
   if expected:assert answer.get('error',{}).get('code')==expected,answer;return None
   assert answer.get('ok'),answer;page=answer['result'];assert not page['execution_authority'] and len(json.dumps(page,ensure_ascii=False,separators=(',',':')).encode())<=49152,page;return page
  first=read('worker_feedback',limit=2);second=read('worker_feedback',cursor=first['next_cursor'],limit=2);assert len(first['items'])==2 and first['has_more'] and not(set(x['id'] for x in first['items'])&set(x['id'] for x in second['items']))
  quiet=next(x for x in first['items']+second['items'] if x['id']!=claims['a']['attempt_id']);assert quiet['progress_observation']=='UNREPORTED' and quiet['launch_observation']=='NO_REGISTERED_CURRENT_PLAN',quiet
  page=read('worker_events',claims['a']['attempt_id']);assert {r['event_id'] for r in page['items']}=={first_event,latest},page
  page=read('worker_checkpoints',claims['a']['attempt_id']);assert {r['id'] for r in page['items']}==set(checkpoints) and wrong_checkpoint not in json.dumps(page) and old_checkpoint not in json.dumps(page) and page['resume_eligibility']=='REQUIRES_CHECKPOINT_AUTHORITY',page
  page=read('findings');assert len(page['items'])<8 and page['has_more'] and page['next_cursor'],page;found={r['id'] for r in page['items']};pages=1
  while page['has_more']:
   page=read('findings',cursor=page['next_cursor']);batch={r['id'] for r in page['items']};assert not(found&batch);found|=batch;pages+=1;assert pages<=9
  assert found==(set(findings)|existing_findings),(found,set(findings)|existing_findings)
  for attempt in [claims['b']['attempt_id'],f.old_attempt,foreign_attempt]:read('worker_events',attempt,expected='FLEET_WORKER_FEEDBACK_UNAVAILABLE')
  read('worker_feedback',limit=9,expected='FLEET_HISTORY_REQUEST_INVALID');assert selected.scheduler.ledger(f)==before,'Advisory reads changed execution/capacity/task state'
  checks.append('explicit metadata pages honor count/byte limits and stable cursors; checkpoints are exact packet refs, not resume authority; inaccessible attempts refuse')
  print(json.dumps({'status':'PASS','scope':'actual PostgreSQL/TLS observations and advisory reads; declared historical plan/event/checkpoint inputs, no native execution proof','assertions':checks,'native_execution':'UNRUN','provider_live':'UNRUN'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
