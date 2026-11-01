#!/usr/bin/env python3
"""Actual TLS/PG initial runner registration with two pool-scoped recipe roles."""
import argparse,copy,hashlib,json,os,shutil,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import identity_fixture
from identity_fixture import IdentityFixture

def uid():return str(uuid.uuid4())
def sha(b):return 'sha256:'+hashlib.sha256(b).hexdigest()
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--manifest',type=Path,required=True);parser.add_argument('--runtime-root',type=Path,required=True);args=parser.parse_args();runtime=args.runtime_root.resolve();identity_fixture.ROOT=runtime.parents[1]
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),'--manifest',str(args.manifest.resolve()),'--runtime-root',str(runtime)],cwd=ROOT).returncode
 manifest=json.loads(args.manifest.read_text());parent=ROOT/'build/fleet/integration/private'/('pool-recipe-policy-'+uuid.uuid4().hex);parent.mkdir(mode=0o700,parents=True);checks=[];f=None
 try:
  f=IdentityFixture(extra_components=('8.2','12.1'))
  i=f.ids;org,run,epoch=i['organisation'],i['run'],i['epoch'];profile=manifest['profile']['profile_id'];preparation=manifest['digest'];repository=uid()
  f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,provider,runtime_platform,content_digest,manifest) VALUES($1,$2,'fixture','linux',$3,$4::jsonb)",[org,profile,preparation,json.dumps(manifest)])
  f.preparation=preparation
  f.sql("INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES($1,$2,$3,'recipe-policy-source','https://example.invalid/recipe-policy.git')",[org,repository,i['project']])
  coding={'pool':uid(),'sandbox':uid(),'intent':uid(),'native_sandbox_id':'coding-policy-'+uid()};test={'pool':uid(),'sandbox':uid(),'intent':uid(),'native_sandbox_id':'test-policy-'+uid()}
  f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'fixture','fixture','fixture','fixture',$3)",[org,coding['pool'],profile])
  f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)",[org,coding['sandbox'],coding['pool'],coding['native_sandbox_id'],preparation]);coding['boot']=f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[org,coding['sandbox']])[0]['boot_id']
  f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'fixture','fixture','fixture','fixture',$3)",[org,test['pool'],profile]);f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)",[org,test['sandbox'],test['pool'],test['native_sandbox_id'],preparation]);test['boot']=f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[org,test['sandbox']])[0]['boot_id']
  actions=['identity.describe','identity.runner.register','identity.runner.heartbeat','runner.registry.prepare']
  for name,bound in [('coding',coding),('test',test)]:
   i.update(bound);f.grant=uid()
   binding_reply=f.invoke('identity.binding.observe',dict(provisioning_intent_id=bound['intent'],sandbox_id=bound['sandbox'],boot_generation='1',boot_id=bound['boot'],native_sandbox_id=bound['native_sandbox_id'],observation_digest=sha(b'controlled initial resource observation'),expected_version='1'),key='provisioner')[1]
   if not binding_reply.get('ok') or not f.issue(actions=actions)[1].get('ok'):raise AssertionError('Actual finite runner grant refused')
   key='runner' if name=='coding' else 'other';enrolled=f.request(f.enrollment(key=key),key=key,endpoint='/v1/enroll',credential=f.grant)[1]
   if not enrolled.get('ok'):raise AssertionError('Actual runner enrollment refused '+str(enrolled))
   actual=enrolled['result'];f.ids[name+'_runner']=actual['credential_id'];f.keys[name+'_runner']=f.keys[key];bound['credential_id']=actual['credential_id']
  dist=runtime/'dist';node=Path(shutil.which('node')).resolve();binary=ROOT/'build/hyperfide-native'
  def pin(p):return {'path':str(p),'digest':sha(p.read_bytes())}
  common=dict(node_path=str(node),node_digest=sha(node.read_bytes()),native_path=str(binary),native_digest=sha(binary.read_bytes()),base_root=str(parent),max_stage_bytes='16777216',readiness_context=dict(artifact_id=uid(),digest=sha(b'initial-context-reference'),size_bytes='2'))
  coding_recipe=dict(common,recipe_path=str(dist/'preparation/fleet_install.js'),recipe_digest=sha((dist/'preparation/fleet_install.js').read_bytes()),readiness_kind='FLEET_MANIFEST_V1',readiness_verifier=dict(node_path=str(node),node_digest=sha(node.read_bytes()),module_path=str(dist/'preparation/fleet_readiness_probe.js'),module_digest=sha((dist/'preparation/fleet_readiness_probe.js').read_bytes()),module_closure=[pin(dist/name) for name in ['preparation/fleet_readiness_probe.js','preparation/fleet_readiness_contract.js','preparation/fleet_install_inventory.js','preparation/fleet_toolchains.js','preparation/fleet_configurations.js','preparation/fleet_client.js','transport/protocol.js','policy/programme.js','contracts/fleet/index.mjs']]))
  entry=dist/'preparation/result_recipe.js';test_recipe=dict(common,recipe_path=str(entry),recipe_digest=sha(entry.read_bytes()),sealing=dict(node_path=str(node),node_digest=sha(node.read_bytes()),script_path=str(entry),script_digest=sha(entry.read_bytes()),module_closure=[pin(dist/name) for name in ['preparation/result_recipe.js','preparation/manifests.js','preparation/effective.js','preparation/result_source_archive.js','preparation/profile_pin_inputs.js','artifacts/fleet_source_archive.js']]))
  recipes={'coding':{'environment.prepare.v1':coding_recipe},'test':{'environment.prepare.v1':test_recipe}}
  base=dict(organisation_id=org,run_id=run,authority_epoch=epoch,base_profiles=[dict(profile_id=profile,preparation_digest=preparation)])
  legacy=dict(schema_version=1,policies=[dict(base,recipes=recipes['coding'])]);v2=dict(schema_version=2,policies=[dict(base,pool_id=bound['pool'],recipes=recipes[name]) for name,bound in [('coding',coding),('test',test)]])
  policy_file=parent/'recipes.json'
  def configure(policy):
   f.stop();data=canonical(policy);policy_file.write_bytes(data);policy_file.chmod(0o600);f.env['HF_RUNNER_PREPARATION_RECIPES_FILE']=str(policy_file);f.env['HF_RUNNER_PREPARATION_RECIPES_DIGEST']=sha(data);f.start()
  def binding(name):
   bound={'coding':coding,'test':test}[name];slot,session=uid(),uid();root=parent/session
   for part in ('state','workspace','home','tmp'):(root/part).mkdir(mode=0o700,parents=True)
   f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$4,1,$5,'READY')",[org,slot,bound['sandbox'],'recipe-policy-'+slot,'TEST' if name=='test' else 'PREPARATION'])
   return dict(session_id=session,slot_id=slot,repository_id=repository,state_dir=str(root/'state'),runner_binary=str(binary),workspace_path=str(root/'workspace'),home_path=str(root/'home'),tmp_path=str(root/'tmp'),runner_binary_digest=sha(binary.read_bytes()),preparation_digest=preparation,slot_generation='1',uid=65534 if name=='coding' else 65533,gid=65534 if name=='coding' else 65533,preparation_recipes=recipes[name])
  def register(name,value):
   key=name+'_runner';status,response=f.invoke('identity.runner.register',dict(preparation_digest=preparation,inventory=[value]),key=key)
   if status!=200 or not response.get('ok'):raise AssertionError('Authenticated physical inventory report refused '+str(response))
   return f.invoke('runner.registry.prepare',value,key=key,component='12.1')
  def accepted(name,value):
   status,response=register(name,value)
   if status!=200 or not response.get('ok') or response['result'].get('ready') is not False or response['result'].get('state')!='PREPARING':raise AssertionError('Expected actual initial registration '+str(response))
  def denied(name,value,code='RUNNER_RECIPE_POLICY_INVALID'):
   status,response=register(name,value)
   if status==200 and response.get('ok') or response.get('error',{}).get('code')!=code:raise AssertionError('Expected '+code+' '+str(response))
  def check(name,run):run();checks.append(name);print(json.dumps({'type':'assertion','id':name,'actual':'PASS'}),flush=True)
  configure(legacy);first=binding('coding');test_binding=binding('test')
  check('recipe.legacy-single-authority-registration',lambda:accepted('coding',first))
  check('recipe.legacy-cannot-authorize-different-test-recipe',lambda:denied('test',test_binding))
  configure(v2);fresh=binding('coding')
  check('recipe.same-profile-coding-pool-registration',lambda:accepted('coding',fresh))
  check('recipe.same-profile-test-pool-registration',lambda:accepted('test',test_binding))
  for name,other,value in [('coding','test',fresh),('test','coding',test_binding)]:
   forged=copy.deepcopy(value);forged['preparation_recipes']=recipes[other]
   check('recipe.'+name+'-cross-pool-recipe-refused',lambda n=name,v=forged:denied(n,v))
  forged=copy.deepcopy(test_binding);forged['pool_id']=coding['pool'];check('recipe.caller-pool-chooser-refused',lambda:denied('test',forged,'INVALID_REQUEST'))
  missing=copy.deepcopy(v2);missing['policies']=missing['policies'][:1];configure(missing);check('recipe.missing-test-entry-no-fallback',lambda:denied('test',test_binding))
  duplicate=copy.deepcopy(v2);duplicate['policies'].append(copy.deepcopy(duplicate['policies'][1]));configure(duplicate);check('recipe.duplicate-actual-pool-refused',lambda:denied('test',test_binding))
  changed=copy.deepcopy(v2);changed['policies'][1]['base_profiles'][0]['preparation_digest']=sha(b'wrong-base');configure(changed);check('recipe.same-profile-wrong-preparation-refused',lambda:denied('test',test_binding))
  ambiguous=copy.deepcopy(legacy);ambiguous['policies'].append(copy.deepcopy(ambiguous['policies'][0]));configure(ambiguous);check('recipe.legacy-ambiguity-still-refused',lambda:denied('test',test_binding))
  rows=f.sql('SELECT session_id,state,preparation_recipes FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND session_id=ANY($3::uuid[])',[org,run,[fresh['session_id'],test_binding['session_id']]])
  if len(rows)!=2 or any(row['state']!='PREPARING' for row in rows):raise AssertionError('Registration fabricated execution readiness')
  receipt=dict(schema_version=1,status='PASS',assertions=checks,boundary='Actual PostgreSQL/Ed25519/HTTPS initial registration; no qualification execution or native READY claim',same_profile_id=profile,pools={name:v['pool'] for name,v in [('coding',coding),('test',test)]})
  out=ROOT/'build/fleet/integration/pool-recipe-policy-receipt.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'status':'PASS','assertions':len(checks),'receipt':str(out)}));return 0
 finally:
  if f:f.close()
  shutil.rmtree(parent,ignore_errors=True)
if __name__=='__main__':raise SystemExit(main())
