#!/usr/bin/env python3
"""Repeated NOT_STARTED authority/lineage; the intervening never-run job is controlled input."""
import copy,importlib.util,json,os,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
s=importlib.util.spec_from_file_location('not_started_mixed_helpers',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started_mixed.py');mixed=importlib.util.module_from_spec(s);s.loader.exec_module(mixed)
base=mixed.base;uid=base.uid;digest=base.digest;insert=base.insert
Original=base.a.AssignmentFixture
class RepeatedFixture(Original):
 def __init__(self,*args,**kwargs):self.last=None;super().__init__(*args,**kwargs)
 def invoke(self,action,value,*args,**kwargs):
  result=super().invoke(action,value,*args,**kwargs)
  if action=='fleet.install.admit' and result[1].get('ok'):self.last=(value['decision'],result[1]['result']['admission'])
  return result
 def close(self):
  try:
   if self.last:extension(self)
  finally:super().close()
def extension(f):
 i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}
 observed=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},key='manager',component='fleet-orchestration');eligible=[r for r in observed['install_recovery_jobs'] if r['not_started_recovery']['eligibility']=='ELIGIBLE_FOR_AUTHORITY_RECHECK'];assert len(eligible)==1,eligible
 candidate=eligible[0];old=f.sql('SELECT * FROM hyperfide.fleet_environment_installs WHERE operation_id=$1',[candidate['install_operation_id']])[0];root=old['operation_id'];value={k:old[k] for k in ['input_digest','environment_id','environment_generation','sandbox_id','boot_id']};value.update(environment_generation=int(old['environment_generation']),boot_generation=str(old['boot_generation']),ttl_seconds=3,slot_bindings=[{k:b[k] for k in ['slot','worker_slot_id']} for b in old['admission']['slot_bindings']],recovery_of=candidate['not_started_recovery']['recovery_of']);_,answer=mixed.admit(f,value);assert answer.get('ok'),answer;n=answer['result']['admission']
 oldjob=f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[root])[0];oldallocation=f.sql('SELECT * FROM hyperfide.resource_job_allocations WHERE id=$1',[oldjob['plan']['allocation']['allocation_id']])[0];session=oldjob['session_id'];request,allocation,waiter,selected=[uid() for _ in range(4)];pin=digest({'declared_never_run_allocation_input':n['operation_id']});task=f.sql('SELECT spec_revision_id::text,spec_generation::text,criteria_digest FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]
 insert(f,'resource_waiters',{**scope,'id':waiter,'request_id':request,'pool_id':i['pool'],'owner_session_id':i['manager'],'task_id':i['task_a'],'spec_revision_id':task['spec_revision_id'],'spec_generation':int(task['spec_generation']),'criteria_digest':task['criteria_digest'],'resource_policy_digest':pin,'job_kind':'PREPARATION','priority':0,'state':'ADMITTED','admitted_at':'2026-01-01T00:00:01Z','enqueued_at':'2026-01-01T00:00:00Z','deadline_at':n['expires_at']})
 ids=[]
 for dimension in ['PREPARATION','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']:
  ident=selected if dimension=='PREPARATION' else uid();ids.append(ident);insert(f,'reservations',{**scope,'id':ident,'request_id':request,'capacity_account_id':f.accounts[dimension],'quantity':'1','expires_at':n['expires_at'],'state':'ALLOCATED'});f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,state_version=state_version+1 WHERE id=$1',[f.accounts[dimension]])
 f.sql("UPDATE hyperfide.worker_slots SET state='ALLOCATED',state_version=state_version+1 WHERE id=$1",[oldallocation['slot_id']])
 insert(f,'resource_job_allocations',{**scope,'id':allocation,'request_id':request,'task_id':i['task_a'],'reservation_id':selected,'job_kind':'PREPARATION','slot_id':oldallocation['slot_id'],'sandbox_id':i['sandbox'],'sandbox_boot_generation':1,'assignee_session_id':session})
 plan={'operation_id':n['operation_id'],'binding':copy.deepcopy(oldjob['plan']['binding']),'allocation':{'allocation_id':allocation,'request_id':request,'generation':'1'},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':n['operation_id'],'input_packet_digest':n['admission_digest']}}};plan_digest=digest(plan);insert(f,'runner_remote_jobs',{**scope,'operation_id':n['operation_id'],'session_id':session,'job_class':'PREPARATION','plan':plan,'plan_digest':plan_digest,'principal':{'controlled_never_run_admission_input':True},'admission_digest':n['admission_digest'],'authority_epoch':i['epoch'],'reservation_id':selected,'expires_at':n['expires_at']})
 deadline=time.monotonic()+10
 while not f.sql('SELECT expires_at<=clock_timestamp() AS expired FROM hyperfide.fleet_environment_installs WHERE operation_id=$1',[n['operation_id']])[0]['expired']:
  assert time.monotonic()<deadline;time.sleep(.1)
 next_value=copy.deepcopy(value);next_value.update(ttl_seconds=300,recovery_of={'kind':'NOT_STARTED','install_operation_id':n['operation_id'],'admission_digest':n['admission_digest'],'runner_operation_id':n['operation_id'],'runner_plan_digest':plan_digest});decision,answer=mixed.admit(f,next_value);assert answer.get('ok'),answer;p=answer['result']['admission'];assert p['logical_operation_id']==p['operation_id'] and 'recovery_of' not in p
 mixed.lineage(f,p,root,p['operation_id'],False)
 job=f.sql('SELECT state,expires_at::text,result,result_digest,result_signature,claim_id,executor_credential_id,not_started_proof_id::text FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[n['operation_id']])[0];assert job['state']=='ADMITTED' and job['not_started_proof_id'] and all(job[k] is None for k in ['result','result_digest','result_signature','claim_id','executor_credential_id']),job
 assert all(r['state']=='RELEASED' and r['release_reason']=='RUNNER_NOT_STARTED' for r in f.sql('SELECT state,release_reason FROM hyperfide.reservations WHERE request_id=$1',[request]))
 print(json.dumps({'status':'PASS','scope':'actual signed repeated NOT_STARTED admissions and production lineage after real DB expiry; intervening unclaimed allocation/job are declared inputs, no native execution','global_root':root,'new_native_epoch':p['operation_id'],'intermediate_job_unchanged':True,'logical_vector_released':True}),flush=True)
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 base.a.AssignmentFixture=RepeatedFixture
 return base.main()
if __name__=='__main__':raise SystemExit(main())
