#!/usr/bin/env python3
"""Real signed worker lifecycle across durable stop, restart, renewal and revocation."""
import importlib.util,json,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('renewal_provider_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def fixture():
 def setup(f):
  m.prepare_provider_intent_fixture(f)
  f.sql("UPDATE hyperfide.identity_principals SET expires_at=clock_timestamp()+interval '120 seconds' WHERE credential_id=$1",[f.ids['provisioner']])
 return m.pools.ProvisionerFixture(extra_components=['8.2','8.3'],extra_setup=setup)
def main():
 results=[]
 def invoke(f,action,value=None,key='operator',component='8.3'):
  response=f.invoke(action,value or {},component=component,key=key)[1];assert response.get('ok'),response;return response['result']
 def status(f):return invoke(f,'provider.worker.status')
 def wait(f,predicate):
  deadline=time.monotonic()+8;last=None
  while time.monotonic()<deadline:
   last=status(f)
   if predicate(last):return last
   time.sleep(.1)
  raise AssertionError(json.dumps(last))
 f=fixture()
 try:
  wait(f,lambda row:row['running'])
  halted=invoke(f,'provider.worker.stop',key='provisioner');assert halted['running'] is False and halted['durable']['state']=='STOPPED',halted
  stopped_durable=halted['durable'];f.stop();f.start();time.sleep(.5)
  boot_stopped=status(f);assert boot_stopped['running'] is False and boot_stopped['durable']==stopped_durable and boot_stopped['last_tick_at'] is None and boot_stopped['counters']=={'claimed':0,'executed':0,'reconciled':0,'failed':0},boot_stopped
  results.append('actual service boot preserves durable STOPPED state and counters without starting provider work')
  restarted=invoke(f,'provider.worker.start',key='provisioner');assert restarted['running'] is True and restarted['durable']['state']=='STARTED' and restarted['durable']['owner_credential_id']==stopped_durable['owner_credential_id'] and int(restarted['durable']['start_count'])==int(stopped_durable['start_count'])+1 and restarted['durable']['resume_count']==stopped_durable['resume_count'],restarted
  results.append('explicit signed start restarts a durably stopped worker exactly once')
  started_durable=restarted['durable'];f.stop();f.start()
  resumed=wait(f,lambda row:row['running'] and row['last_tick_at'] is not None);assert resumed['durable']['state']=='STARTED' and resumed['durable']['owner_credential_id']==started_durable['owner_credential_id'] and resumed['durable']['start_count']==started_durable['start_count'] and resumed['durable']['started_at']==started_durable['started_at'] and int(resumed['durable']['resume_count'])==int(started_durable['resume_count'])+1,resumed
  results.append('actual service restart resumes STARTED ownership without recording another start')
  before=resumed;durable=before['durable']
  renewed=invoke(f,'identity.principal.renew',{'ttl_seconds':300},key='provisioner',component='14.1');assert renewed['credential_id']==f.ids['provisioner'] and renewed['credential_version']=='2',renewed
  time.sleep(.7)
  after=wait(f,lambda row:row['running'] and row['last_tick_at']!=before['last_tick_at'] and row['stopped_reason'] is None and not any(str(code).startswith('AUTH_') for code in row['errors'].values()))
  assert after['durable']==durable,(before,after);assert after['owner_credential_id']==f.ids['provisioner'];results.append('official same-key renewal continues polling without changing durable worker start or owner')
  f.sql("UPDATE hyperfide.identity_principals SET allowed_actions=array_remove(allowed_actions,'provider.intents.execute'),credential_version=credential_version+1,expires_at=clock_timestamp()+interval '600 seconds' WHERE credential_id=$1",[f.ids['provisioner']])
  stopped=wait(f,lambda row:not row['running']);assert stopped['stopped_reason'] is not None,stopped;assert stopped['durable']==durable;results.append('capability narrowing stops authority instead of refreshing the wider worker snapshot')
 finally:f.close()
 f=fixture()
 try:
  before=wait(f,lambda row:row['running']);version=f.sql('SELECT credential_version::text FROM hyperfide.identity_principals WHERE credential_id=$1',[f.ids['provisioner']])[0]['credential_version']
  revoked=invoke(f,'identity.principal.revoke',{'credential_id':f.ids['provisioner'],'expected_version':version},component='14.1');assert revoked['revoked'] is True
  stopped=wait(f,lambda row:not row['running']);assert stopped['stopped_reason'] is not None and stopped['durable']==before['durable'],stopped;results.append('official revocation stops the worker and preserves retained ownership history')
 finally:f.close()
 print(json.dumps({'status':'PASS','assertions':results,'scope':'actual PostgreSQL and signed HTTPS worker lifecycle'}))
if __name__=='__main__':main()
