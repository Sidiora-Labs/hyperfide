#!/usr/bin/env python3
"""Railway operator declarations through signed component APIs; no provider calls.

The example contains illustrative identities, configuration/provenance digests and
UTC dates. Operators must replace those bindings with retained local evidence.
"""
from __future__ import annotations
import copy, importlib.util, json, os, subprocess, sys, uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('intent_fixture',ROOT/'tests/hyperfide/cases/tasks/8_3.py')
b=importlib.util.module_from_spec(s);s.loader.exec_module(b)
expect=b.expect
IDS=['railway.declaration.example-parser','railway.declaration.five-dimensions','railway.declaration.not-observed','railway.declaration.operator-only','railway.declaration.complete-provenance','railway.declaration.thirty-day-bound','railway.declaration.create-admitted','railway.declaration.expired-create-refused','railway.declaration.live-observer-refused']
FAILED=[]
def check(name,fn):
 try:fn();actual='observed'
 except Exception as e:FAILED.append(name);actual=type(e).__name__+': '+str(e)
 print(json.dumps({'type':'assertion','id':name,'expected':'observed','actual':actual}),flush=True)
def main():
 if sys.argv[1:]==['--inventory']:print(json.dumps(IDS));return 0
 if not os.environ.get('DATABASE_URL'):print('SKIP: DATABASE_URL is not set; run under tests/hyperfide/support/withpg.py',flush=True);return 77
 expect(not sys.argv[1:],'unknown argument')
 f=None;cleanup=False
 def setup(f):
  b.prepare_provider_intent_fixture(f)
  executor=f.path/'executor.json'
  executor.write_text(json.dumps({'schema_version':1,'concurrency':1,'principals':[{'credential_id':f.ids['provisioner'],'key_path':str(f.keys['provisioner']['path'])}]}));executor.chmod(0o600)
  f.env['HF_PROVISIONER_EXECUTOR_CONFIG_FILE']=str(executor)
  # Control the quota-read clock in the fixture process without mutating
  # immutable declarations or advancing unrelated authority/deadline clocks.
  f.clock=f.path/'quota-clock.json';f.clock.write_text('0')
  clock_module=f.path/'quota-clock.cjs'
  clock_module.write_text("""const fs=require('node:fs');
const {createRequire}=require('node:module');
const pg=createRequire(process.cwd()+'/core/control-plane/package.json')('pg');
const original=pg.Client.prototype.query;
pg.Client.prototype.query=function(sql,...args){
 if(typeof sql==='string' && sql.startsWith('SELECT q.* FROM hyperfide.provider_quota_observations ')){
  const offset=JSON.parse(fs.readFileSync(process.env.HF_QUOTA_CLOCK_FILE,'utf8'));
  if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid fixture quota clock');
  sql=sql.replaceAll('clock_timestamp()',\"(clock_timestamp()+interval '\"+offset+\" milliseconds')\");
 }
 return original.call(this,sql,...args);
};
""")
  f.env['NODE_OPTIONS']='--require='+str(clock_module);f.env['HF_QUOTA_CLOCK_FILE']=str(f.clock)
  f.declaration_path=f.path/'declarations.json';f.env['HYPERFIDE_CAPACITY_ATTESTATIONS']=str(f.declaration_path)
 def call(action,value=None,key='operator',component='8.2'):
  return f.invoke(action,value or {},component=component,key=key)
 def ok(action,value=None,**kw):
  status,r=call(action,value,**kw);expect(status==200 and r.get('ok') is True,(status,r));return r['result']
 def refused(action,code,value=None,**kw):
  status,r=call(action,value,**kw);expect((status>=400 or r.get('ok') is False) and code in json.dumps(r),(status,r))
 try:
  f=b.pools.ProvisionerFixture(extra_components=['8.2','8.3'],extra_setup=setup)
  ok('provider.pools.configure');org=f.ids['organisation'];run=f.ids['run']
  # Reuse reservation setup, then remove its synthetic quota observations: only
  # the public declaration action may qualify capacity in this case.
  b.seed_provider_capacity(f)
  f.sql('DELETE FROM hyperfide.provider_quota_observations WHERE organisation_id=$1',[org])
  cfg=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active',[org,f.pool])[0]['configuration_digest']
  aid=str(uuid.uuid4());proof=b.sha(b'Railway component operator capacity evidence')
  f.sql("INSERT INTO hyperfide.artifacts(organisation_id,run_id,id,digest,size_bytes,storage_backend,storage_key,status,completed_at) VALUES($1,$2,$3,$4,44,'COMPONENT_FIXTURE','operator-declaration','COMPLETE',clock_timestamp())",[org,run,aid,proof])
  declaration=json.loads((ROOT/'deploy/hyperfide/capacity/railway.example.json').read_text());declaration['organisation_id']=org
  for a in declaration['attestations']:
   a.update(id=str(uuid.uuid4()),pool_id=f.pool,configuration_digest=cfg,scope_key='fixture-account' if a['scope_kind']=='ACCOUNT' else 'fixture-env',declared_at=b.utc(-1000),expires_at=b.utc(3600000),provenance={'run_id':run,'artifact_id':aid,'digest':proof})
  def save():f.declaration_path.write_text(json.dumps(declaration));f.declaration_path.chmod(0o600)
  save()
  check(IDS[0],lambda:expect(ok('provider.pools.attest-capacity')['recorded']==10,'example did not pass actual parser'))
  def capacity():return ok('provider.pools.capacity',{'pool_id':f.pool})
  check(IDS[1],lambda:expect({d['name'] for d in capacity()['dimensions'] if d['qualified']}=={'SANDBOX','PROVISIONING','CPU_MILLIS','MEMORY_BYTES','DISK_BYTES'},'five dimensions not qualified'))
  def not_observed():
   answer=ok('provider.pools.attest-capacity');expect(answer['provider_observed'] is False and answer['source']=='OPERATOR_DECLARED_CAPACITY',answer)
   for d in capacity()['dimensions']:
    if d['name'] not in {a['dimension'] for a in declaration['attestations']}:continue
    for v in d['budgets']:
     expect(v['observed_limit'] is None,v)
     if v['scope'] in ['ACCOUNT','ENVIRONMENT']:expect(v['limit_sources']==['OPERATOR_DECLARED_CAPACITY'] and v['operator_declared_limit'] is not None,v)
  check(IDS[2],not_observed)
  check(IDS[3],lambda:refused('provider.pools.attest-capacity','AUTH_SCOPE_DENIED',key='provisioner'))
  def provenance():
   f.sql("UPDATE hyperfide.artifacts SET status='QUARANTINED',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",[org,aid])
   try:
    refused('provider.pools.attest-capacity','CAPACITY_PROVENANCE_UNRETAINED')
    expect(all(not d['qualified'] for d in capacity()['dimensions']),'unretained evidence qualified')
   finally:f.sql("UPDATE hyperfide.artifacts SET status='COMPLETE',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2",[org,aid])
  check(IDS[4],provenance)
  def bound():
   old=declaration['attestations'][0]['expires_at'];declaration['attestations'][0]['expires_at']=b.utc(31*86400000);save()
   try:refused('provider.pools.attest-capacity','CAPACITY_DECLARATION_STALE')
   finally:declaration['attestations'][0]['expires_at']=old;save()
  check(IDS[5],bound)
  def request():return {'run_id':run,'pool_id':f.pool,'sandbox_id':str(uuid.uuid4()),'request_key':str(uuid.uuid4()),'deadline_at':b.utc(),'reservation_ids':f.reservations,'profile_id':f.profile,'preparation_digest':f.preparation,'purpose':'PREPARATION'}
  def create():
   r=ok('provider.intents.prepare-create',request(),component='8.3');expect(r['created'] is True and r['external_call_performed'] is False,r)
  check(IDS[6],create)
  def expired():
   f.clock.write_text(str(2*3600000))
   expect(all(not d['qualified'] for d in capacity()['dimensions']),'expired capacity qualified')
   refused('provider.intents.prepare-create','QUOTA_UNQUALIFIED',request(),component='8.3')
  check(IDS[7],expired)
  def observer():
   node="""import assert from 'node:assert/strict';import {observeRailwayQuota} from './core/control-plane/dist/providers/railway/reconciliation.js';let calls=0;const client={config:{mode:'live'},assertScope(){},request(){calls++;throw Error('network forbidden')}};await assert.rejects(()=>observeRailwayQuota(client,{}),/QUOTA_UNQUALIFIED/);assert.equal(calls,0);"""
   p=subprocess.run(['node','--input-type=module','-e',node],cwd=ROOT,text=True,capture_output=True,timeout=20);expect(p.returncode==0,p.stderr)
   refused('provider.pools.observe','QUOTA_UNQUALIFIED',{'pool_id':f.pool},key='provisioner')
  check(IDS[8],observer)
  f.close();f=None;cleanup=True
 finally:
  if f is not None:f.close()
  print(json.dumps({'type':'cleanup','resources':[],'complete':cleanup}),flush=True)
 return int(bool(FAILED) or not cleanup)
if __name__=='__main__':sys.exit(main())
