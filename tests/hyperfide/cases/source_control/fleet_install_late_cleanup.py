#!/usr/bin/env python3
"""Actual PG scheduler cleanup of declared signed terminal history, not native/READY qualification."""
import importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('late_install_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
uid,sha,insert=a.uid,a.sha,a.insert

def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
 f=a.AssignmentFixture(extra_setup=a.adoption.native_profiles)
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};pin=sha(b'CONTROLLED_SIGNED_TERMINAL_INPUT_NOT_NATIVE_EXECUTION');checks=[]
  ended=f.sql("SELECT (clock_timestamp()-interval '60 seconds')::text AS ended")[0]['ended'];past=f.sql("SELECT (clock_timestamp()-interval '40 seconds')::text AS expired")[0]['expired']
  def seed(name):
   slot,session,request,allocation,job=[uid() for _ in range(5)];reservations=[];accounts=[]
   insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':slot,'sandbox_id':i['sandbox'],'slot_key':'late-'+name,'boot_generation':1,'capacity_kind':'PREPARATION','state':'ALLOCATED'})
   insert(f,'agent_sessions',{**scope,'id':session,'role':'WORKER','parent_session_id':i['manager'],'connector':'fixture','account_key':'fixture','native_session_id':'controlled-prior-'+name,'slot_id':slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'state':'REGISTERED'})
   insert(f,'runner_registry',{**scope,'session_id':session,'credential_id':uid(),'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':slot,'repository_id':i['repository'],'state_dir':'/component/late/state','runner_binary':'/component/late/native','workspace_path':'/component/late/source','home_path':'/component/late/home','tmp_path':'/component/late/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'slot_generation':1,'uid':64041,'gid':64041,'observation_digest':pin,'state':'PREPARING'})
   task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]
   insert(f,'resource_waiters',{**scope,'id':uid(),'request_id':request,'pool_id':i['pool'],'owner_session_id':i['manager'],'task_id':i['task_a'],'spec_revision_id':task['spec_revision_id'],'spec_generation':int(task['spec_generation']),'criteria_digest':task['criteria_digest'],'resource_policy_digest':pin,'job_kind':'PREPARATION','priority':0,'state':'ADMITTED','deadline_at':past,'admitted_at':'1999-12-31T23:59:59Z','enqueued_at':'1999-12-31T23:59:58Z'})
   for dimension in ['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
    account,reservation=f.accounts[dimension],uid();accounts.append(account);reservations.append(reservation)
    f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,configured_limit=GREATEST(configured_limit,allocated+1),state_version=state_version+1 WHERE id=$1',[account])
    insert(f,'reservations',{**scope,'id':reservation,'request_id':request,'capacity_account_id':account,'quantity':'1','expires_at':past,'state':'ALLOCATED'})
   insert(f,'resource_job_allocations',{**scope,'id':allocation,'request_id':request,'task_id':i['task_a'],'reservation_id':reservations[0],'job_kind':'PREPARATION','slot_id':slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':session})
   binding={'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','session_id':session,'slot_id':slot,'slot_generation':'1'};alloc={'allocation_id':allocation,'generation':'1','request_id':request,'task_id':i['task_a'],'slot_id':slot,'sandbox_id':i['sandbox'],'sandbox_boot_generation':'1','assignee_session_id':session};plan={'operation_id':job,'binding':binding,'allocation':alloc,'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':job}},'controlled_terminal_input':True};result={**scope,'operation_id':job,'session_id':session,'outcome':'SUCCEEDED','cleanup_status':'CONFIRMED','cleanup':{'complete':True,'observed_process_absent':True},'ended_at':ended,'controlled_terminal_input':True};
   if name=='wrong-boot':plan['binding']['boot_id']=uid()
   if name=='wrong-slot-generation':plan['binding']['slot_generation']='2'
   if name=='wrong-allocation-generation':plan['allocation']['generation']='2'
   pd=a.digest(plan);rd=a.digest(result);signature=f.sign('leader' if name=='bad-signature' else 'provisioner',('HYPERFIDE-RUNNER-RESULT-V1\n'+i['organisation']+'\n'+i['run']+'\n'+job+'\n'+pd+'\n'+rd+'\n').encode())
   insert(f,'runner_remote_jobs',{**scope,'operation_id':job,'session_id':session,'job_class':'PREPARATION','plan':plan,'plan_digest':pd,'principal':{'controlled_terminal_history_input':True},'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':reservations[0],'expires_at':past})
   f.sql("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp()-interval '90 seconds',native_claimed_at=clock_timestamp()-interval '80 seconds',native_claim_operation_id=$4 WHERE operation_id=$1",[job,uid(),i['provisioner'],uid()])
   f.sql("UPDATE hyperfide.runner_remote_jobs SET state='COMPLETED',result=$2,result_digest=$3,result_signature=$4,completed_at=$5 WHERE operation_id=$1",[job,json.dumps(result),rd,signature,ended])
   return {'name':name,'operation':job,'allocation':allocation,'slot':slot,'session':session,'request':request,'reservations':reservations,'accounts':accounts,'plan':plan,'result':result,'signature':signature}
  names=['positive','generic'] if '--baseline' in sys.argv else ['positive','generic','wrong-boot','wrong-slot-generation','wrong-allocation-generation','bad-signature','successor-job','conflicting-allocation']
  cases={name:seed(name) for name in names}
  def state(c):
   return {table:f.sql(query,values) for table,query,values in [('allocation','SELECT to_jsonb(a) AS row FROM hyperfide.resource_job_allocations a WHERE id=$1',[c['allocation']]),('slot','SELECT to_jsonb(w) AS row FROM hyperfide.worker_slots w WHERE id=$1',[c['slot']]),('reservations','SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE request_id=$1 ORDER BY id',[c['request']]),('accounts','SELECT to_jsonb(a) AS row FROM hyperfide.capacity_accounts a WHERE id=ANY($1::uuid[]) ORDER BY id',[c['accounts']]) ]}
  def finish(c,generic=False):
   method='finishPreparationAllocation' if generic else 'finishFleetInstallAllocation'
   return f.primary('await claims.'+method+'(tx,{...data.scope,operation_id:data.operation});return true;',{'operation':c['operation']})
  c=cases['generic'];before=state(c);r=finish(c,True);assert r.get('error',{}).get('code')=='QUIESCENCE_UNCONFIRMED',r;assert state(c)==before;checks.append('generic-preparation-30-second-bound-remains-strict')
  other_before={name:{k:v for k,v in state(value).items() if k!='accounts'} for name,value in cases.items() if name!='positive'}
  counters={r['id']:int(r['allocated']) for r in f.sql('SELECT id::text,allocated::text FROM hyperfide.capacity_accounts WHERE id=ANY($1::uuid[])',[cases['positive']['accounts']])}
  c=cases['positive'];before_job=f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[c['operation']]);r=finish(c,'--baseline' in sys.argv);assert r.get('result') is True,('late signed cleanup refused',r)
  assert f.sql('SELECT state FROM hyperfide.resource_job_allocations WHERE id=$1',[c['allocation']])[0]['state']=='RELEASED'
  assert f.sql('SELECT state FROM hyperfide.worker_slots WHERE id=$1',[c['slot']])[0]['state']=='READY'
  assert all(x['state']=='RELEASED' for x in f.sql('SELECT state FROM hyperfide.reservations WHERE request_id=$1',[c['request']]))
  assert all(int(x['allocated'])==counters[x['id']]-1 for x in f.sql('SELECT id::text,allocated::text FROM hyperfide.capacity_accounts WHERE id=ANY($1::uuid[])',[c['accounts']]))
  assert f.sql('SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[c['operation']])==before_job;checks.append('delayed-signed-install-releases-only-original-expired-four-vector-and-slot-with-job-immutable')
  assert {name:{k:v for k,v in state(value).items() if k!='accounts'} for name,value in cases.items() if name!='positive'}==other_before
  released=state(c);replay=finish(c);assert replay.get('error',{}).get('code')=='JOB_ALLOCATION_STALE' and state(c)==released,replay;checks.append('late-cleanup-reinvocation-does-not-double-release')
  for name,code in [('wrong-boot','JOB_ALLOCATION_STALE'),('wrong-slot-generation','JOB_ALLOCATION_STALE'),('wrong-allocation-generation','JOB_ALLOCATION_STALE'),('bad-signature','QUIESCENCE_UNCONFIRMED'),('successor-job','QUIESCENCE_UNCONFIRMED'),('conflicting-allocation','QUIESCENCE_UNCONFIRMED')]:
   c=cases[name]
   if name=='successor-job':
    insert(f,'runner_remote_jobs',{**scope,'operation_id':uid(),'session_id':c['session'],'job_class':'PREPARATION','plan':{'binding':c['plan']['binding']},'plan_digest':pin,'principal':{'controlled_possible_successor_input':True},'admission_digest':pin,'authority_epoch':i['epoch'],'reservation_id':c['reservations'][0],'expires_at':past})
   elif name=='conflicting-allocation':
    before=state(c)
    try:insert(f,'resource_job_allocations',{**scope,'id':uid(),'request_id':uid(),'task_id':i['task_a'],'reservation_id':c['reservations'][1],'job_kind':'PREPARATION','slot_id':c['slot'],'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':c['session']})
    except AssertionError as error:assert '23505' in str(error) and 'one_live_job_per_slot' in str(error),str(error)
    else:raise AssertionError('Conflicting active allocation admitted')
    assert state(c)==before;checks.append('conflicting-active-allocation-refused-by-real-PG-slot-fence');continue
   before=state(c);r=finish(c);assert r.get('error',{}).get('code')==code,(name,r);assert state(c)==before,(name,'changed retained allocation/counter state');checks.append(name+'-refuses-atomically')
  print(json.dumps({'status':'PASS','scope':'ACTUAL_PG_TRUSTED_SCHEDULER_CLEANUP_WITH_EXPLICIT_SIGNED_TERMINAL_INPUT','checks':checks,'ready_install_transition':'NOT_EXERCISED','native_execution':'NOT_CLAIMED','public_delivery_collect':'NOT_EXERCISED'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
