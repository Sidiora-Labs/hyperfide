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
  def observe(health,native_ref=native,boot='1'):
   evidence={'operation':{'kind':'observe'},'outcome':{'status':'SUCCEEDED','acceptance':'CONFIRMED_ACCEPTED','resource':{'native_sandbox_id':native_ref,'sandbox_boot_generation':boot},'result':{'provider_state':'DESTROYED','health':health}}}
   f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$3::uuid::text,$4,$5,clock_timestamp(),$6)",[org,uid(),create['id'],create['payload_digest'],json.dumps(evidence),m.sha(json.dumps(evidence).encode())])
  observe('UNKNOWN')
  def accounting():
   return f.sql('SELECT r.id,r.state,r.release_reason,r.quantity::text,a.id AS account_id,a.reserved::text,a.allocated::text FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.id=ANY($2::uuid[]) ORDER BY r.id',[org,f.reservations])
  held=accounting();assert held and all(r['state']!='RELEASED' for r in held),held
  request=dict(run_id=run,pool_id=f.pool,sandbox_id=sandbox,request_key=uid(),deadline_at=m.utc(120000),reason='owned boot cleanup with unknown provider health')
  admitted=ok('provider.intents.prepare-destroy',request,key='provisioner')
  assert admitted['created'] is True and admitted['external_call_performed'] is False,admitted
  assert admitted['intent']['kind']=='DESTROY' and admitted['intent']['state']=='RECORDED' and admitted['intent']['native_sandbox_id']==native and str(admitted['intent']['boot_generation'])=='1',admitted
  assert accounting()==held,'Cleanup admission released held capacity without normalized absence'
  replay=ok('provider.intents.prepare-destroy',request);assert replay['created'] is False and replay['intent']['id']==admitted['intent']['id'] and accounting()==held,replay
  def refused():
   answer=invoke('provider.intents.prepare-destroy',dict(request,request_key=uid()));assert answer.get('ok') is False and answer['error']['code']=='RESOURCE_OWNERSHIP_UNKNOWN',answer;assert accounting()==held,'Refused cleanup changed capacity'
  f.sql('UPDATE hyperfide.sandboxes SET native_sandbox_id=NULL,state_version=state_version+1 WHERE id=$1',[sandbox]);refused()
  f.sql('UPDATE hyperfide.sandboxes SET native_sandbox_id=$2,state_version=state_version+1 WHERE id=$1',[sandbox,native])
  f.sql("UPDATE hyperfide.provisioning_intents SET state='TERMINAL',state_version=state_version+1 WHERE id=ANY($1::uuid[])",[[create['id'],admitted['intent']['id']]])
  f.sql("UPDATE hyperfide.reservations SET state='RELEASE_PENDING',state_version=state_version+1 WHERE id=ANY($1::uuid[])",[f.reservations]);held=accounting()
  no_admission=ok('provider.intents.reconcile',{'intent_id':admitted['intent']['id']},key='provisioner');assert no_admission.get('confirmed_absence_released') is not True and accounting()==held,no_admission
  manager,observation,reason,decision=[uid() for _ in range(4)];pin=m.sha(b'controlled model cleanup admission')
  f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id) VALUES($1,$2,$3,'FEATURE_MANAGER','fixture','fixture',$3::uuid::text)",[org,run,manager])
  f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{}')",[org,run,observation,manager,pin])
  f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED')",[org,run,reason,manager,pin,observation])
  f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,'DESTROY_SANDBOX',$6,$6,$7,'{}')",[org,run,decision,request['request_key'],manager,pin,reason])
  f.sql("INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)",[org,run,request['request_key'],decision,pin,json.dumps(dict(kind='DESTROY_SANDBOX',provider_intent_id=admitted['intent']['id'],sandbox_id=sandbox))])
  def unproven():
   answer=invoke('provider.intents.reconcile',{'intent_id':admitted['intent']['id']},key='provisioner');assert answer.get('ok') is False and answer['error']['code']=='QUIESCENCE_UNCONFIRMED',answer;assert accounting()==held,'Unproven absence changed held accounting'
  unproven();observe('ABSENT',native_ref='wrong-native');unproven();observe('ABSENT',boot='2');unproven()
  original_reservations=list(f.reservations);f.reservations=[];m.seed_provider_capacity(f)
  for row in held:f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$2::bigint,state_version=state_version+1 WHERE id=$1',[row['account_id'],row['quantity']])
  unrelated_reservations=list(f.reservations)
  unrelated=ok('provider.intents.prepare-create',dict(run_id=run,pool_id=f.pool,sandbox_id=uid(),request_key=uid(),deadline_at=m.utc(120000),reservation_ids=unrelated_reservations,profile_id=f.profile,preparation_digest=f.preparation,purpose='PREPARATION'))['intent']
  f.sql("UPDATE hyperfide.provisioning_intents SET state='REJECTED',state_version=state_version+1 WHERE id=$1",[unrelated['id']])
  def unrelated_rows():return f.sql('SELECT id,state,release_reason,quantity::text FROM hyperfide.reservations WHERE id=ANY($1::uuid[]) ORDER BY id',[unrelated_reservations])
  unrelated_before=unrelated_rows();f.reservations=original_reservations;held=accounting()
  observe('ABSENT');refused()
  released=ok('provider.intents.reconcile',{'intent_id':admitted['intent']['id']},key='provisioner');assert released.get('confirmed_absence_released') is True and released['external_call_performed'] is False,released
  assert set(released['release']['released_reservation_ids'])==set(original_reservations) and len(original_reservations)==4,released
  after=accounting();assert all(r['state']=='RELEASED' and r['release_reason']=='OBSERVED_QUIESCENT' for r in after),after
  before_by_id={r['id']:r for r in held}
  assert all(int(before_by_id[r['id']]['reserved'])-int(r['reserved'])==int(r['quantity']) and r['allocated']==before_by_id[r['id']]['allocated'] for r in after),(held,after)
  assert unrelated_rows()==unrelated_before,'Other rejected/null-native CREATE holds were released'
  replay_release=ok('provider.intents.reconcile',{'intent_id':admitted['intent']['id']},key='provisioner');assert replay_release.get('confirmed_absence_released') is True and accounting()==after and unrelated_rows()==unrelated_before,replay_release
  balances=accounting();f.reservations=[];m.seed_provider_capacity(f)
  for row in balances:f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$2::bigint,state_version=state_version+1 WHERE id=$1',[row['account_id'],row['reserved']])
  direct_reservations=list(f.reservations);direct_sandbox=uid();direct_native='controlled-owned-direct-operator'
  direct_create=ok('provider.intents.prepare-create',dict(run_id=run,pool_id=f.pool,sandbox_id=direct_sandbox,request_key=uid(),deadline_at=m.utc(120000),reservation_ids=direct_reservations,profile_id=f.profile,preparation_digest=f.preparation,purpose='PREPARATION'))['intent']
  f.sql("UPDATE hyperfide.provisioning_intents SET state='ACKNOWLEDGED',native_sandbox_id=$2,state_version=state_version+1 WHERE id=$1",[direct_create['id'],direct_native])
  f.sql("UPDATE hyperfide.sandboxes SET native_sandbox_id=$2,observed_state='DESTROYED',state_version=state_version+1 WHERE id=$1",[direct_sandbox,direct_native])
  direct_request=dict(run_id=run,pool_id=f.pool,sandbox_id=direct_sandbox,request_key=uid(),deadline_at=m.utc(120000),reason='actual signed operator admission component regression')
  direct_destroy=ok('provider.intents.prepare-destroy',direct_request,key='operator')['intent']
  audits=f.sql("SELECT * FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='provider.destroy.operator-admission' AND idempotency_key=$3",[org,run,direct_destroy['id']]);assert len(audits)==1,audits
  audit=audits[0];assert audit['state']=='COMPLETED' and audit['principal_scope']==f.ids['operator'] and audit['result']['role']=='OPERATOR' and audit['result']['credential_id']==f.ids['operator'] and audit['result']['provider_intent_id']==direct_destroy['id'] and audit['result']['request_digest']==direct_destroy['request_digest'],audit
  model_rows=f.sql("SELECT operation_id FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND result->>'provider_intent_id'=$3",[org,run,direct_destroy['id']]);assert not model_rows,'Direct operator positive depends on model receipt'
  f.sql("UPDATE hyperfide.provisioning_intents SET state='TERMINAL',state_version=state_version+1 WHERE id=ANY($1::uuid[])",[[direct_create['id'],direct_destroy['id']]])
  direct_observation={'operation':{'kind':'observe'},'outcome':{'status':'SUCCEEDED','acceptance':'CONFIRMED_ACCEPTED','resource':{'native_sandbox_id':direct_native,'sandbox_boot_generation':'1'},'result':{'provider_state':'DESTROYED','health':'ABSENT'}}}
  f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$3::uuid::text,$4,$5,clock_timestamp(),$6)",[org,uid(),direct_create['id'],direct_create['payload_digest'],json.dumps(direct_observation),m.sha(json.dumps(direct_observation).encode())])
  f.sql("UPDATE hyperfide.reservations SET state='RELEASE_PENDING',state_version=state_version+1 WHERE id=ANY($1::uuid[])",[direct_reservations]);direct_held=accounting()
  def direct_refused(result,state='COMPLETED'):
   f.sql('UPDATE hyperfide.command_inbox SET result=$2,state=$3,state_version=state_version+1 WHERE id=$1',[audit['id'],json.dumps(result),state])
   outcome=ok('provider.intents.reconcile',{'intent_id':direct_destroy['id']},key='provisioner');assert outcome.get('confirmed_absence_released') is not True and accounting()==direct_held and unrelated_rows()==unrelated_before,outcome
  direct_refused(dict(audit['result'],request_digest=m.sha(b'wrong request')))
  direct_refused(dict(audit['result'],boot_generation='2'))
  direct_refused(dict(audit['result'],native_sandbox_id='wrong-native'))
  direct_refused(audit['result'],state='PENDING')
  f.sql("UPDATE hyperfide.command_inbox SET result=$2,state='COMPLETED',state_version=state_version+1 WHERE id=$1",[audit['id'],json.dumps(audit['result'])])
  direct_release=ok('provider.intents.reconcile',{'intent_id':direct_destroy['id']},key='provisioner');assert direct_release.get('confirmed_absence_released') is True and set(direct_release['release']['released_reservation_ids'])==set(direct_reservations),direct_release
  direct_after=accounting();direct_before={r['id']:r for r in direct_held};assert all(r['state']=='RELEASED' and int(direct_before[r['id']]['reserved'])-int(r['reserved'])==int(r['quantity']) for r in direct_after),direct_after
  direct_replay=ok('provider.intents.reconcile',{'intent_id':direct_destroy['id']},key='provisioner');assert direct_replay.get('confirmed_absence_released') is True and accounting()==direct_after and unrelated_rows()==unrelated_before,direct_replay
  destroys=f.sql("SELECT id FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND sandbox_id=$2 AND kind='DESTROY'",[org,sandbox]);assert len(destroys)==1 and destroys[0]['id']==admitted['intent']['id'],destroys
  print(json.dumps({'status':'PASS','scope':'actual PostgreSQL and signed cleanup admission; owned boot/provider observation prerequisite metadata controlled','assertions':['DESTROYED with UNKNOWN health admits cleanup under normal empty-boot preflight','cleanup intent exact boot/native identity and idempotent replay','all physical capacity retained without absence release','missing native identity refused without effects','controlled normalized ABSENT same-boot fixture refuses redundant cleanup','missing model admission, unknown health and wrong native/boot retain capacity','production scheduler releases exact four linked physical reservations from controlled proof prerequisites','replay preserves counters and unrelated rejected/null-native resource holds','actual signed OPERATOR audit admits exact physical release without model receipt','wrong direct-admission request digest, native, boot or missing completed audit retain holds'],'provider_live':'UNRUN','absence_release':'COMPONENT_ONLY_CONTROLLED_PROOF_PRECONDITIONS'}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
