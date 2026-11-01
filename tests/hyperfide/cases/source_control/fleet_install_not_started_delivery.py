#!/usr/bin/env python3
"""Reuse the real NOT_STARTED authority fixture for separate lineage/delivery/oracle checks."""
import copy,datetime,importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
s=importlib.util.spec_from_file_location('not_started_core',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started.py');base=importlib.util.module_from_spec(s);s.loader.exec_module(base)
from identity_fixture import uid,sha
import fleet_live_qualification as oracle
Original=base.a.AssignmentFixture
class DeliveryFixture(Original):
 def __init__(self,*args,**kwargs):self.last_admission=None;super().__init__(*args,**kwargs)
 def sql(self,statement,values=(),*args,**kwargs):
  if statement.startswith('INSERT INTO hyperfide.fleet_environment_specs('):
   columns=statement.split('(',1)[1].split(')',1)[0].split(',');values=list(values);at=columns.index('source_config');source=json.loads(values[at]);source['source']['repository']=self.ids['repository'];values[at]=json.dumps(source)
  return super().sql(statement,values,*args,**kwargs)
 def invoke(self,action,value,*args,**kwargs):
  result=super().invoke(action,value,*args,**kwargs)
  if action=='fleet.install.admit' and result[1].get('ok'):self.last_admission=(value['decision'],result[1]['result']['admission'])
  return result
 def close(self):
  try:
   if self.last_admission:extension(self,*self.last_admission)
  finally:super().close()
def extension(f,decision,admission):
 i=f.ids;common=[i['organisation'],i['run']];scope={'organisation_id':i['organisation'],'run_id':i['run']}
 old_id=f.sql('SELECT logical_operation_id::text FROM hyperfide.fleet_install_heads WHERE current_operation_id=$1',[decision['operation_id']])[0]['logical_operation_id'];old=f.sql('SELECT * FROM hyperfide.fleet_environment_installs WHERE operation_id=$1',[old_id])[0];c={'install':old}
 import fleet_live_qualification as oracle
 retained={table:f.sql('SELECT '+oracle.COLUMNS[table]+' FROM hyperfide.'+table+' WHERE organisation_id=$1 AND run_id=$2',common) for table in ['fleet_environment_installs','fleet_install_not_started_recoveries','runner_not_started_proofs','runner_remote_jobs','provider_remote_operations','reservations']}
 retained['capacity_accounts']=f.sql('SELECT id,capacity_class,dimension FROM hyperfide.capacity_accounts WHERE organisation_id=$1',[i['organisation']])
 current=oracle.one(retained['fleet_environment_installs'],'operation_id',decision['operation_id']);previous=oracle.one(retained['fleet_environment_installs'],'operation_id',c['install']['operation_id']);edge=oracle.one(retained['fleet_install_not_started_recoveries'],'operation_id',decision['operation_id'])
 oracle.verified_not_started_edge(retained,current,previous,edge)
 for mutation in ['claim-marker','proof-digest','released-quantity']:
  altered=copy.deepcopy(retained)
  if mutation=='claim-marker':oracle.one(altered['runner_remote_jobs'],'operation_id',previous['operation_id'])['not_started_proof_id']=uid()
  elif mutation=='proof-digest':oracle.one(altered['runner_not_started_proofs'],'id',edge['proof_id'])['proof_digest']='sha256:'+'0'*64
  else:oracle.one(altered['reservations'],'id',oracle.one(altered['runner_not_started_proofs'],'id',edge['proof_id'])['proof']['reservation_ids'][0])['quantity']='999'
  try:oracle.verified_not_started_edge(altered,oracle.one(altered['fleet_environment_installs'],'operation_id',current['operation_id']),oracle.one(altered['fleet_environment_installs'],'operation_id',previous['operation_id']),oracle.one(altered['fleet_install_not_started_recoveries'],'operation_id',current['operation_id']))
  except oracle.Refused:pass
  else:raise AssertionError('Acceptance NOT_STARTED oracle admitted altered '+mutation)
 proof_at=oracle.evidence_time(oracle.one(retained['runner_not_started_proofs'],'id',edge['proof_id'])['created_at']);old_job=oracle.one(retained['runner_remote_jobs'],'operation_id',previous['operation_id'])
 temporal_cases=[('same-session-before-proof',-1,uid(),False),('same-session-at-proof',0,uid(),False),('successor-after-proof',1,current['operation_id'],True),('original-operation-before-proof',-1,previous['operation_id'],False),('original-operation-at-proof',0,previous['operation_id'],False),('original-operation-after-proof',1,previous['operation_id'],False)]
 for label,offset,event_operation,allowed in temporal_cases:
  altered=copy.deepcopy(retained);altered['provider_remote_operations'].append({'id':event_operation,'session_id':uid() if label.startswith('original-operation-') else old_job['session_id'],'state':'OBSERVED','created_at':(proof_at+datetime.timedelta(microseconds=offset)).isoformat()})
  try:oracle.verified_not_started_edge(altered,current,previous,edge)
  except oracle.Refused as error:
   if allowed:raise AssertionError('Acceptance oracle rejected authorized post-proof successor metadata') from error
   if str(error)!='NOT_STARTED_PROVIDER_ABSENCE_REQUIRED':raise AssertionError('Temporal case refused for the wrong invariant: '+label) from error
  else:
   if not allowed:raise AssertionError('Acceptance oracle admitted '+label)
 print(json.dumps({'status':'PASS','scope':'actual PostgreSQL append-only proof acceptance and temporal metadata contract; controlled prior job and provider-event metadata, no provider execution claim','negative_cases':['claim-marker','proof-digest','released-quantity','same-session-before-proof','same-session-at-proof','original-operation-before-proof','original-operation-at-proof','original-operation-after-proof'],'allowed_temporal_case':'successor-after-proof','native_execution':'UNRUN'}))
 target=actual_target(f,admission,old)
 principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['credential_id']==i['operator'])
 payload={'scope':scope,'principal':principal,'operation':decision['operation_id'],'original':old_id,'epoch':i['epoch'],'identity':target['identity']}
 script=r"""
import fs from 'node:fs';
import {createResourceContainer} from './core/control-plane/dist/storage/runtime.js';
import {authenticatedInvocation} from './core/control-plane/dist/transport/protocol.js';
import {readBootstrapInstallAllocationEpoch} from './core/control-plane/dist/preparation/fleet_install_lineage.js';
import {fleetInstallDeliveryInputs} from './core/control-plane/dist/preparation/fleet_authority.js';
import {bootstrapInstallAllocationRequestId} from './core/control-plane/dist/providers/bootstrap_install.js';
const d=JSON.parse(fs.readFileSync(0)),r=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});const assert=(v,m)=>{if(!v)throw Error(m)};
const i=authenticatedInvocation({principal:d.principal,signal:new AbortController().signal,guard:async t=>{const row=(await t.query('SELECT authority_epoch FROM hyperfide.runs WHERE organisation_id=$1 AND id=$2',[d.scope.organisation_id,d.scope.run_id])).rows[0];assert(row?.authority_epoch===d.epoch,'Current run authority required')}});
try{const result=await r.gateway.withPrimaryTransaction({guard:i.guard},async tx=>{const lineage=await readBootstrapInstallAllocationEpoch(tx,{...d.scope,operation_id:d.operation}),delivery=await fleetInstallDeliveryInputs(tx,i,d.operation);assert(lineage.logical_operation_id===d.original&&lineage.allocation_epoch_operation_id===d.operation,'Fresh NOT_STARTED allocation epoch lost');assert(delivery.logical_operation_id===d.original&&delivery.allocation_epoch_operation_id===d.operation&&delivery.admission.logical_operation_id===d.operation&&!('recovery_of'in delivery.admission),'Coordinator lineage leaked into native recovery inputs');const fresh=bootstrapInstallAllocationRequestId({...d.identity,execution_operation_id:lineage.allocation_epoch_operation_id}),old=bootstrapInstallAllocationRequestId({...d.identity,execution_operation_id:d.original});assert(fresh!==old,'Fresh epoch reused old allocation identity');return {lineage,fresh_allocation_request_id:fresh,old_allocation_request_id:old}});console.log(JSON.stringify({status:'PASS',scope:'actual PostgreSQL production lineage/delivery-input and allocation identity derivation; no native execution',result}));}finally{await r.close()}
"""
 p=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(payload),text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=30);print(p.stdout,end='');print(p.stderr,end='',file=sys.stderr);assert p.returncode==0,'Production lineage/delivery input check failed'
def actual_target(f,admission,old):
 i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];insert=base.insert;digest=base.digest;pin=sha(b'CONTROLLED_PRIOR_BOOTSTRAP_TARGET_INPUT')
 session,slot,credential,bootstrap,delivery=[uid() for _ in range(5)];root='/component/fresh-target/'+session
 insert(f,'worker_slots',{'organisation_id':i['organisation'],'id':slot,'sandbox_id':i['sandbox'],'slot_key':'fresh-prep-'+session,'boot_generation':1,'capacity_kind':'PREPARATION','state':'READY'})
 insert(f,'identity_principals',{'credential_id':credential,**scope,'actor_id':credential,'role':'RUNNER','public_key_b64':f.keys['runner']['public_key_b64'],'deployment_epoch':i['epoch'],'allowed_actions':['identity.describe'],'expires_at':'2099-01-01T00:00:00Z','sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'state':'ACTIVE'})
 insert(f,'identity_runner_status',{'credential_id':credential,'preparation_digest':f.preparation,'inventory':json.dumps([])})
 insert(f,'runner_registry',{**scope,'session_id':session,'credential_id':credential,'sandbox_id':i['sandbox'],'boot_generation':1,'boot_id':i['boot'],'slot_id':slot,'repository_id':i['repository'],'state_dir':root+'/state','runner_binary':'/component/native','workspace_path':root+'/source','home_path':root+'/home','tmp_path':root+'/tmp','runner_binary_digest':pin,'boot_preparation_digest':f.preparation,'preparation_digest':f.preparation,'preparation_recipes':{'controlled_prior_policy':True},'slot_generation':1,'uid':41450,'gid':41450,'observation_digest':pin,'state':'PREPARING'})
 old_job=f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[old['operation_id']])[0];old_allocation=f.sql('SELECT * FROM hyperfide.resource_job_allocations WHERE id=$1',[old_job['plan']['allocation']['allocation_id']])[0]
 source={'repository_key':i['repository'],'source_object_id':f.source,'source_tree_id':'b'*40,'source_manifest_digest':admission['source_manifest_digest']};staging=[{'role':'fleet.package','artifact_id':uid(),'storage_kind':'object','digest':pin,'size_bytes':'0'}]
 prior={'controlled_prior_delivery_input':True};insert(f,'fleet_install_deliveries',{**scope,'id':delivery,'input_digest':admission['input_digest'],'environment_id':admission['environment_id'],'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'session_id':old_job['session_id'],'reservation_id':old_job['reservation_id'],'target_binding_id':old_allocation['id'],'source':source,'staging':json.dumps(staging),'timeout_ms':1000,'registration_digest':pin,'registered_by':i['operator'],'operation_id':old['operation_id'],'request':prior,'request_digest':digest(prior),'state':'QUEUED'})
 original_delivery=f.sql('SELECT to_jsonb(d) AS row FROM hyperfide.fleet_install_deliveries d WHERE id=$1',[delivery])
 task_key=f.sql('SELECT task_key FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]['task_key'];template={'schema_version':1,'input_digest':admission['input_digest'],'environment_id':admission['environment_id'],'environment_generation':1,'preparation':{'task_key':task_key,'deadline_ms':300000,'slot_key':'fresh-preparation'},'verification':{'task_key':task_key,'deadline_ms':300000,'slot_key':'fresh-preparation'},'source':source,'staging':staging,'timeout_ms':1000};descriptor={'install_template':template,'controlled_prior_bootstrap_input':True};descriptor_digest=digest(descriptor)
 configs=f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 LIMIT1'.replace('LIMIT1','LIMIT 1'),[i['organisation'],i['pool']])
 configuration=configs[0]['configuration_digest'] if configs else pin
 if not configs:insert(f,'provider_pool_configurations',{'organisation_id':i['organisation'],'pool_id':i['pool'],'configuration_digest':configuration,'document':{'controlled_prior_configuration':True}})
 insert(f,'provisioning_intents',{**scope,'id':bootstrap,'pool_id':i['pool'],'sandbox_id':i['sandbox'],'configuration_digest':configuration,'kind':'CREATE','preparation_purpose':'PREPARATION','profile_id':i['profile'],'request_key':bootstrap,'request_digest':pin,'payload_digest':pin,'operation':{'controlled_prior_owned_create_input':True},'state':'ACKNOWLEDGED','native_sandbox_id':'controlled-prior-resource','boot_generation':1})
 receipt={'controlled_prior_bootstrap_receipt_input':True,'slots':[{'name':'fresh-preparation','slot_id':slot,'session_id':session,'slot_generation':'1','uid':41450,'gid':41450}]}
 insert(f,'provider_native_bootstraps',{**scope,'intent_id':bootstrap,'id':bootstrap,'pool_id':i['pool'],'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'native_sandbox_id':'controlled-prior-resource','configuration_digest':configuration,'profile_id':i['profile'],'preparation_digest':f.preparation,'descriptor_digest':descriptor_digest,'descriptor':descriptor,'grant_id':uid(),'binding_operation_id':uid(),'grant_operation_id':uid(),'enrollment_operation_id':uid(),'secret_ref':'/controlled/not-read','verifier':pin,'process_id':'CONTROLLED_PRIOR_BOOTSTRAP_INPUT','state':'READY','receipt':receipt,'receipt_digest':digest(receipt)})
 pending=f.ok('fleet.install.delivery.pending',{'after':None,'limit':100},component='fleet-install-delivery',key='operator');commands=[c for c in pending['bootstrap_commands'] if c['action']=='fleet.install.delivery.prepare.allocate'];assert len(commands)==1,pending
 command=commands[0];allocated=f.ok(command['action'],command['input'],component='fleet-install-delivery',key='operator');allocation=allocated['allocation'];assert allocation['allocation_id']!=old_allocation['id'] and allocation['reservation_id']!=old_job['reservation_id'],allocated
 result=f.ok('fleet.install.delivery.collect',{'operation_id':admission['operation_id']},component='fleet-install-delivery',key='operator');assert result['state']=='PENDING',result
 row=f.sql('SELECT * FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[admission['operation_id']])[0];target=row['target_binding'];assert row['logical_operation_id']==old['operation_id'] and target['allocation_id']==allocation['allocation_id'] and target['session_id']==session and target['reservation_id']==allocation['reservation_id'] and target['request_id']==command['input']['request_id'],row
 assert f.sql('SELECT to_jsonb(d) AS row FROM hyperfide.fleet_install_deliveries d WHERE id=$1',[delivery])==original_delivery,'Original delivery mutated'
 assert not f.sql('SELECT operation_id FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[admission['operation_id']]),'Component target check launched native job'
 again=f.ok('fleet.install.delivery.collect',{'operation_id':admission['operation_id']},component='fleet-install-delivery',key='operator');assert again['state']=='PENDING' and f.sql('SELECT * FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[admission['operation_id']])==[row],'Target replay mutated'
 print(json.dumps({'status':'PASS','scope':'actual signed projector, fresh PREPARATION allocation and delivery.collect target-binding persistence; historical bootstrap/identity inputs, no native execution','old_delivery_unchanged':True,'new_allocation_and_reservation':True,'target_replay_stable':True}),flush=True)
 return {'identity':{'bootstrap_id':bootstrap,'descriptor_digest':descriptor_digest,'input_digest':admission['input_digest'],'purpose':'preparation','task_id':i['task_a']},'target':target,'allocation':allocation}
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 base.a.AssignmentFixture=DeliveryFixture
 return base.main()
if __name__=='__main__':raise SystemExit(main())
