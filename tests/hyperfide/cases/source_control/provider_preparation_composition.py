#!/usr/bin/env python3
"""Actual provisioner service/registry startup: fleet configuration cannot omit its executor pump."""
import json,os,shutil,subprocess,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
def main():
 with tempfile.TemporaryDirectory(prefix='hf-preparation-composition-') as area:
  root=Path(area);policy=root/'policy.json';revision='isolated-composition-boundary'
  policy.write_text(json.dumps({'schema_version':1,'programme_id':str(uuid.uuid4()),'repository':'fixture/composition','spec_revision':revision,'policy_revision':1,'status':'ACTIVE','approval':{'decision':'APPROVED','record_id':'controlled-component-policy','spec_revision':revision,'policy_revision':1},'allowed_roles':['provisioner'],'allowed_actions':['programme.provision','programme.describe']}));policy.chmod(0o600)
  def components(name,ids):
   directory=root/name;directory.mkdir()
   def add(ident):
    target=directory/(ident+'.json')
    if target.exists():return
    source=ROOT/'core/control-plane/components'/(ident+'.json');value=json.loads(source.read_text());shutil.copyfile(source,target)
    for dependency in value['requires']:add(dependency)
   for ident in ids:add(ident)
   return directory
  minimal=components('legacy',['1.4']);executor=components('executor',['12.4-executor'])
  def run(directory,extra):
   env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','TZ','LD_LIBRARY_PATH']};env.update(extra)
   return subprocess.run(['node',str(ROOT/'core/control-plane/dist/provisioner.js'),'--policy',str(policy),'--spec-revision',revision,'--components',str(directory),'--module-root',str(ROOT/'core/control-plane/dist')],input=json.dumps({'id':'legacy-probe','component':'system','action':'system.describe','input':{}})+'\n',text=True,capture_output=True,env=env,cwd=root,timeout=20)
  legacy=run(minimal,{})
  assert legacy.returncode==0 and json.loads(legacy.stdout.splitlines()[-1])['ok'],('legacy',legacy.returncode,legacy.stderr)
  results=[]
  for name,directory,extra,expected in [
   ('missing-pump',minimal,{'HF_PROVIDER_BOOTSTRAP_CONFIG_FILE':str(root/'fleet.json')},'FLEET_PREPARATION_EXECUTOR_REQUIRED'),
   ('missing-config',executor,{'HF_PROVIDER_BOOTSTRAP_CONFIG_FILE':str(root/'fleet.json')},'RUNNER_EXECUTOR_CONFIG_REQUIRED'),
   ('relative-config',executor,{'HF_PROVIDER_BOOTSTRAP_CONFIG_FILE':str(root/'fleet.json'),'HF_RUNNER_EXECUTOR_CONFIG_FILE':'relative.json'},'RUNNER_EXECUTOR_CONFIG_REQUIRED')]:
   result=run(directory,extra);errors=[json.loads(line)['error']['code'] for line in result.stderr.splitlines() if line.startswith('{') and '"error"' in line]
   assert result.returncode==1 and errors==[expected] and not result.stdout,(name,result.returncode,result.stdout,result.stderr)
   results.append({'case':name,'error_code':errors[0],'exit_code':result.returncode})
  print(json.dumps({'status':'PASS','scope':'actual provisioner process and ComponentRegistry pre-import admission; no provider/native/runtime job qualification','runtime':subprocess.check_output(['node','--version'],text=True).strip(),'legacy_service_started':True,'refusals':results,'provider_live':'UNRUN','native_execution':'UNRUN'}));return 0
if __name__=='__main__':raise SystemExit(main())
