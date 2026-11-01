#!/usr/bin/env python3
"""Real TLS/PG handoff and supervisor fairness over explicitly seeded fleet delegation.

No model decision, native worker execution or provider qualification is asserted.
"""
import hashlib,importlib.util,json,os,shutil,socket,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import identity_fixture
from fleet_prerequisite_fixture import hierarchy_type,component_closure

def load_factory():
 s=importlib.util.spec_from_file_location('unavailable_model_gate',ROOT/'tests/hyperfide/cases/source_control/0_12.py')
 m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m.credential_store

def wait(check,seconds=15):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  if check():return
  time.sleep(.15)
 raise AssertionError('Replacement did not reach actual persisted reasoning')

def transpile(source,target):
 script="const fs=require('fs'),ts=require(process.argv[1]);const r=ts.transpileModule(fs.readFileSync(process.argv[2],'utf8'),{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});if(r.diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error)){console.error(ts.formatDiagnosticsWithColorAndContext(r.diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:f=>f,getNewLine:()=>String.fromCharCode(10)}));process.exit(1)}fs.writeFileSync(process.argv[3],r.outputText)"
 subprocess.run(['node','-e',script,str(ROOT/'node_modules/typescript'),str(source),str(target)],check=True,capture_output=True)

def campaign(folder,baseline=False,product=False):
 runtime=folder/'runtime';shutil.copytree(ROOT/'build/fleet/local-runtime-pool-recipes-handoff',runtime,symlinks=True)
 identity_fixture.ROOT=runtime
 dist=runtime/'core/control-plane/dist'
 transpile(ROOT/'core/control-plane/src/hierarchy/packages.ts',dist/'hierarchy/packages.js')
 for module in ['agents/fleet_orchestration','agents/fleet_bootstrap','agents/fleet_manager_handoff','scheduler/claim']:
  transpile(ROOT/('core/control-plane/src/'+module+'.ts'),dist/(module+'.js'))
 shutil.copyfile(ROOT/'contracts/fleet/index.mjs',dist/'contracts/fleet/index.mjs')
 shutil.copyfile(ROOT/'core/control-plane/migrations/0728-fleet-manager-handoff.sql',runtime/'core/control-plane/migrations/0728-fleet-manager-handoff.sql')
 source=ROOT/'core/control-plane/src/fleet-supervisor.ts'
 if baseline:
  source=folder/'baseline.ts';source.write_bytes(subprocess.check_output(['git','show','519de0fec2865fac3bd641e38af3880b831077b4:core/control-plane/src/fleet-supervisor.ts'],cwd=ROOT))
 transpile(source,dist/'fleet-supervisor.js')
 f=None;child=None
 try:
  def setup(f):
   load_factory()(f)
   f.env['HYPERFIDE_FLEET_HOST_ID']=socket.gethostname()
  f=hierarchy_type()(extra_components=component_closure(['fleet-orchestration']),bootstrap=False,seed_historical_runtime=False,parent_managers=True,extra_setup=setup)
  i=f.ids
  f.ok('hierarchy.leader.acquire',{'idempotency_key':'replacement-leader','expected_generation':'0','reason':'Isolated supervisor replacement boundary'})
  f.ok('hierarchy.package.configure',{'idempotency_key':'replacement-configure','leader_generation':'1','package_id':i['wave_package'],'feature_key':'beta','allocation_policy':'WAVE'})
  f.ok('hierarchy.package.assign',{'idempotency_key':'replacement-assign','leader_generation':'1','package_id':i['wave_package'],'expected_generation':'1','manager_session_id':i['manager']})
  budget={'allowed_actions':[],'provider_ids':[],'profile_ids':[],'task_ids':[],'max_sandboxes':1,'max_concurrent_workers':1}
  # Declared historical grant, not a fabricated model decision or executed effect.
  f.sql('INSERT INTO hyperfide.fleet_delegations(organisation_id,run_id,package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id) VALUES($1,$2,$3,$4,2,1,$5,$6)',[i['organisation'],i['run'],i['wave_package'],i['manager'],json.dumps(budget),str(uuid.uuid4())])
  refs=[]
  for name,role in [('leader','LEADER'),('manager','FEATURE_MANAGER'),('manager2','FEATURE_MANAGER')]:
   cred=f.path/(name+'-supervisor.json');cred.write_text(json.dumps({'schema_version':1,'credential_id':i[name],'actor_id':i[name],'organisation_id':i['organisation'],'run_id':i['run'],'role':role,'authority_epoch':i['epoch'],'key_file':str(f.keys[name]['path'])}));cred.chmod(0o600)
   refs.append({'session_id':i[name],'credential_file':str(cred)})
  config={'schema_version':1,'origin':f.origin,'ca_file':str(f.ca),'organisation_id':i['organisation'],'run_id':i['run'],'cohort_id':str(uuid.uuid4()),'host_id':socket.gethostname(),'leader_generation':'1','expected_cohort_generation':'0','primary':refs[0],'managers':refs[1:],'state_directory':str(f.path/'supervisor-state'),'poll_interval_ms':1000,'request_timeout_ms':10000}
  if product:
   operator=f.path/'replacement-operator.json';operator.write_text(json.dumps({'schema_version':1,'credential_id':i['operator'],'actor_id':i['operator'],'organisation_id':i['organisation'],'run_id':i['run'],'role':'OPERATOR','authority_epoch':i['epoch'],'key_file':str(f.keys['operator']['path'])}));operator.chmod(0o600)
   config['bootstrap']={'operator_credential_file':str(operator),'ttl_seconds':900}
  cfg=f.path/'replacement.json';cfg.write_text(json.dumps(config));cfg.chmod(0o600)
  log=folder/'supervisor.log'
  with log.open('w') as stream:
   child=subprocess.Popen(['node',str(dist/'fleet-supervisor.js'),'--config',str(cfg)],env=f.env,cwd=runtime,stdout=stream,stderr=stream)
  def reasoned(actor):return f.sql('SELECT id FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND actor_id=$3',[i['organisation'],i['run'],actor])
  wait(lambda:reasoned(i['manager']))
  if product:
   def select_replacement(expected,successor):
    binding={'actor_id':i['leader'],'actor_role':'PRIMARY','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':None,'manager_generation':None}
    observed=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},component='fleet-orchestration')
    body=f.sql('SELECT body,context_digest FROM hyperfide.fleet_observations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],observed['observation_id']])[0]
    action={'package_id':i['wave_package'],'expected_generation':expected,'successor_id':successor,'context':{'summary':'Declared preexisting Primary selection for isolated delivery boundary','decision_refs':[],'pending_instruction_refs':[],'native_session_refs':[]}}
    digest=lambda value:'sha256:'+hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    decision={'schema_version':1,'kind':'hyperfide.fleet-decision','decision_id':str(uuid.uuid4()),'operation_id':str(uuid.uuid4()),'run_id':i['run'],**binding,'source_revision':'git:'+('a'*40),'spec_revision':i['spec'],'context_digest':body['context_digest'],'action':'REPLACE_MANAGER','input':action,'input_digest':digest(action),'expected_version':str(f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[i['organisation'],i['run'],i['leader']])[0]['plan_generation']),'rationale_summary':'Explicit historical decision fixture; no actual model inference claimed'}
    reasoning=str(uuid.uuid4())
    # The accepted selection is declared initial metadata; all subsequent admission,
    # credential issuance, acknowledgement and manager observation use real routes.
    f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED')",[i['organisation'],i['run'],reasoning,i['leader'],digest({'fixture':'prior-accepted-selection'}),observed['observation_id']])
    f.sql('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[i['organisation'],i['run'],decision['decision_id'],decision['operation_id'],i['leader'],'REPLACE_MANAGER',body['context_digest'],digest(decision),reasoning,json.dumps(decision)])
    result=f.ok('fleet.decision.apply',{'decision':decision},component='fleet-orchestration')
    assert result['kind']=='REPLACE_MANAGER'
    return result
   selected=select_replacement('2',i['manager2'])
   wait(lambda:reasoned(i['manager2']))
  else:
   proposed=f.ok('hierarchy.package.handoff.propose',{'idempotency_key':'replacement-propose','leader_generation':'1','package_ids':[i['wave_package']],'expected_generations':{i['wave_package']:'2'},'successor_id':i['manager2'],'context':{'summary':'Actual acknowledged supervisor handoff','decision_refs':[],'pending_instruction_refs':[],'native_session_refs':[]}})
   f.ok('hierarchy.package.handoff.acknowledge',{'idempotency_key':'replacement-ack','leader_generation':'1','handoff_id':proposed['handoff_id']},key='manager2')
  delegation=f.sql('SELECT manager_session_id::text,manager_generation::text,budget FROM hyperfide.fleet_delegations WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3',[i['organisation'],i['run'],i['wave_package']])[0]
  assert delegation['manager_session_id']==i['manager2'] and delegation['manager_generation']=='3' and delegation['budget']==budget,'Acknowledged fleet delegation not transferred atomically'
  try:wait(lambda:reasoned(i['manager2']),6 if baseline else 15)
  except AssertionError:
   if baseline and 'PACKAGE_' in log.read_text():return {'baseline':'EXPECTED_FAILURE','new_manager_reasoning':False}
   raise
  assert not baseline,'Historical supervisor unexpectedly scheduled replacement'
  state=json.loads((f.path/'supervisor-state/state.json').read_text())
  assert i['manager'] in state['actors'],'Retained predecessor reconciliation state was deleted'
  assert child.poll() is None,'Supervisor exited during acknowledged replacement'
  if product:
   ack=f.sql('SELECT b.credential_id::text,p.public_key_b64 FROM hyperfide.fleet_bootstrap_credentials b JOIN hyperfide.identity_principals p USING(credential_id) WHERE b.organisation_id=$1 AND b.run_id=$2 AND b.handoff_id=$3',[i['organisation'],i['run'],selected['handoff_id']])[0]
   scope={'delegation_id':i['wave_package'],'manager_generation':'3','handoff_id':selected['handoff_id']}
   digest=lambda value:'sha256:'+hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
   ackkey=f.path/'supervisor-state'/('actor-'+i['manager2']+'.scope-'+digest({'cohort_generation':'1','scope':scope})[7:]+'.key.pem')
   f.keys['retained-ack']={'path':ackkey,'public_key_b64':ack['public_key_b64']}
   ackinput={'idempotency_key':'fleet-manager-handoff:'+selected['handoff_id'],'leader_generation':'1','handoff_id':selected['handoff_id']}
   status,replayed=f.invoke('hierarchy.package.handoff.acknowledge',ackinput,component='3.1',key='retained-ack',credential=ack['credential_id'])
   assert status==200 and replayed.get('ok') is True,'Committed acknowledgement lost-response replay denied'
   status,denied=f.invoke('fleet.observe',{'binding':state['actors'][i['manager2']]['binding'],'after':None,'limit':100},component='fleet-orchestration',key='retained-ack',credential=ack['credential_id'])
   assert denied.get('ok') is False and denied.get('error',{}).get('code')=='AUTH_SCOPE_DENIED','ACK-only credential granted manager work'
   prior=len(reasoned(i['manager']))
   select_replacement('3',i['manager'])
   wait(lambda:len(reasoned(i['manager']))>prior)
   restored=f.sql('SELECT manager_session_id::text,manager_generation::text,budget FROM hyperfide.fleet_delegations WHERE organisation_id=$1 AND run_id=$2 AND package_id=$3',[i['organisation'],i['run'],i['wave_package']])[0]
   assert restored['manager_session_id']==i['manager'] and restored['manager_generation']=='4' and restored['budget']==budget,'Cached former owner did not recover new scope'
  return {'replacement_reasoned':True,'predecessor_state_retained':True,'budget_preserved':True,'actual_signed_handoff':True,'supervisor_delivered_ack':product,'ack_only_replay_and_scope':product,'cached_former_owner_reenrolled':product,'selection_origin':'DECLARED_HISTORICAL_DECISION' if product else 'SIGNED_HIERARCHY_PROPOSAL'}
 finally:
  if child and child.poll() is None:child.terminate();child.wait(timeout=15)
  if f:f.close()

def main():
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 out=ROOT/'build/fleet/manager-replacement';out.mkdir(parents=True,exist_ok=True)
 report={'status':'FAIL','scope':'signed-TLS-PostgreSQL-handoff-and-actual-supervisor','runtime_qualification':False}
 try:
  campaigns=[('product',False)] if os.environ.get('HF_MANAGER_REPLACEMENT_PRODUCT_ONLY')=='1' else [('baseline',True),('fixed',False),('product',False)]
  for name,old in campaigns:
   folder=out/name
   if folder.exists():shutil.rmtree(folder)
   folder.mkdir();report[name]=campaign(folder,old,name=='product')
  report['status']='PASS'
  report['inputs']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__).resolve(),ROOT/'core/control-plane/src/fleet-supervisor.ts',ROOT/'core/control-plane/src/hierarchy/packages.ts']}
  report['logs']={name:hashlib.sha256((out/name/'supervisor.log').read_bytes()).hexdigest() for name,_ in campaigns}
  report['runtime_artifacts']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for name,_ in campaigns for p in (out/name/'runtime/core/control-plane').rglob('*') if p.is_file() and (p.name in ['fleet-supervisor.js','fleet_bootstrap.js','fleet_orchestration.js','fleet_manager_handoff.js','packages.js','0728-fleet-manager-handoff.sql'])}
  report['baseline_revision']='519de0fec2865fac3bd641e38af3880b831077b4'
 except Exception as exc:report['error']=str(exc)[:1800]
 (out/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return int(report['status']!='PASS')
if __name__=='__main__':raise SystemExit(main())
