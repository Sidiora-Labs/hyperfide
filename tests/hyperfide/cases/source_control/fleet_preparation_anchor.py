#!/usr/bin/env python3
"""Actual PG accounting selection; admitted owner history is fixture input, no native execution proof."""
import importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
s=importlib.util.spec_from_file_location('anchor_assignment',ROOT/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(s);s.loader.exec_module(a)
uid,sha,insert=a.uid,a.sha,a.insert

def setup(f):
 a.adoption.native_profiles(f)
 i=f.ids;pin=sha(b'CONTROLLED_CONFIG_ONLY_NOT_EXECUTED')
 recipe={'pool_id':i['pool'],'configuration_digest':pin,'profile_id':i['profile'],'preparation_digest':f.preparation,'native_path':'/component/native','native_digest':pin,'manifest_path':'/component/manifest.json','secret_path':'/component/grant.json','files':[{'artifact_id':uid(),'storage_kind':'object','digest':pin,'size_bytes':'1','target':'/component/native','mode':'0500'}],'allowed_actions':['identity.describe'],'grant_ttl_seconds':300,'native_template':{},'install_template':{}}
 file=f.path/'anchor-bootstrap-config.json';file.write_text(json.dumps({'schema_version':1,'origin':'https://localhost','ca_file':'/component/ca.pem','state_root':'/component/state','pools':[recipe]}));file.chmod(0o600);f.env['HF_PROVIDER_BOOTSTRAP_CONFIG_FILE']=str(file)

def main():
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=a.AssignmentFixture(extra_components=a.component_closure(['fleet-orchestration','fleet-manager-effects']),extra_setup=setup)
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']]
  f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':__import__('socket').gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
  beta_sandbox=uid();beta_boot=uid()
  source=f.sql('SELECT * FROM hyperfide.sandboxes WHERE id=$1',[i['sandbox']])[0];source['id']=beta_sandbox;source['native_sandbox_id']='anchor-beta-'+beta_sandbox
  for k in ['created_at','updated_at']:source.pop(k,None)
  insert(f,'sandboxes',source)
  beta_boot=f.sql('SELECT boot_id::text FROM hyperfide.sandbox_boots WHERE sandbox_id=$1',[beta_sandbox])[0]['boot_id']
  configuration=sha(b'CONTROLLED_PRIOR_POOL_CONFIGURATION');insert(f,'provider_pool_configurations',{'organisation_id':i['organisation'],'pool_id':i['pool'],'configuration_digest':configuration,'document':{'controlled_prior_config_input':True}})
  for sandbox,boot_id in [(i['sandbox'],i['boot']),(beta_sandbox,beta_boot)]:
   intent=uid();pin=sha(intent.encode());native=f.sql('SELECT native_sandbox_id FROM hyperfide.sandboxes WHERE id=$1',[sandbox])[0]['native_sandbox_id']
   insert(f,'provisioning_intents',{**scope,'id':intent,'pool_id':i['pool'],'sandbox_id':sandbox,'configuration_digest':configuration,'kind':'CREATE','preparation_purpose':'PREPARATION','profile_id':i['profile'],'request_key':intent,'request_digest':pin,'payload_digest':pin,'operation':{'controlled_prior_create_input':True},'state':'ACKNOWLEDGED','native_sandbox_id':native,'boot_generation':1})
   descriptor={'install_template':{'schema_version':2},'controlled_prior_ready_input':True};receipt={'controlled_prior_ready_input':True,'slots':[]}
   insert(f,'provider_native_bootstraps',{**scope,'intent_id':intent,'id':intent,'pool_id':i['pool'],'sandbox_id':sandbox,'boot_id':boot_id,'boot_generation':1,'native_sandbox_id':native,'configuration_digest':configuration,'profile_id':i['profile'],'preparation_digest':f.preparation,'descriptor_digest':a.digest(descriptor),'descriptor':descriptor,'grant_id':uid(),'binding_operation_id':uid(),'grant_operation_id':uid(),'enrollment_operation_id':uid(),'secret_ref':'/component/not-read','verifier':pin,'process_id':'CONTROLLED_PRIOR_READY_INPUT','state':'READY','receipt':receipt,'receipt_digest':a.digest(receipt)})
  for package,manager,tasks,sandbox in [(i['package'],i['manager'],[i['task_a']],i['sandbox']),(i['wave_package'],i['manager2'],[i['task_b']],beta_sandbox)]:
   insert(f,'fleet_delegations',{**scope,'package_id':package,'manager_session_id':manager,'manager_generation':2,'leader_generation':1,'budget':{'task_ids':tasks,'allowed_actions':['REUSE_SANDBOX','PROVISION_SANDBOX'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':5,'max_concurrent_workers':1},'decision_id':uid()})
   operation,decision,observation,reason=[uid() for _ in range(4)];context=sha(operation.encode());binding={'actor_id':manager,'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':package,'manager_generation':'2'};body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':context,'action':'PROVISION_SANDBOX','input':{'component_history':True},'input_digest':a.digest({'component_history':True}),'expected_version':'0','rationale_summary':'Declared admitted sandbox ownership input, no provider outcome'}
   cohort=f.sql('SELECT id::text,cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':manager,'cohort_generation':int(cohort['cohort_generation']),'context_digest':context,'body':{'component_history':True}})
   insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':manager,'request_digest':context,'observation_id':observation,'state':'COMPLETED','result':{'component_history':True}})
   insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':manager,'action':'PROVISION_SANDBOX','context_digest':context,'payload_digest':a.digest(body),'reasoning_id':reason,'body':body})
   insert(f,'fleet_effect_receipts',{**scope,'operation_id':operation,'decision_id':decision,'payload_digest':a.digest(body),'result':{'kind':'REUSE_SANDBOX','delegation_id':package,'sandbox_id':sandbox,'boot_generation':'1'}})
   if package==i['wave_package']:beta_sandbox=sandbox
  principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['credential_id']==i['operator'])
  body="""
const {authenticatedInvocation}=await import('./core/control-plane/dist/transport/protocol.js');
const {resolveBootstrapInstallTask}=await import('./core/control-plane/dist/providers/bootstrap_install.js');
const i=authenticatedInvocation({principal:data.principal,signal:new AbortController().signal,guard:async()=>{}});
const task=await resolveBootstrapInstallTask(tx,i,{sandbox_id:data.sandbox,boot_generation:data.boot_generation??'1',boot_id:data.boot_id,intent_id:data.intent_id??null},{schema_version:2},'preparation');return task;
"""
  checks=[]
  binding={'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}
  f.ok('fleet.session.bind',{'binding':binding},key='manager',component='fleet-orchestration')
  def signed_reuse(anchor=None,code=None):
   operation,decision,observation,reason=[uid() for _ in range(4)];value={'sandbox_id':i['sandbox'],'boot_generation':'1','pool_id':i['pool'],'provider_id':'fixture','profile_id':i['profile']}
   if anchor is not None:value['preparation_task_id']=anchor
   generation=f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE session_id=$1',[i['manager']])[0]['plan_generation'];context=sha(operation.encode());body={'schema_version':1,'kind':'hyperfide.fleet-decision','operation_id':operation,'decision_id':decision,'run_id':i['run'],**binding,'source_revision':'git:'+f.source,'spec_revision':i['accepted_spec'],'context_digest':context,'action':'REUSE_SANDBOX','input':value,'input_digest':a.digest(value),'expected_version':generation,'rationale_summary':'Declared modeldecision input; signed API accounting boundary, no provider execution'}
   insert(f,'fleet_observations',{**scope,'id':observation,'actor_id':i['manager'],'cohort_generation':int(cohort['cohort_generation']),'context_digest':context,'body':{'component_history':True}});insert(f,'fleet_reasoning',{**scope,'id':reason,'actor_id':i['manager'],'request_digest':context,'observation_id':observation,'state':'COMPLETED','result':{'component_history':True}});insert(f,'fleet_decisions',{**scope,'id':decision,'operation_id':operation,'actor_id':i['manager'],'action':'REUSE_SANDBOX','context_digest':context,'payload_digest':a.digest(body),'reasoning_id':reason,'body':body})
   before=f.sql('SELECT count(*)::int n FROM hyperfide.fleet_effect_receipts')[0]['n'];result=f.invoke('fleet.decision.apply',{'decision':body},key='manager',component='fleet-orchestration')[1]
   if code:
    assert result.get('error',{}).get('code')==code,result
    assert f.sql('SELECT count(*)::int n FROM hyperfide.fleet_effect_receipts')[0]['n']==before
   else:
    assert result.get('ok') is True,result
    assert result['result']['preparation_task_id']==(anchor or i['task_a']),result
   return result
  def resolve(sandbox,expected=None,code=None):
   result=f.primary(body,{'principal':principal,'sandbox':sandbox,'boot_id':i['boot'] if sandbox==i['sandbox'] else beta_boot})
   if code:assert result.get('error',{}).get('code')==code,result
   else:assert result.get('result',{}).get('task_id')==expected,result
   return result
  resolve(i['sandbox'],i['task_a']);resolve(beta_sandbox,i['task_b']);checks += ['alpha-current-owner','beta-shared-pool-current-owner']
  f.sql("UPDATE hyperfide.fleet_delegations SET budget=jsonb_set(budget,'{task_ids}',$2::jsonb) WHERE package_id=$1",[i['package'],json.dumps([i['task_a'],i['task_overlap']])])
  resolve(i['sandbox'],code='BOOTSTRAP_INSTALL_TASK_SELECTION_REQUIRED');checks.append('ambiguous-owner-refused')
  f.sql("UPDATE hyperfide.fleet_delegations SET budget=jsonb_set(budget,'{task_ids}',$2::jsonb) WHERE package_id=$1",[i['package'],json.dumps([i['task_a']])])
  signed_reuse();checks.append('signed-reuse-sole-fallback')
  f.sql("UPDATE hyperfide.fleet_delegations SET budget=jsonb_set(budget,'{task_ids}',$2::jsonb) WHERE package_id=$1",[i['package'],json.dumps([i['task_a'],i['task_overlap']])])
  signed_reuse(code='BOOTSTRAP_INSTALL_TASK_SELECTION_REQUIRED');signed_reuse(i['task_b'],code='BOOTSTRAP_INSTALL_TASK_SCOPE');signed_reuse(i['task_overlap']);checks += ['signed-reuse-ambiguous-atomic','signed-reuse-crosswave-atomic','signed-reuse-explicit-accepted']
  direct="""
const {authenticatedInvocation}=await import('./core/control-plane/dist/transport/protocol.js');const {resolveFleetPreparationAccountingTask}=await import('./core/control-plane/dist/preparation/fleet_preparation_anchor.js');
const i=authenticatedInvocation({principal:data.principal,signal:new AbortController().signal,guard:async()=>{}});return resolveFleetPreparationAccountingTask(tx,i,data.selection);
"""
  def selection(tasks,anchor=None,code=None):
   value={'package_id':i['package'],'task_ids':tasks}
   if anchor is not None:value['preparation_task_id']=anchor
   r=f.primary(direct,{'principal':principal,'selection':value})
   if code:assert r.get('error',{}).get('code')==code,r
   else:assert r.get('result')=={'task_id':anchor,'selection_source':'EXPLICIT_PREPARATION_TASK'},r
  selection([i['task_a'],i['task_overlap']],i['task_overlap']);checks.append('explicit-multiple-accepted-anchor')
  selection([i['task_a']],i['task_b'],'BOOTSTRAP_INSTALL_TASK_SCOPE');checks.append('cross-wave-anchor-refused')
  selection([i['task_a'],i['task_b']],i['task_a'],'BOOTSTRAP_INSTALL_OWNER');checks.append('cross-package-budget-refused')
  selection([i['task_missing']],i['task_missing'],'BOOTSTRAP_INSTALL_TASK_UNACCEPTED');checks.append('unaccepted-anchor-refused')
  f.sql('UPDATE hyperfide.fleet_delegations SET manager_generation=3 WHERE package_id=$1',[i['package']]);resolve(i['sandbox'],code='BOOTSTRAP_INSTALL_OWNER');checks.append('stale-delegation-generation-refused')
  stale=dict(principal,deployment_epoch=uid());result=f.primary(body,{'principal':stale,'sandbox':beta_sandbox,'boot_id':beta_boot});assert result.get('error',{}).get('code')=='BOOTSTRAP_INSTALL_OWNER',result;checks.append('stale-authority-epoch-refused')
  for bad in [{'boot_id':uid()},{'boot_generation':'2'}]:
   r=f.primary(body,{'principal':principal,'sandbox':beta_sandbox,'boot_id':beta_boot,**bad});assert r.get('error',{}).get('code')=='BOOTSTRAP_INSTALL_OWNER',r
  checks.append('stale-boot-identity-refused')
  legacy=body.replace("{schema_version:2}","{schema_version:1,preparation:{task_key:data.task_key}}")
  key=f.sql('SELECT task_key FROM hyperfide.tasks WHERE id=$1',[i['task_a']])[0]['task_key'];r=f.primary(legacy,{'principal':principal,'sandbox':beta_sandbox,'task_key':key});assert r.get('result')=={'task_id':i['task_a'],'selection_source':'PINNED_TASK_KEY'},r;checks.append('legacy-pinned-task-key-preserved')
  parser="""
const {validateBootstrapInstallTemplate}=await import('./core/control-plane/dist/providers/bootstrap_install.js');
validateBootstrapInstallTemplate(data.template);for(const schema_version of ['1','2',true]){try{validateBootstrapInstallTemplate({...data.template,schema_version});throw Error('ACCEPTED_MALFORMED_SCHEMA')}catch(e){if(e.code!=='BOOTSTRAP_INSTALL_TEMPLATE')throw e;}}return {invalid_schema_versions_refused:3};
"""
  template={'schema_version':2,'input_digest':sha(b'parser'),'environment_id':'component','environment_generation':1,'preparation':{'task_selector':'CURRENT_SANDBOX_DELEGATION','deadline_ms':1000,'slot_key':'prep'},'verification':{'task_selector':'CURRENT_SANDBOX_DELEGATION','deadline_ms':1000,'slot_key':'test'},'source':{'repository_key':i['repository'],'source_object_id':f.source,'source_tree_id':'b'*40,'source_manifest_digest':sha(b'source')},'staging':[{'role':'fleet.package','artifact_id':uid(),'storage_kind':'object','digest':sha(b'package'),'size_bytes':'0'}],'timeout_ms':1000}
  parsed=f.primary(parser,{'template':template});assert parsed.get('result')=={'invalid_schema_versions_refused':3},parsed;checks.append('strict-template-schema-type')
  manager_principal=next(p for p in json.loads(f.identity_config.read_text())['principals'] if p['actor_id']==i['manager'])
  f.sql("UPDATE hyperfide.identity_principals SET state='REVOKED' WHERE credential_id=$1",[manager_principal['credential_id']]);signed_reuse(i['task_a'],code='AUTH_REVOKED');checks.append('signed-revoked-manager-refused-atomic')
  counts=f.sql('SELECT (SELECT count(*) FROM hyperfide.attempts)::int attempts,(SELECT count(*) FROM hyperfide.hierarchy_execution_packets)::int packets,(SELECT count(*) FROM hyperfide.resource_job_allocations)::int allocations')[0];assert counts=={'attempts':0,'packets':0,'allocations':0},counts
  print(json.dumps({'status':'PASS','scope':'ACTUAL_PG_PRODUCTION_OWNER_AND_ACCOUNTING_RESOLVERS_CONTROLLED_ADMITTED_OWNER_HISTORY','assertions':checks,'coding_allocations':counts,'public_signed_reuse':'EXERCISED','public_signed_provision':'NOT_EXERCISED','native_provider_qualification':'NOT_CLAIMED'}),flush=True)
  return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
