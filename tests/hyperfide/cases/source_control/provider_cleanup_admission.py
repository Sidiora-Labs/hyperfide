#!/usr/bin/env python3
"""Signed cleanup admission on actual PG; provider observations are negative fixture facts."""
import importlib.util,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('cleanup_provider_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def uid():return str(uuid.uuid4())
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=m.pools.ProvisionerFixture(extra_components=['8.2','8.3','15.2'],extra_setup=m.prepare_provider_intent_fixture)
 try:
  def invoke(action,value=None,key='operator',component='8.3'):
   return f.invoke(action,value or {},component=component,key=key)[1]
  def ok(action,value=None,**kwargs):
   answer=invoke(action,value,**kwargs);assert answer.get('ok'),answer;return answer['result']
  ok('provider.worker.stop',key='provisioner');ok('provider.pools.configure',component='8.2');m.seed_provider_capacity(f)
  org=f.ids['organisation'];run=f.ids['run'];sandbox=uid();native='controlled-owned-unknown-health'
  create=ok('provider.intents.prepare-create',dict(run_id=run,pool_id=f.pool,sandbox_id=sandbox,request_key=uid(),deadline_at=m.utc(120000),reservation_ids=f.reservations,profile_id=f.profile,preparation_digest=f.preparation,purpose='PREPARATION'))['intent']
  f.sql("UPDATE hyperfide.provisioning_intents SET state='ACKNOWLEDGED',native_sandbox_id=$2,state_version=state_version+1 WHERE id=$1",[create['id'],native])
  f.sql("UPDATE hyperfide.sandboxes SET native_sandbox_id=$2,observed_state='DESTROYED',state_version=state_version+1 WHERE id=$1",[sandbox,native])
  def observe(health):
   evidence={'operation':{'kind':'observe'},'outcome':{'status':'SUCCEEDED','acceptance':'CONFIRMED_ACCEPTED','resource':{'native_sandbox_id':native,'sandbox_boot_generation':'1'},'result':{'provider_state':'DESTROYED','health':health}}}
   f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$3::uuid::text,$4,$5,clock_timestamp(),$6)",[org,uid(),create['id'],create['payload_digest'],json.dumps(evidence),m.sha(json.dumps(evidence).encode())])
  observe('UNKNOWN')
  def accounting():
   return f.sql('SELECT r.id,r.state,r.release_reason,r.quantity::text,a.id AS account_id,a.reserved::text,a.allocated::text FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id',[org,f.reservations])
  held=accounting();assert held and all(r['state']!='RELEASED' for r in held),held
  request=dict(run_id=run,pool_id=f.pool,sandbox_id=sandbox,request_key=uid(),deadline_at=m.utc(120000),reason='owned boot cleanup with unknown provider health')
  admitted=ok('provider.intents.prepare-destroy',request)
  assert admitted['created'] is True and admitted['external_call_performed'] is False,admitted
  assert admitted['intent']['kind']=='DESTROY' and admitted['intent']['state']=='RECORDED' and admitted['intent']['native_sandbox_id']==native and str(admitted['intent']['boot_generation'])=='1',admitted
  assert accounting()==held,'Cleanup admission released held capacity without normalized absence'
  replay=ok('provider.intents.prepare-destroy',request);assert replay['created'] is False and replay['intent']['id']==admitted['intent']['id'] and accounting()==held,replay
  def refused():
   answer=invoke('provider.intents.prepare-destroy',dict(request,request_key=uid()));assert answer.get('ok') is False and answer['error']['code']=='RESOURCE_OWNERSHIP_UNKNOWN',answer;assert accounting()==held,'Refused cleanup changed capacity'
  f.sql('UPDATE hyperfide.sandboxes SET native_sandbox_id=NULL,state_version=state_version+1 WHERE id=$1',[sandbox]);refused()
  f.sql('UPDATE hyperfide.sandboxes SET native_sandbox_id=$2,state_version=state_version+1 WHERE id=$1',[sandbox,native])
  observe('ABSENT');f.sql("UPDATE hyperfide.provisioning_intents SET state='TERMINAL',state_version=state_version+1 WHERE id=$1",[create['id']]);refused()
  destroys=f.sql("SELECT id FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND sandbox_id=$2 AND kind='DESTROY'",[org,sandbox]);assert len(destroys)==1 and destroys[0]['id']==admitted['intent']['id'],destroys
  print(json.dumps({'status':'PASS','scope':'actual PostgreSQL and signed cleanup admission; owned boot/provider observation prerequisite metadata controlled','assertions':['DESTROYED with UNKNOWN health admits cleanup under normal empty-boot preflight','cleanup intent exact boot/native identity and idempotent replay','all physical capacity retained without absence release','missing native identity refused without effects','controlled normalized ABSENT same-boot fixture refuses redundant cleanup'],'provider_live':'UNRUN','absence_release':'UNRUN'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
