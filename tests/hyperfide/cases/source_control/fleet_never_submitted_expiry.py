#!/usr/bin/env python3
"""Actual signed PostgreSQL lifecycle; prerequisite metadata is isolated fixture state."""
import importlib.util,json,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('provider_intent_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def main():
 f=m.pools.ProvisionerFixture(extra_components=['8.2','8.3'],extra_setup=m.prepare_provider_intent_fixture)
 results=[]
 try:
  def invoke(action,value=None,key='operator',component='8.3'):
   return f.invoke(action,value or {},component=component,key=key)[1]
  def ok(action,value=None,**kwargs):
   response=invoke(action,value,**kwargs);assert response.get('ok'),response;return response['result']
  ok('provider.worker.stop',key='provisioner')
  ok('provider.pools.configure',component='8.2');m.seed_provider_capacity(f)
  request={'run_id':f.ids['run'],'pool_id':f.pool,'sandbox_id':str(uuid.uuid4()),'request_key':str(uuid.uuid4()),'deadline_at':m.utc(12000),'reservation_ids':f.reservations,'profile_id':f.profile,'preparation_digest':f.preparation,'purpose':'PREPARATION'}
  intent=ok('provider.intents.prepare-create',request)['intent'];iid=intent['id'];org=f.ids['organisation']
  def accounting():
   return f.sql('SELECT a.id,a.reserved::text,a.allocated::text,r.id AS reservation_id,r.state,r.release_reason FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.id=ANY($1::uuid[]) ORDER BY r.id',[f.reservations])
  held=accounting()
  live=ok('provider.intents.reconcile',{'intent_id':iid},key='provisioner');assert live['external_call_performed'] is False and accounting()==held;results.append('unexpired recorded intent retains exact capacity')
  while time.time()<__import__('datetime').datetime.fromisoformat(request['deadline_at'].replace('Z','+00:00')).timestamp()+.1:time.sleep(.1)
  def refused(label):
   response=invoke('provider.intents.reconcile',{'intent_id':iid},key='provisioner');assert response.get('ok') is False,response;assert accounting()==held,(label,held,accounting());results.append(label)
  f.sql("UPDATE hyperfide.provisioning_intents SET state='SUBMITTING',state_version=state_version+1 WHERE id=$1",[iid])
  refused('submitted delivery state retains capacity without registered adapter')
  f.sql("UPDATE hyperfide.provisioning_intents SET state='RECORDED',native_sandbox_id='FIXTURE_POSSIBLE_NATIVE',state_version=state_version+1 WHERE id=$1",[iid])
  refused('recorded native identity refuses never-submitted release')
  f.sql('UPDATE hyperfide.provisioning_intents SET native_sandbox_id=NULL,state_version=state_version+1 WHERE id=$1',[iid])
  released=ok('provider.intents.reconcile',{'intent_id':iid},key='provisioner')
  assert released['never_submitted_expired'] is True and released['external_call_performed'] is False and released['absence_authorized'] is False,released
  assert released['intent']['state']=='REJECTED' and released['intent']['failure_code']=='NEVER_SUBMITTED_EXPIRED',released
  rows=accounting();assert all(row['state']=='RELEASED' and row['release_reason']=='NEVER_SUBMITTED_EXPIRED' and row['reserved']=='0' and row['allocated']=='0' for row in rows),rows
  assert len(released['release']['released_reservation_ids'])==len(f.reservations),released
  results.append('expired never-submitted intent releases exact linked reservation vector and accounting')
  replay=ok('provider.intents.reconcile',{'intent_id':iid},key='provisioner');assert replay['intent']['state']=='REJECTED' and replay['external_call_performed'] is False and accounting()==rows,replay
  results.append('terminal reconciliation replay preserves released accounting')
  f.reservations=[];m.seed_provider_capacity(f)
  request.update(sandbox_id=str(uuid.uuid4()),request_key=str(uuid.uuid4()),deadline_at=m.utc(2000),reservation_ids=f.reservations)
  intent=ok('provider.intents.prepare-create',request)['intent'];iid=intent['id'];held=accounting()
  while time.time()<__import__('datetime').datetime.fromisoformat(request['deadline_at'].replace('Z','+00:00')).timestamp()+.1:time.sleep(.1)
  observation=str(uuid.uuid4())
  f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3::uuid,$3::uuid::text,$4,'{}',clock_timestamp(),$4)",[org,observation,iid,intent['payload_digest']])
  refused('recorded observation refuses never-submitted release')
  print(json.dumps({'status':'PASS','assertions':results,'scope':'isolated actual PostgreSQL signed provider API','provider_readiness':'NOT_CLAIMED'}))
 finally:f.close()
if __name__=='__main__':main()
