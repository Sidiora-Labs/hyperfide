#!/usr/bin/env python3
"""Signed recovery/actual PG allocation epoch; prior FAILED/native artifact metadata is explicit input."""
import concurrent.futures,copy,importlib.util,json,os,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('expired_failed_target',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started_delivery.py');target=importlib.util.module_from_spec(s);s.loader.exec_module(target)
ms=importlib.util.spec_from_file_location('expired_failed_mixed',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started_mixed.py');mixed=importlib.util.module_from_spec(ms);ms.loader.exec_module(mixed)
base=target.base;uid,sha,digest,insert=base.uid,base.sha,base.digest,base.insert
original=target.extension
class ExpiringTargetFixture(target.DeliveryFixture):
 def sql(self,statement,values=(),*args,**kwargs):
  if statement.startswith('INSERT INTO hyperfide.fleet_delegations('):
   columns=statement.split('(',1)[1].split(')',1)[0].split(',');values=list(values);at=columns.index('budget');budget=json.loads(values[at]);budget['allowed_actions']=list(dict.fromkeys([*budget['allowed_actions'],'fleet.install.adopt']));values[at]=json.dumps(budget)
  return super().sql(statement,values,*args,**kwargs)
 def invoke(self,action,value,*args,**kwargs):
  if action=='fleet.install.delivery.collect':
   operation=value['operation_id'];existing=self.sql('SELECT operation_id FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[operation])
   if not existing:
    response=super().invoke('fleet.install.delivery.schedule',value,*args,**kwargs)[1]
    assert self.sql('SELECT operation_id FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[operation]),response
    assert not self.sql('SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[operation]),'Metadata fixture unexpectedly scheduled native execution'
    print(json.dumps({'phase':'actual_schedule_materialized_target','schedule_ok':response.get('ok'),'error_code':response.get('error',{}).get('code'),'native_job_created':False}),flush=True)
  if action=='fleet.install.delivery.prepare.allocate':value={**value,'deadline_ms':30000}
  return super().invoke(action,value,*args,**kwargs)


def refuse_unknown_adoption(f,n,claimed_digest):
 i=f.ids;common=[i['organisation'],i['run']];scope={'organisation_id':i['organisation'],'run_id':i['run']};cohort=f.sql('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]
 f.ok('fleet.cohort.bind',{'cohort_id':cohort['id'],'host_id':__import__('socket').gethostname(),'leader_generation':'1','expected_generation':cohort['cohort_generation']},component='fleet-orchestration')
 binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'};f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
 operation,decision,observation,reason=[uid() for _ in range(4)];owner=f.sql('SELECT a.plan_generation::text,c.cohort_generation::text FROM hyperfide.fleet_actor_sessions a JOIN hyperfide.fleet_cohorts c ON c.id=a.cohort_id WHERE a.session_id=$1',[i['manager']])[0]
 value={'install_operation_id':n['operation_id'],'previous_adoption_id':None,'admission_digest':n['admission_digest'],'receipt_digest':None,'input_digest':n['input_digest'],'handoff_id':None,'runner_operation_id':n['operation_id'],'runner_result_digest':claimed_digest};context=sha(operation.encode());body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':context,'action':'fleet.install.adopt','input':value,'input_digest':digest(value),'expected_version':owner['plan_generation'],'rationale_summary':'Declared component decision input to test UNKNOWN refusal, not model inference'}
 insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(owner['cohort_generation']),'context_digest':context,'body':{'controlled_fixture_input':True}});insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':i['manager'],'request_digest':context,'observation_id':observation,'state':'COMPLETED','result':{'controlled_fixture_input':True}});insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':'fleet.install.adopt','context_digest':context,'payload_digest':digest(body),'reasoning_id':reason,'body':body})
 before={table:f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.'+table+' t WHERE organisation_id=$1 AND run_id=$2',common) for table in ['fleet_install_adoptions','fleet_effect_receipts','fleet_environment_installs']};answer=f.invoke('fleet.install.adopt',{'decision':body},key='manager',component='fleet-install')[1];assert answer.get('error',{}).get('code')=='FLEET_INSTALL_RECONCILIATION_REQUIRED',answer
 assert {table:f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.'+table+' t WHERE organisation_id=$1 AND run_id=$2',common) for table in before}==before,'UNKNOWN adoption changed retained authority'
 print(json.dumps({'status':'PASS','scope':'actual signed UNKNOWN adoption refusal after real fixture cohort change, no new adoption/effect/install'}),flush=True)

def extension(f,decision,n):
 original(f,decision,n)
 i=f.ids;common=[i['organisation'],i['run']];scope={'organisation_id':i['organisation'],'run_id':i['run']}
 aux=f.sql('SELECT * FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[n['operation_id']])[0];b=aux['target_binding'];allocation=f.sql('SELECT * FROM hyperfide.resource_job_allocations WHERE id=$1',[b['allocation_id']])[0];expires=f.sql('SELECT expires_at::text FROM hyperfide.reservations WHERE id=$1',[b['reservation_id']])[0]['expires_at']
 plan={'operation_id':n['operation_id'],'binding':{'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','session_id':b['session_id'],'slot_id':b['slot_id'],'slot_generation':f.sql('SELECT slot_generation::text FROM hyperfide.runner_registry WHERE session_id=$1',[b['session_id']])[0]['slot_generation']},'allocation':{'allocation_id':allocation['id'],'request_id':allocation['request_id'],'generation':str(allocation['generation'])},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':n['operation_id'],'input_packet_digest':n['admission_digest']}}};pd=digest(plan);quiescence=sha(b'CONTROLLED_HISTORICAL_FAILED_NATIVE_RECEIPT_INPUT');result={**scope,'operation_id':n['operation_id'],'session_id':b['session_id'],'fixture':'CONTROLLED_HISTORICAL_FAILED_INPUT_NOT_NATIVE_QUALIFICATION','outcome':'FAILED','cleanup_status':'CONFIRMED','cleanup':{'complete':True,'observed_process_absent':True,'receipt_digest':quiescence},'native_receipt':{'digest':quiescence}};rd=digest(result)
 signature=f.sign('provisioner',('HYPERFIDE-RUNNER-RESULT-V1\n'+i['organisation']+'\n'+i['run']+'\n'+n['operation_id']+'\n'+pd+'\n'+rd+'\n').encode())
 insert(f,'runner_remote_jobs',{**scope,'operation_id':n['operation_id'],'session_id':b['session_id'],'job_class':'PREPARATION','plan':plan,'plan_digest':pd,'principal':{'controlled_signed_failed_history_input':True},'admission_digest':n['admission_digest'],'authority_epoch':i['epoch'],'reservation_id':b['reservation_id'],'expires_at':expires})
 f.sql("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp(),native_claimed_at=clock_timestamp(),native_claim_operation_id=$4 WHERE operation_id=$1",[n['operation_id'],uid(),i['provisioner'],uid()]);f.sql("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[n['operation_id']]);refuse_unknown_adoption(f,n,rd);f.sql("UPDATE hyperfide.runner_remote_jobs SET state='COMPLETED',result=$2,result_digest=$3,result_signature=$4,completed_at=clock_timestamp() WHERE operation_id=$1",[n['operation_id'],json.dumps(result),rd,signature])
 artifact=uid();insert(f,'artifacts',{**scope,'id':artifact,'digest':quiescence,'size_bytes':0,'storage_backend':'CONTROLLED_HISTORICAL_METADATA_ONLY','storage_key':artifact,'status':'COMPLETE'});insert(f,'runner_result_artifacts',{**scope,'operation_id':n['operation_id'],'role':'native_receipt','artifact_id':artifact,'artifact_digest':quiescence,'content_digest':quiescence,'size_bytes':0})
 old=f.sql('SELECT * FROM hyperfide.fleet_environment_installs WHERE operation_id=$1',[n['operation_id']])[0];job=f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[n['operation_id']])[0]
 recovery={'install_operation_id':n['operation_id'],'admission_digest':n['admission_digest'],'runner_operation_id':n['operation_id'],'runner_plan_digest':pd,'quiescence_operation_id':n['operation_id'],'quiescence_receipt_digest':quiescence}
 deadline=time.monotonic()+40
 while not f.sql('SELECT bool_and(expires_at<=clock_timestamp()) AS expired FROM hyperfide.reservations WHERE request_id=$1',[b['request_id']])[0]['expired']:
  assert time.monotonic()<deadline,'Actual original logical lease did not expire';time.sleep(.1)
 def state():
  return {name:f.sql(sql,values) for name,sql,values in [('job','SELECT to_jsonb(j) AS row FROM hyperfide.runner_remote_jobs j WHERE operation_id=$1',[n['operation_id']]),('allocation','SELECT to_jsonb(a) AS row FROM hyperfide.resource_job_allocations a WHERE id=$1',[allocation['id']]),('session','SELECT to_jsonb(s) AS row FROM hyperfide.agent_sessions s WHERE id=$1',[b['session_id']]),('registry','SELECT to_jsonb(r) AS row FROM hyperfide.runner_registry r WHERE session_id=$1',[b['session_id']]),('reservations','SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE request_id=$1 ORDER BY id',[b['request_id']]),('heads','SELECT to_jsonb(h) AS row FROM hyperfide.fleet_install_heads h WHERE current_operation_id=$1',[n['operation_id']]),('accounts','SELECT id::text,allocated::text,reserved::text,state_version::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])]}
 principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['credential_id']==i['operator'])
 probe=r"""
const {authenticatedInvocation}=await import('./core/control-plane/dist/transport/protocol.js');const {closeExpiredFailedInstallAllocation}=await import('./core/control-plane/dist/preparation/fleet_failed_allocation.js');const {runnerCanonical}=await import('./core/control-plane/dist/runner/bridge.js');const {hash}=await import('./core/control-plane/dist/transport/protocol.js');
const i=authenticatedInvocation({principal:data.principal,signal:new AbortController().signal,guard:async()=>{}});let binding={...data.binding},install={...data.install},job={...data.job};
if(data.mode==='wrong-proof')binding.quiescence_receipt_digest='sha256:'+'0'.repeat(64);
if(data.mode==='wrong-boot')install.boot_id=data.fresh_id;
if(data.mode==='new-job'||data.mode==='unknown'){
 const plan={...job.plan,operation_id:data.fresh_id,preparation_request:{job_binding:{namespace:'FLEET_INSTALL',job_id:data.fresh_id}}},pd=hash(runnerCanonical(plan));
 await tx.query(`INSERT INTO hyperfide.runner_remote_jobs(organisation_id,run_id,operation_id,session_id,job_class,plan,plan_digest,principal,admission_digest,authority_epoch,reservation_id,expires_at) VALUES($1,$2,$3,$4,'PREPARATION',$5,$6,$7,$8,$9,$10,$11)`,[data.scope.organisation_id,data.scope.run_id,data.fresh_id,job.session_id,plan,pd,{controlled_possible_job_input:true},job.admission_digest,job.authority_epoch,job.reservation_id,job.expires_at]);
 if(data.mode==='unknown'){await tx.query("UPDATE hyperfide.runner_remote_jobs SET state='CLAIMED',claim_id=$2,executor_credential_id=$3,claimed_at=clock_timestamp() WHERE operation_id=$1",[data.fresh_id,data.fresh_claim,job.executor_credential_id]);await tx.query("UPDATE hyperfide.runner_remote_jobs SET state='UNKNOWN' WHERE operation_id=$1",[data.fresh_id]);job=(await tx.query('SELECT * FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[data.fresh_id])).rows[0];binding.runner_operation_id=data.fresh_id;binding.runner_plan_digest=pd;}
}
return closeExpiredFailedInstallAllocation(tx,i,binding,install,job);
"""
 checks=[]
 for mode in ['wrong-proof','wrong-boot','unknown','new-job']:
  before=state();answer=f.primary(probe,{'principal':principal,'binding':recovery,'install':old,'job':job,'mode':mode,'fresh_id':uid(),'fresh_claim':uid()});assert answer.get('error',{}).get('code')=='FLEET_INSTALL_RECOVERY_ALLOCATION',(mode,answer);assert state()==before,(mode,'refusal changed retained capacity or identity');checks.append(mode+'-refuses-atomically')
 before=state();value=copy.deepcopy(decision['input']);value.update(recovery_of=recovery,ttl_seconds=300);new_decision=mixed.record(f,value)
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  calls=[pool.submit(lambda:f.invoke('fleet.install.admit',{'decision':new_decision},key='manager',component='fleet-install')[1]) for _ in range(2)];answers=[c.result(timeout=30) for c in calls]
 assert all(a.get('ok') for a in answers) and sum(a['result'].get('replayed') is True for a in answers)==1,answers
 answer=next(a for a in answers if a['result'].get('replayed') is not True);successor=answer['result']['admission'];checks.append('concurrent-identical-signed-manager-admission-serializes-with-one-replay');edge=f.sql('SELECT * FROM hyperfide.fleet_install_recoveries WHERE operation_id=$1',[successor['operation_id']])[0]
 assert edge['allocation_epoch_operation_id']==successor['operation_id'] and successor['recovery_of']==recovery and successor['logical_operation_id']==n['logical_operation_id'],(edge,successor)
 after=state();assert before['job']==after['job'] and before['session']==after['session'] and before['registry']==after['registry'],'Recovery rewrote original process history'
 assert f.sql('SELECT state FROM hyperfide.resource_job_allocations WHERE id=$1',[allocation['id']])[0]['state']=='RELEASED'
 assert all(r['state']=='RELEASED' for r in f.sql('SELECT state FROM hyperfide.reservations WHERE request_id=$1',[b['request_id']]))
 counts=after['accounts'];replay=f.invoke('fleet.install.admit',{'decision':new_decision},key='manager',component='fleet-install')[1];assert replay.get('ok') and replay['result'].get('replayed') is True,replay;assert f.sql('SELECT id::text,allocated::text,reserved::text,state_version::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 ORDER BY id',[i['organisation']])==counts
 checks += ['signed-manager-FAILED-recovery-closes-only-expired-logical-vector','native-original-logical-and-recovery-ledger-preserved','fresh-allocation-epoch-recorded','exact-decision-replay-no-double-release']
 pending=f.ok('fleet.install.delivery.pending',{'after':None,'limit':100},component='fleet-install-delivery',key='operator');commands=[c for c in pending['bootstrap_commands'] if c['action']=='fleet.install.delivery.prepare.allocate' and c['input']['sandbox_id']==i['sandbox']];assert len(commands)==1,pending;command=commands[0];assert command['input']['request_id']!=b['request_id']
 admitted=f.ok(command['action'],command['input'],component='fleet-install-delivery',key='operator');fresh=admitted['allocation'];assert fresh['allocation_id']!=allocation['id'] and fresh['reservation_id']!=b['reservation_id'],fresh
 response=f.ok('fleet.install.delivery.collect',{'operation_id':successor['operation_id']},key='operator',component='fleet-install-delivery');assert response['state']=='PENDING',response
 delivery=f.sql('SELECT target_binding FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[successor['operation_id']])[0]['target_binding'];assert delivery['allocation_id']==fresh['allocation_id'] and delivery['request_id']==command['input']['request_id'] and delivery['allocation_id']!=allocation['id'];checks.append('actual-signed-new-PREP-allocation-and-delivery-target-use-fresh-resource-epoch')
 print(json.dumps({'status':'PASS','scope':'ACTUAL_PG_SIGNED_FAILED_RECOVERY_ADMISSION_ALLOCATION_AND_DELIVERY_WITH_DECLARED_HISTORICAL_FAILED_INPUT','checks':checks,'native_execution':'NOT_CLAIMED','READY':'NOT_CLAIMED'}),flush=True)

def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 target.DeliveryFixture=ExpiringTargetFixture;target.extension=extension
 return target.main()
if __name__=='__main__':raise SystemExit(main())
