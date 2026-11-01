"""Actual role/TLS/PG gateway failure provenance; controlled HTTPS503 is not live evidence."""
import copy,importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import fleet_live_qualification as oracle
s=importlib.util.spec_from_file_location('model_role_base',ROOT/'tests/hyperfide/cases/source_control/fleet_model_role_contract.py');base=importlib.util.module_from_spec(s);s.loader.exec_module(base);Original=base.adoption.sched.SchedulerFixture
class Fixture(Original):
 checked=0
 def invoke(self,action,value,*args,**kwargs):
  result=super().invoke(action,value,*args,**kwargs);answer=result[1]
  if action!='fleet.session.reason' or answer.get('result',{}).get('deterministic_fallback') is not False:return result
  tables=['fleet_reasoning','fleet_observations','fleet_decisions','fleet_effect_receipts','runner_remote_jobs','provider_remote_operations'];rows={t:self.sql('SELECT '+oracle.COLUMNS[t]+' FROM hyperfide.'+t+' WHERE organisation_id=$1 AND run_id=$2',[self.ids['organisation'],self.ids['run']]) for t in tables};reason=oracle.one(rows['fleet_reasoning'],'id',value['operation_id']);pin={'reasoning_id':reason['id'],'actor_id':reason['actor_id'],'observation_id':value['observation_id'],'model_profile_digest':oracle.digest(reason['result']['model_profile']),'expected_reason':'FLEET_GATEWAY_HTTP_503'};outer=answer['operation_id'];oracle.verified_model_failure_request(rows,pin,value,answer,outer)
  names=['wrong-actor','wrong-operation','wrong-observation','wrong-request-digest','wrong-profile','mechanical-db-error','fallback','unrelated-wait','unexpected-effect']
  for name in names:
   actual=copy.deepcopy(rows);p=copy.deepcopy(pin);request=copy.deepcopy(value);response=copy.deepcopy(answer);retained=oracle.one(actual['fleet_reasoning'],'id',reason['id'])
   if name=='wrong-actor':p['actor_id']=base.uid()
   elif name=='wrong-operation':request['operation_id']=base.uid()
   elif name=='wrong-observation':request['observation_id']=base.uid()
   elif name=='wrong-request-digest':retained['request_digest']=oracle.digest(b'changed')
   elif name=='wrong-profile':p['model_profile_digest']=oracle.digest(b'wrong profile')
   elif name=='mechanical-db-error':retained['reason']=p['expected_reason']='DB_UNAVAILABLE';response['result']['reason']='DB_UNAVAILABLE'
   elif name=='fallback':response['result']['deterministic_fallback']=True
   elif name=='unrelated-wait':p['reasoning_id']=base.uid()
   else:actual['fleet_effect_receipts'].append({'operation_id':reason['id']})
   try:oracle.verified_model_failure_request(actual,p,request,response,outer)
   except oracle.Refused:pass
   else:raise AssertionError('Model failure oracle admitted '+name)
  proof=ROOT/'build/fleet/integration/private'/('model-failure-provenance-'+value['binding']['actor_role']+'.json');proof.parent.mkdir(parents=True,exist_ok=True);proof.write_text(json.dumps({'scope':'ACTUAL_CONTROLLED_PG_TLS503_NOT_LIVE','rows':rows,'pin':pin,'request':value,'response':answer,'outer_operation_id':outer},indent=2)+'\n');proof.chmod(0o600)
  Fixture.checked+=1;print(json.dumps({'status':'PASS','scope':'actual component actor-signed PG/TLS503 request provenance; controlledgateway, notlivequalification','actor_role':value['binding']['actor_role'],'negative_cases':names}),flush=True);return result
if __name__=='__main__':
 if not os.environ.get('DATABASE_URL'):raise SystemExit(subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode)
 base.adoption.sched.SchedulerFixture=Fixture;code=base.main();assert code or Fixture.checked==2,'Both actual actor failures must be checked';raise SystemExit(code)
