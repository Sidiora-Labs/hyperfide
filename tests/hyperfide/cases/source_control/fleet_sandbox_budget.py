#!/usr/bin/env python3
"""Actual scoped fleet observations; controlled sandbox history, real held capacity, no provider claim."""
import importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
s=importlib.util.spec_from_file_location('sandbox_budget_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');selected=importlib.util.module_from_spec(s);s.loader.exec_module(selected)
from identity_fixture import uid
Original=selected.AssignmentFixture
class BudgetFixture(Original):
 completed=0
 def __init__(self,*args,**kwargs):self.assigned=False;super().__init__(*args,**kwargs)
 def invoke(self,action,value,*args,**kwargs):
  result=super().invoke(action,value,*args,**kwargs)
  if action=='fleet.decision.apply' and value.get('decision',{}).get('action')=='ASSIGN_WORKER' and result[1].get('ok'):self.assigned=True
  return result
 def close(self):
  try:
   if self.assigned:check_budget(self);BudgetFixture.completed+=1
  finally:super().close()
def check_budget(f):
 i=f.ids;common=[i['organisation'],i['run']]
 held=f.primary("const {reserveDynamic}=await import('./core/control-plane/dist/scheduler/resources.js');const r=await reserveDynamic(tx,{...data.scope,request_id:data.request,pool_id:data.pool,dimensions:data.dimensions,expires_at:'2099-01-01T00:00:00.000Z'});const ids=r.reservations.map(x=>x.id);await claims.allocateReservations(tx,{...data.scope,reservation_ids:ids});await tx.query(\"UPDATE hyperfide.reservations SET state='RELEASE_PENDING',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=ANY($3::uuid[])\",[data.scope.organisation_id,data.scope.run_id,ids]);return ids;",{'request':uid(),'pool':i['pool'],'dimensions':[{'capacity_account_id':f.physical_accounts[k],'quantity':'1'} for k in ['SANDBOX','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES']]})
 assert 'result' in held,held
 def physical():return f.sql("SELECT r.id::text,r.state,r.quantity::text,c.id::text AS capacity_account_id,c.allocated::text FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts c ON c.organisation_id=r.organisation_id AND c.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.id=ANY($3::uuid[]) ORDER BY r.id",common+[held['result']])
 before=physical();assert len(before)==4 and all(r['state']=='RELEASE_PENDING' and int(r['allocated'])>=1 for r in before),before
 binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}
 def observe():
  body=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},key='manager',component='fleet-orchestration')
  return next(d['sandbox_budget'] for d in body['delegations'] if d['package_id']==i['package'])
 occupied=observe();assert occupied['occupied']==1 and occupied['remaining']==0,occupied
 f.sql("UPDATE hyperfide.sandboxes SET observed_state='DESTROYED',desired_state='DESTROYED',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",[i['organisation'],i['sandbox']])
 empty=observe();assert empty['maximum']==1 and empty['occupied']==0 and empty['remaining']==1 and empty['occupied_samples']==[],empty
 assert empty['scope']=='DELEGATION_ALL_POOLS' and empty['physical_reservation_holds_counted'] is False and empty['provider_capacity_checked_separately'] is True and empty['admission_authority'] is False,empty
 assert physical()==before,'Observation or logical terminal history released physical holds'
 print(json.dumps({'status':'PASS','scope':'actual PostgreSQL/TLS observation and physical reservation accounting; controlled historical sandbox state, no provider execution','assertions':['current owned sandbox occupies logical maximum','DESTROYED ownership history yields occupied zero and remaining one','four physical RELEASE_PENDING holds remain allocated unchanged','projection labels independent physical admission and grants no authority']}))
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 selected.AssignmentFixture=BudgetFixture;code=selected.main();assert BudgetFixture.completed==1,'Scoped occupancy observation gate did not execute';return code
if __name__=='__main__':raise SystemExit(main())
