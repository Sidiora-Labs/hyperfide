#!/usr/bin/env python3
"""Actual native cleanup and signed PG workspace release; registration rows are controlled prerequisites."""
import importlib.util,json,os,signal,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('native_cleanup_owner',ROOT/'tests/hyperfide/cases/tasks/12_4.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 c=m.Control();f=c.f;n=c.n;i=f.ids;org=i['organisation'];run=i['run'];checks=[]
 try:
  n.configure(c.transport);package=m.uid();pin=m.sha(b'controlled immutable cleanup registration only')
  f.sql('INSERT INTO hyperfide.run_spec_revisions(organisation_id,run_id,spec_generation,spec_revision_id) VALUES($1,$2,1,$3) ON CONFLICT DO NOTHING',[org,run,i['spec']])
  f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'cleanup-registration',1)",[org,run,package])
  f.sql("INSERT INTO hyperfide.agent_admission_accounts(organisation_id,run_id,quota_key,policy_digest,max_concurrent) VALUES($1,$2,'cleanup-registration',$3,10)",[org,run,pin])
  def register(launch):
   task,dispatch,event,admission=[m.uid() for _ in range(4)];session=launch['identity']['agent_session_id'];slot=launch['slot_id'];attempt=launch['attempt_id']
   f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$2::uuid::text,1,'AGENT','READY')",[org,slot,i['sandbox']])
   f.sql("INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$3::uuid::text,$4,$5,$6,'{}',1)",[org,run,task,package,i['spec'],pin])
   f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation,lease_expires_at) VALUES($1,$2,$3,$4,1,$5,$6,'RUNNING','RELEASED',$7,$8,1,clock_timestamp()+interval '10 minutes')",[org,run,attempt,task,i['epoch'],pin,i['sandbox'],slot])
   f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) VALUES($1,$2,$3,'WORKER','claude','fixture',$3::uuid::text,$4,$5,1,$6,'REGISTERED')",[org,run,session,slot,i['sandbox'],attempt])
   f.sql("INSERT INTO hyperfide.agent_admission_reservations(organisation_id,run_id,id,quota_key,session_id,payload_digest,policy_digest,state) VALUES($1,$2,$3,'cleanup-registration',$4,$5,$5,'RESERVED')",[org,run,admission,session,pin])
   f.sql("INSERT INTO hyperfide.outbox_events(organisation_id,run_id,id,aggregate_type,aggregate_id,aggregate_version,event_type,payload) VALUES($1,$2,$3,'cleanup.fixture',$4,1,'cleanup.fixture','{}')",[org,run,event,attempt])
   f.sql("INSERT INTO hyperfide.scheduler_dispatches(organisation_id,run_id,id,request_id,task_id,attempt_id,attempt_generation,authority_epoch,sandbox_id,slot_id,sandbox_boot_generation,payload_digest,state,event_id) VALUES($1,$2,$3,$3,$4,$5,1,$6,$7,$8,1,$9,'RUNNING',$10)",[org,run,dispatch,task,attempt,i['epoch'],i['sandbox'],slot,pin,event])
   f.sql("INSERT INTO hyperfide.native_launch_plans(organisation_id,run_id,command_id,launch_id,agent_session_id,slot_id,attempt_id,attempt_generation,connector,connector_plan_digest,admission_reservation_id,reservation_attempt,admission_policy_digest,run_policy_digest,qualification_receipt_digest,packet_digest,payload_digest,plan) VALUES($1,$2,$3,$4,$5,$6,$7,1,'claude',$8,$9,1,$8,$8,$8,$8,$8,'{}')",[org,run,dispatch,launch['launch_id'],session,slot,attempt,pin,admission])
   return session
  def state(session):return f.sql('SELECT state FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[org,run,session])[0]['state']
  def stop(launch):
   c.ok('runner.workspace.register',{'slot_id':launch['slot_id'],'slot_generation':'1'},key='runner')
   c.ok('runner.workspace.lease',{'sandbox_id':i['sandbox'],'boot_generation':'1','slot_id':launch['slot_id'],'launch_id':launch['launch_id'],'expected_slot_generation':'1'})
   command=c.issue('runner.stop',launch,policy={'grace_ms':100,'drain_deadline_ms':1000,'on_drain_deadline':'REPORT'})['command_id']
   rc,result,code=c.run('runner.stop',launch,command);assert rc==0 and result['termination']=='CONFIRMED' and result['status']=='CONFIRMED_STOPPED',(code,result)
   report=c.inspect(command);assert report['missing_outputs']==[] and len(report['captures'])==2 and all(x['state']=='COMPLETE' and x['manifest_artifact_id'] for x in report['captures']),report
   return command
  def release(launch,command):return n.native('runner.slot.release',{'state_dir':str(n.state),'launch_id':launch['launch_id'],'command_id':command})
  target=n.add_launch(n.add_slot(62161));session=register(target);other=m.uid()
  f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,attempt_id,state) VALUES($1,$2,$3,'WORKER','claude','fixture',$3::uuid::text,$4,$5,1,$6,'RUNNING')",[org,run,other,target['slot_id'],i['sandbox'],target['attempt_id']])
  n.tree(target['uid'],1);command=stop(target)
  f.sql("UPDATE hyperfide.attempts SET compute_authority='RELEASED',state_version=state_version+1 WHERE id=$1",[target['attempt_id']])
  n.spawn(target['uid'],'import time\ntime.sleep(600)');assert n.wait(lambda:bool(m.slots.uid_processes(target['uid'])))
  rc,result,code=release(target,command);assert rc==0 and result['reusable'] is False and result['coordinator_workspace']=='CLEANING' and 'PROCESS_RESIDUE' in result['blocking'],(code,result)
  assert state(session)=='REGISTERED' and state(other)=='RUNNING','Blocked cleanup stopped a live session';checks.append('actual process residue blocks cleanup and retains worker sessions')
  for pid,_ in m.slots.uid_processes(target['uid']):os.kill(pid,signal.SIGKILL)
  assert n.wait(lambda:not m.slots.uid_processes(target['uid']))
  rc,result,code=release(target,command);assert rc==0 and result['reusable'] is True and result['coordinator_workspace']=='FREE' and result['blocking']==[],(code,result)
  assert state(session)=='STOPPED' and state(other)=='RUNNING','Cleanup did not stop only immutable launch-bound worker';checks.append('real signed native cleanup with durable outputs stops only exact immutable launch-bound RELEASED worker')
  current=n.add_launch(n.add_slot(62162));current_session=register(current);n.tree(current['uid'],1);current_command=stop(current)
  f.sql("UPDATE hyperfide.attempts SET compute_authority='CURRENT',lease_expires_at=clock_timestamp()+interval '10 minutes',state_version=state_version+1 WHERE id=$1",[current['attempt_id']])
  rc,result,code=release(current,current_command);assert rc==0 and result['reusable'] is True,(code,result)
  row=f.sql('SELECT compute_authority FROM hyperfide.attempts WHERE id=$1',[current['attempt_id']])[0]
  assert state(current_session)=='REGISTERED' and row['compute_authority']=='CURRENT' and state(other)=='RUNNING','Workspace release altered current compute or other worker';checks.append('current compute authority and its exact mapped worker remain unchanged')
  print(json.dumps({'status':'PASS','scope':'actual PostgreSQL signed native cleanup and durable artifact capture; launch registration and compute-state preconditions controlled','assertions':checks,'provider_live':'UNRUN'}));return 0
 finally:assert c.close(),'Owned native fixture processes remained'
if __name__=='__main__':raise SystemExit(main())
