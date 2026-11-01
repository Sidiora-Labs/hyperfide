#!/usr/bin/env python3
"""Real TLS/PG handoff and supervisor fairness over explicitly seeded fleet delegation.

No model decision, native worker execution or provider qualification is asserted.
"""
import hashlib,importlib.util,json,os,shutil,signal,socket,subprocess,sys,tempfile,time,traceback,uuid
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

def seed_sql(f,query,values):
 for attempt in range(3):
  try:return f.sql(query,values)
  except AssertionError as error:
   if attempt==2 or not any(code in str(error) for code in ['40001','40P01']):raise
   time.sleep(.05)

def transpile(source,target):
 script="const fs=require('fs'),ts=require(process.argv[1]);const r=ts.transpileModule(fs.readFileSync(process.argv[2],'utf8'),{reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}});if(r.diagnostics.some(d=>d.category===ts.DiagnosticCategory.Error)){console.error(ts.formatDiagnosticsWithColorAndContext(r.diagnostics,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:f=>f,getNewLine:()=>String.fromCharCode(10)}));process.exit(1)}fs.writeFileSync(process.argv[3],r.outputText)"
 subprocess.run(['node','-e',script,str(ROOT/'node_modules/typescript'),str(source),str(target)],check=True,capture_output=True)

def campaign(folder,baseline=False,product=False,refusal=False):
 runtime=folder/'runtime';shutil.copytree(Path(os.environ.get('HF_MANAGER_REPLACEMENT_RUNTIME_ROOT',str(ROOT/'build/fleet/local-runtime-manager-qualification-install'))),runtime,symlinks=True)
 identity_fixture.ROOT=runtime
 dist=runtime/'core/control-plane/dist'
 if not refusal:
  transpile(ROOT/'core/control-plane/src/hierarchy/packages.ts',dist/'hierarchy/packages.js')
  for module in ['agents/fleet_orchestration','agents/fleet_bootstrap','agents/fleet_manager_handoff','scheduler/claim']:
   transpile(ROOT/('core/control-plane/src/'+module+'.ts'),dist/(module+'.js'))
  shutil.copyfile(ROOT/'contracts/fleet/index.mjs',dist/'contracts/fleet/index.mjs')
  shutil.copyfile(ROOT/'core/control-plane/migrations/0728-fleet-manager-handoff.sql',runtime/'core/control-plane/migrations/0728-fleet-manager-handoff.sql')
 source=ROOT/'core/control-plane/src/fleet-supervisor.ts'
 if refusal and baseline:source=Path(os.environ['HF_SUPERVISOR_REFUSAL_BASELINE'])
 if baseline and not refusal:
  source=folder/'baseline.ts';source.write_bytes(subprocess.check_output(['git','show','519de0fec2865fac3bd641e38af3880b831077b4:core/control-plane/src/fleet-supervisor.ts'],cwd=ROOT))
 if refusal:
  shutil.copyfile(source,runtime/'core/control-plane/src/fleet-supervisor.ts')
  built=subprocess.run(['npm','run','build'],cwd=runtime/'core/control-plane',capture_output=True,text=True)
  (folder/'build.log').write_text(built.stdout+built.stderr)
  assert built.returncode==0,built.stderr[-1600:]+built.stdout[-1600:]
 else:transpile(source,dist/'fleet-supervisor.js')
 f=None;child=None
 try:
  def setup(f):
   load_factory()(f)
   f.env['HYPERFIDE_FLEET_HOST_ID']=socket.gethostname()
  f=hierarchy_type()(extra_components=component_closure(['fleet-orchestration','3.4']),bootstrap=False,seed_historical_runtime=False,parent_managers=True,extra_setup=setup)
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
   primarykey=f.path/'bootstrap-primary.pem';subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(primarykey)],check=True,capture_output=True);primarykey.chmod(0o600)
   config['primary']={'session_id':i['leader'],'credential_file':str(f.path/'actual-primary.json'),'key_file':str(primarykey)}
  cfg=f.path/'replacement.json';cfg.write_text(json.dumps(config));cfg.chmod(0o600)
  if refusal:
   import base64
   key=f.path/'scope-limited-primary.pem';subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(key)],check=True,capture_output=True);key.chmod(0o600)
   public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
   credential=str(uuid.uuid4())
   f.seed_fixture_principal({'credential_id':credential,'organisation_id':i['organisation'],'run_id':i['run'],'actor_id':i['leader'],'role':'LEADER','public_key_b64':base64.urlsafe_b64encode(public[-32:]).decode().rstrip('='),'deployment_epoch':i['epoch'],'allowed_actions':[action for action in f.actions if action!='fleet.session.reason'],'expires_at':time.strftime('%Y-%m-%dT%H:%M:%S.000Z',time.gmtime(time.time()+600))})
   primary=Path(refs[0]['credential_file']);record=json.loads(primary.read_text());record.update(credential_id=credential,key_file=str(key));primary.write_text(json.dumps(record));primary.chmod(0o600)
  log=folder/'supervisor.log'
  with log.open('w') as stream:
   child=subprocess.Popen(['node',str(dist/'fleet-supervisor.js'),'--config',str(cfg)],env=f.env,cwd=runtime,stdout=stream,stderr=stream)
  def reasoned(actor):return f.sql('SELECT id FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND actor_id=$3',[i['organisation'],i['run'],actor])
  if refusal:
   wait(lambda:'decision_refused' in log.read_text())
   try:wait(lambda:reasoned(i['manager']),5 if baseline else 15)
   except AssertionError:
    if baseline:
     assert 'AUTH_SCOPE_DENIED' in log.read_text() and not reasoned(i['manager'])
     return {'baseline':'EXPECTED_FAILURE','manager_starved':True}
    raise
   assert not baseline,'Pre-fix supervisor unexpectedly isolated Primary refusal'
   saved=json.loads((f.path/'supervisor-state/state.json').read_text())
   wait(lambda:json.loads((f.path/'supervisor-state/state.json').read_text())['pending'] is None)
   saved=json.loads((f.path/'supervisor-state/state.json').read_text())
   assert saved['actors'][i['leader']]['reasoning'] is None
   assert not reasoned(i['leader']) and child.poll() is None
   assert not f.sql('SELECT id FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',[i['organisation'],i['run']])
   return {'definitive_primary_refusal_isolated':True,'manager_reasoning_persisted':True,'no_invented_decision':True,'pending_clear':True,'scope':'ACTUAL_SIGNED_TLS_POSTGRESQL_NO_MODEL_INFERENCE'}
  wait(lambda:reasoned(i['manager']))
  if product:
   retained_decisions=[]
   def select_replacement(expected,successor,initial=False):
    binding={'actor_id':i['leader'],'actor_role':'PRIMARY','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':None,'manager_generation':None}
    observed=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},component='fleet-orchestration')
    body=f.sql('SELECT body,context_digest FROM hyperfide.fleet_observations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],observed['observation_id']])[0]
    action={'package_id':i['wave_package'],'expected_generation':expected,'successor_id':successor,'context':{'summary':'Declared preexisting Primary selection for isolated delivery boundary','decision_refs':[],'pending_instruction_refs':[],'native_session_refs':[]}}
    if initial:action={'package_id':i['package2'],'expected_generation':expected,'manager_session_id':successor,'budget':budget}
    digest=lambda value:'sha256:'+hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    decision={'schema_version':1,'kind':'hyperfide.fleet-decision','decision_id':str(uuid.uuid4()),'operation_id':str(uuid.uuid4()),'run_id':i['run'],**binding,'source_revision':'git:'+('a'*40),'spec_revision':i['spec'],'context_digest':body['context_digest'],'action':'DELEGATE_WAVE' if initial else 'REPLACE_MANAGER','input':action,'input_digest':digest(action),'expected_version':str(f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3',[i['organisation'],i['run'],i['leader']])[0]['plan_generation']),'rationale_summary':'Explicit historical decision fixture; no actual model inference claimed'}
    reasoning=str(uuid.uuid4())
    # The accepted selection is declared initial metadata; all subsequent admission,
    # credential issuance, acknowledgement and manager observation use real routes.
    seed_sql(f,"INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED')",[i['organisation'],i['run'],reasoning,i['leader'],digest({'fixture':'prior-accepted-selection'}),observed['observation_id']])
    seed_sql(f,'INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[i['organisation'],i['run'],decision['decision_id'],decision['operation_id'],i['leader'],decision['action'],body['context_digest'],digest(decision),reasoning,json.dumps(decision)])
    retained_decisions.append(decision)
    result=f.ok('fleet.decision.apply',{'decision':decision},component='fleet-orchestration')
    if not initial:assert result['kind']=='REPLACE_MANAGER'
    return result
   f.ok('hierarchy.package.configure',{'idempotency_key':'occupied-config','leader_generation':'1','package_id':i['package'],'feature_key':'alpha','allocation_policy':'WAVE'})
   f.ok('hierarchy.package.assign',{'idempotency_key':'occupied-assign','leader_generation':'1','package_id':i['package'],'expected_generation':'1','manager_session_id':i['manager2']})
   f.ok('hierarchy.package.configure',{'idempotency_key':'initial-negative-config','leader_generation':'1','package_id':i['package2'],'feature_key':'alpha','allocation_policy':'WAVE'})
   try:select_replacement('1',i['manager2'],initial=True)
   except AssertionError as error:assert 'FLEET_MANAGER_ALREADY_ASSIGNED' in str(error)
   else:raise AssertionError('Initial delegation admitted an occupied manager')
   before_handoffs=f.sql('SELECT id FROM hyperfide.hierarchy_handoffs WHERE organisation_id=$1 AND run_id=$2',[i['organisation'],i['run']])
   try:select_replacement('2',i['manager2'])
   except AssertionError as error:assert 'FLEET_MANAGER_ALREADY_ASSIGNED' in str(error)
   else:raise AssertionError('Already owning successor was admitted')
   assert f.sql('SELECT id FROM hyperfide.hierarchy_handoffs WHERE organisation_id=$1 AND run_id=$2',[i['organisation'],i['run']])==before_handoffs
   f.ok('hierarchy.package.transition',{'idempotency_key':'occupied-cancel','leader_generation':'1','package_id':i['package'],'package_generation':'2','from_state':'ASSIGNED','to_state':'CANCELLED','reason':'End declared occupied-successor boundary case','evidence_refs':[]})
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
  if product:
   f.ok('hierarchy.package.assign',{'idempotency_key':'multi-assign','leader_generation':'1','package_id':i['package2'],'expected_generation':'1','manager_session_id':i['manager']})
   multiple=f.ok('hierarchy.package.handoff.propose',{'idempotency_key':'multi-propose','leader_generation':'1','package_ids':[i['wave_package'],i['package2']],'expected_generations':{i['wave_package']:'4',i['package2']:'2'},'successor_id':i['manager2'],'context':{'summary':'Negative multi-package fleet binding boundary','decision_refs':[],'pending_instruction_refs':[],'native_session_refs':[]}})
   f.reject('hierarchy.package.handoff.acknowledge',{'idempotency_key':'multi-ack','leader_generation':'1','handoff_id':multiple['handoff_id']},'FLEET_HANDOFF_SCOPE',key='manager2')
   f.ok('hierarchy.package.handoff.withdraw',{'idempotency_key':'multi-withdraw','leader_generation':'1','handoff_id':multiple['handoff_id'],'reason':'End rejected multi-package boundary'})
   f.ok('hierarchy.package.transition',{'idempotency_key':'multi-cancel','leader_generation':'1','package_id':i['package2'],'package_generation':'2','from_state':'ASSIGNED','to_state':'CANCELLED','reason':'End explicit incoming multi-package fixture','evidence_refs':[]})
  if product:
   standby=str(uuid.uuid4())
   f.ok('hierarchy.supervisor.register',{'idempotency_key':'standby-register','expected_leader_generation':'1','session_id':standby,'role':'FEATURE_MANAGER','connector':'codex','account_key':'declared-standby'},component='3.4')
   standbykey=f.path/'standby.pem';subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(standbykey)],check=True,capture_output=True);standbykey.chmod(0o600)
   original_config=f.path/'previous-supervisor.json';original_config.write_bytes(cfg.read_bytes());original_config.chmod(0o600)
   extended={**config,'managers':config['managers']+[{'session_id':standby,'credential_file':str(f.path/'standby-credential.json'),'key_file':str(standbykey)}],'previous_config_file':str(original_config)}
   # Retain a genuine accepted OP inspection as a lost-response journal entry.
   inspection={'decision_id':f.sql('SELECT id::text FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2 ORDER BY created_at DESC LIMIT 1',[i['organisation'],i['run']])[0]['id']}
   operation_id=str(uuid.uuid4());payload=json.dumps({'run_id':i['run'],'component':'fleet-orchestration','action':'fleet.decision.inspect','input':inspection,'expected_version':None,'authority':None},separators=(',',':')).encode()
   import base64
   envelope={'protocol_version':1,'operation_id':operation_id,'idempotency_key':operation_id,'payload_digest':'sha256:'+hashlib.sha256(payload).hexdigest(),'correlation_id':operation_id,'causation_id':None,'payload_b64':base64.urlsafe_b64encode(payload).decode().rstrip('=')}
   status,accepted=f.request(envelope);assert status==200 and accepted.get('ok') is True
   for attempt in range(30):
    child.send_signal(signal.SIGSTOP)
    saved=json.loads((f.path/'supervisor-state/state.json').read_text())
    if saved['pending'] is None:break
    child.send_signal(signal.SIGCONT);time.sleep(.1)
   else:raise AssertionError('Could not fault the isolated supervisor at a quiescent journal boundary')
   child.kill();child.wait(timeout=15)
   saved=json.loads((f.path/'supervisor-state/state.json').read_text());assert saved['pending'] is None,'Fault boundary acquired an unresolved operation; refusing journal replacement'
   saved['pending']={'actor_id':i['operator'],'operation_id':operation_id,'component':'fleet-orchestration','action':'fleet.decision.inspect','input':inspection}
   statefile=f.path/'supervisor-state/state.json';statefile.write_text(json.dumps(saved));statefile.chmod(0o600)
   cfg.write_text(json.dumps(extended));cfg.chmod(0o600)
   baseline_source=folder/'roster-baseline.ts';baseline_source.write_bytes(subprocess.check_output(['git','show','16f383069e3fa6421a2144b88b458487af02db58:core/control-plane/src/fleet-supervisor.ts'],cwd=ROOT));transpile(baseline_source,dist/'roster-baseline.js')
   before=statefile.read_bytes();rejected=subprocess.run(['node',str(dist/'roster-baseline.js'),'--config',str(cfg),'--once'],env=f.env,cwd=runtime,capture_output=True,text=True,timeout=30)
   (folder/'roster-baseline.log').write_text(rejected.stdout+rejected.stderr)
   assert rejected.returncode==78 and any(code in rejected.stderr for code in ['FLEET_SUPERVISOR_CONFIG','FLEET_SUPERVISOR_STATE','INVALID_REQUEST']) and statefile.read_bytes()==before,'Historical source failed to reject added roster without altering journal'
   restarted=subprocess.run(['node',str(dist/'fleet-supervisor.js'),'--config',str(cfg),'--once'],env=f.env,cwd=runtime,capture_output=True,text=True,timeout=60)
   (folder/'roster-restart.log').write_text(restarted.stdout+restarted.stderr)
   assert restarted.returncode==0,restarted.stderr+restarted.stdout[-1800:]
   events=[json.loads(line) for line in restarted.stdout.splitlines()]
   reconciliation=next(n for n,event in enumerate(events) if event['event']=='reconciled' and event['operation_id']==operation_id)
   adoption=next(n for n,event in enumerate(events) if event['event']=='manager_roster_extended');assert reconciliation<adoption
   final=json.loads(statefile.read_text());history=final['configuration_history'][-1]
   assert history['previous_digest']==saved['config_digest'] and history['config_digest']==final['config_digest'] and history['added_manager_ids']==[standby]
   assert final['pending'] is None and final['leader_generation']==saved['leader_generation'] and final['cohort_generation']==saved['cohort_generation'] and set(saved['actors']).issubset(final['actors'])
   tampered={**extended,'host_id':'unapproved-other-host'};cfg.write_text(json.dumps(tampered));before=statefile.read_bytes()
   rejected=subprocess.run(['node',str(dist/'fleet-supervisor.js'),'--config',str(cfg),'--once'],env=f.env,cwd=runtime,capture_output=True,text=True,timeout=30)
   assert rejected.returncode==78 and 'FLEET_SUPERVISOR_STATE' in rejected.stderr and statefile.read_bytes()==before,'Additive roster authorization widened fixed host identity'
   i['package2']=str(uuid.uuid4())
   f.sql("INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,'component-initial-replay',3)",[i['organisation'],i['run'],i['package2']])
   f.ok('hierarchy.package.configure',{'idempotency_key':'initial-replay-config','leader_generation':'1','package_id':i['package2'],'feature_key':'gamma','allocation_policy':'WAVE'})
   admitted=select_replacement('1',i['manager2'],initial=True)
   before_replay=f.sql('SELECT owner_generation::text,manager_session_id::text FROM hyperfide.hierarchy_packages h JOIN hyperfide.feature_packages p ON p.organisation_id=h.organisation_id AND p.run_id=h.run_id AND p.id=h.package_id WHERE h.organisation_id=$1 AND h.run_id=$2 AND h.package_id=$3',[i['organisation'],i['run'],i['package2']])
   replay=f.ok('fleet.decision.apply',{'decision':retained_decisions[-1]},component='fleet-orchestration')
   assert replay['replayed'] is True and replay['manager_session_id']==admitted['manager_session_id']
   assert before_replay==f.sql('SELECT owner_generation::text,manager_session_id::text FROM hyperfide.hierarchy_packages h JOIN hyperfide.feature_packages p ON p.organisation_id=h.organisation_id AND p.run_id=h.run_id AND p.id=h.package_id WHERE h.organisation_id=$1 AND h.run_id=$2 AND h.package_id=$3',[i['organisation'],i['run'],i['package2']])

  return {'replacement_reasoned':True,'predecessor_state_retained':True,'budget_preserved':True,'actual_signed_handoff':True,'supervisor_delivered_ack':product,'ack_only_replay_and_scope':product,'cached_former_owner_reenrolled':product,'roster_restart_preserves_pending':product,'occupied_successor_refused':product,'multi_package_fleet_ack_refused':product,'initial_delegate_occupied_refused_and_replay_retained':product,'selection_origin':'DECLARED_HISTORICAL_DECISION' if product else 'SIGNED_HIERARCHY_PROPOSAL'}
 finally:
  if child and child.poll() is None:child.terminate();child.wait(timeout=15)
  if f:f.close()

def main():
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 out=ROOT/'build/fleet/manager-replacement';out.mkdir(parents=True,exist_ok=True)
 report={'status':'FAIL','scope':'signed-TLS-PostgreSQL-handoff-and-actual-supervisor','runtime_qualification':False}
 try:
  refusal=os.environ.get('HF_SUPERVISOR_REFUSAL_ONLY')=='1'
  campaigns=[('refusal-baseline',True),('refusal-fixed',False)] if refusal else [('product',False)] if os.environ.get('HF_MANAGER_REPLACEMENT_PRODUCT_ONLY')=='1' else [('baseline',True),('fixed',False),('product',False)]
  for name,old in campaigns:
   folder=out/name
   if folder.exists():shutil.rmtree(folder)
   folder.mkdir();report[name]=campaign(folder,old,name=='product',refusal)
  report['status']='PASS'
  report['inputs']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [Path(__file__).resolve(),ROOT/'core/control-plane/src/fleet-supervisor.ts',ROOT/'core/control-plane/src/hierarchy/packages.ts']}
  report['logs']={name:hashlib.sha256((out/name/'supervisor.log').read_bytes()).hexdigest() for name,_ in campaigns}
  report['runtime_artifacts']={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for name,_ in campaigns for p in (out/name/'runtime/core/control-plane').rglob('*') if p.is_file() and (p.name in ['fleet-supervisor.js','fleet_bootstrap.js','fleet_orchestration.js','fleet_manager_handoff.js','packages.js','0728-fleet-manager-handoff.sql'])}
  if refusal:report['baseline_source_digest']=hashlib.sha256(Path(os.environ['HF_SUPERVISOR_REFUSAL_BASELINE']).read_bytes()).hexdigest()
  else:report['baseline_revision']='519de0fec2865fac3bd641e38af3880b831077b4'
 except Exception as exc:report['error']=traceback.format_exc()[-1800:]
 (out/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return int(report['status']!='PASS')
if __name__=='__main__':raise SystemExit(main())
