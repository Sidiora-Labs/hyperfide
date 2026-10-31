#!/usr/bin/env python3
"""Effective qualified pool ceilings through real configuration and reservation APIs."""
import importlib.util,json,subprocess,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('provider_capacity_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def main():
 def setup(f):
  m.prepare_provider_intent_fixture(f)
  f.config['accounts'][0]['approved_limits']['SANDBOX']='2'
  f.config['pools'][0]['approved_limits']['SANDBOX']='2'
  second=json.loads(json.dumps(f.config['pools'][0]));second['id']=str(uuid.uuid4());f.fresh_pool=second['id'];f.config['pools'].append(second)
  f.configfile.write_text(json.dumps(f.config))
 f=m.pools.ProvisionerFixture(extra_components=['8.2','8.3'],extra_setup=setup)
 try:
  def call(action,value=None,component='8.2',key='operator'):
   response=f.invoke(action,value or {},component=component,key=key)[1];assert response.get('ok'),response;return response['result']
  call('provider.worker.stop',component='8.3',key='provisioner');call('provider.pools.configure')
  def observe(pool,kind,key,limit):
   cfg=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[f.ids['organisation'],pool])[0]['configuration_digest']
   f.sql("INSERT INTO hyperfide.provider_quota_observations(organisation_id,id,pool_id,configuration_digest,provider,account_key,scope_kind,scope_key,dimension,quota_limit,observed_at,expires_at,evidence_digest,basis,evidence_reference) VALUES($1,$2,$3,$4,'railway','fixture-account',$5,$6,'SANDBOX',$7,clock_timestamp(),clock_timestamp()+interval '10 minutes',$8,'VERIFIED_OPERATOR_ATTESTATION','ISOLATED_COMPONENT_FIXTURE')",[f.ids['organisation'],str(uuid.uuid4()),pool,cfg,kind,key,limit,m.sha(b'explicit fixture quota prerequisite')])
  observe(f.pool,'ACCOUNT','fixture-account','2');observe(f.pool,'ENVIRONMENT','fixture-env','2');call('provider.pools.configure')
  script="""import fs from 'node:fs';import{createResourceContainer}from'./core/control-plane/dist/storage/runtime.js';import{writeSemanticDisposition}from'./core/control-plane/dist/storage/dispositions.js';import{reserveCapacity}from'./core/control-plane/dist/scheduler/claim.js';import{assertPoolCapacity,readDeployment}from'./core/control-plane/dist/providers/pools.js';const d=JSON.parse(fs.readFileSync(0,'utf8')),r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});try{const config=await readDeployment(process.env);const result=await r.gateway.withPrimaryTransaction({timeoutMs:10000,guard:async tx=>{await writeSemanticDisposition(tx,d.scope);const current=(await tx.query('SELECT authority_epoch FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[d.scope.organisation_id,d.scope.run_id])).rows[0];if(current?.authority_epoch!==d.epoch)throw Error('fixture authority changed');}},async tx=>{const account=(await tx.query(\"SELECT id FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension='SANDBOX' AND capacity_class='PHYSICAL'\",[d.scope.organisation_id,d.pool])).rows[0];const reservations=await reserveCapacity(tx,{...d.scope,request_id:d.request_id,dimensions:[{capacity_account_id:account.id,quantity:'1'}],expires_at:new Date(Date.now()+60000).toISOString()});await assertPoolCapacity(tx,config,d.pool,{SANDBOX:'1'},true);return reservations;});console.log(JSON.stringify({result}));}catch(e){console.log(JSON.stringify({error:e.code??'ERROR'}));}finally{await r.close();}"""
  def reserve(pool):
   data={'scope':{'organisation_id':f.ids['organisation'],'run_id':f.ids['run']},'epoch':f.ids['epoch'],'pool':pool,'request_id':str(uuid.uuid4())}
   p=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(data),cwd=ROOT,env=f.env,capture_output=True,text=True,timeout=25);assert p.returncode==0,p.stderr;return json.loads(p.stdout)
  def accounts():
   return f.sql("SELECT pool_id,configured_limit::text,reserved::text,allocated::text,qualification_state FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=ANY($2::uuid[]) AND dimension='SANDBOX' AND capacity_class='PHYSICAL' ORDER BY pool_id",[f.ids['organisation'],[f.pool,f.fresh_pool]])
  initial=reserve(f.pool);assert 'result' in initial,initial
  held=f.sql('SELECT id,quantity::text,state FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 ORDER BY id',[f.ids['organisation'],f.ids['run']])
  for pool in (f.pool,f.fresh_pool):observe(pool,'POOL',pool,'1')
  call('provider.pools.configure');rows=accounts();assert all(row['configured_limit']=='1' and row['qualification_state']=='QUALIFIED' for row in rows),rows
  assert f.sql('SELECT id,quantity::text,state FROM hyperfide.reservations WHERE organisation_id=$1 AND run_id=$2 ORDER BY id',[f.ids['organisation'],f.ids['run']])==held
  old=next(row for row in rows if row['pool_id']==f.pool);assert old['reserved']=='1' and old['allocated']=='0',old
  refused=reserve(f.pool);assert 'error' in refused,refused;assert accounts()==rows
  fresh=reserve(f.fresh_pool);assert 'result' in fresh,fresh
  report=call('provider.pools.capacity',{'pool_id':f.fresh_pool});sandbox=next(row for row in report['dimensions'] if row['name']=='SANDBOX');assert sandbox['used_account']=='2' and sandbox['used_pool']=='1',sandbox
  assert all(row['configured_limit']=='1' and row['reserved']=='1' for row in accounts())
  print(json.dumps({'status':'PASS','assertions':['qualified pool1 bounds approved environment2 during actual configuration','existing physical hold survives reconfiguration unchanged','second old-pool reservation refuses without counter mutation','fresh pool admits one within shared account2'],'scope':'actual PostgreSQL configuration and guarded production reservation APIs'}))
 finally:f.close()
if __name__=='__main__':main()
