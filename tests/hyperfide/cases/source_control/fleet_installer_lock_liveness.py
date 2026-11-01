#!/usr/bin/env python3
"""Public native-context installer lock handling; real zombie, no installation/READY claim."""
import argparse,hashlib,json,os,shutil,subprocess,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
def uid():return str(uuid.uuid4())
def sha(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()
def start(pid):
 fields=Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].strip().split();return fields[0],fields[19]
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--runtime-root',type=Path,required=True);parser.add_argument('--installer-source',type=Path);args=parser.parse_args()
 assert os.getuid()==0,'Root-owned native staging input fixture required'
 owned=Path(tempfile.mkdtemp(prefix='hf-installer-lock-'));stage_parent=Path('/run/hyperfide-stage');stage_parent.mkdir(mode=0o755,parents=True,exist_ok=True);stage=stage_parent/uid();stage.mkdir(mode=0o750);child=None
 try:
  runtime=owned/'runtime';shutil.copytree(args.runtime_root.resolve(),runtime,symlinks=True);(owned/'package.json').write_text('{"type":"module"}')
  modules=args.runtime_root.resolve().parent/'node_modules'
  if modules.exists():(owned/'node_modules').symlink_to(modules,target_is_directory=True)
  if args.installer_source:
   script="const fs=require('node:fs'),module=require('node:module');fs.writeFileSync(process.argv[2],module.stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8'),{mode:'strip'}));"
   result=subprocess.run(['node','-e',script,str(args.installer_source.resolve()),str(runtime/'preparation/fleet_install.js')],capture_output=True,text=True);assert result.returncode==0,result.stderr
  repository=owned/'repository';repository.mkdir()
  files={'README.md':'Installer lock component input\n','package.json':json.dumps({'name':'installer-lock-component','version':'1.0.0','private':True}),'package-lock.json':json.dumps({'name':'installer-lock-component','version':'1.0.0','lockfileVersion':3,'packages':{'':{'name':'installer-lock-component','version':'1.0.0'}}}),'postinstall.mjs':'// No dependency command is executed by this lock-boundary case.\n'}
  for name,text in files.items():(repository/name).write_text(text)
  def git(*argv):return subprocess.check_output(['git','-C',str(repository),*argv],text=True,stderr=subprocess.DEVNULL).strip()
  git('init');git('add','.');git('-c','user.name=Component','-c','user.email=component@example.invalid','commit','-m','controlled source input');revision=git('rev-parse','HEAD')
  node=Path(shutil.which('node')).resolve();npm=Path(shutil.which('npm')).resolve();native=ROOT/'build/fleet/integration/private/retained-hyperfide-native-695cbd2b';assert native.is_file()
  environment=owned/'environment-parent'/'workspace';environment.parent.mkdir();environment_id='lock-component-'+uid();operation=stage.name
  request={'repository_path':str(repository),'repository_id':uid(),'revision':revision,'authority_epoch':uid(),'origin':'https://localhost:1','environment_root':str(environment),'environment_id':environment_id,'node_path':str(node),'node_version':subprocess.check_output([str(node),'--version'],text=True).strip().removeprefix('v'),'npm_path':str(npm),'npm_version':subprocess.check_output(['node',str(npm),'--version'],text=True).strip(),'native_path':str(native),'runtime_files':[{'path':str(file),'digest':sha(file.read_bytes())} for file in sorted(runtime.rglob('*')) if file.is_file() and file.suffix in ['.js','.mjs']],'image_digest':sha(b'CONTROLLED_DECLARED_IMAGE_INPUT')}
  env={**os.environ,'HYPERFIDE_GATE_CONTROL_DIST':str(runtime)}
  result=subprocess.run(['node',str(ROOT/'tests/hyperfide/support/fleet_interrupted_install_inputs.mjs')],input=json.dumps(request),text=True,capture_output=True,cwd=ROOT,env=env);assert result.returncode==0,result.stderr;prepared=json.loads(result.stdout)
  render=r"""
import fs from'node:fs';import{pathToFileURL}from'node:url';const d=JSON.parse(fs.readFileSync(0)),c=await import(pathToFileURL(d.runtime+'/contracts/fleet/index.mjs'));const source=d.prepared.source_config_kvx.replace(/^directory = .*$/m,'directory = '+JSON.stringify(d.environment+'/workers/0/build'));const n=c.parseNeron(source),packageText=d.prepared.package_kvx.replace(/^config_digest = .*$/m,'config_digest = '+JSON.stringify(c.digest(n))),p=c.parsePackage(packageText,{neron:n}),proof=structuredClone(d.prepared.interface_proof);proof.consumer.package_digest=c.digest(p);const plan={...d.prepared.install_plan,package_digest:c.digest(p),source_config_digest:c.digest(n),interface_proof_digest:c.digest(proof)};console.log(JSON.stringify({source,packageText,package:p,neron:n,plan,proof,plan_digest:c.digest(plan)}));
"""
  result=subprocess.run(['node','--input-type=module','-e',render],input=json.dumps({'runtime':str(runtime),'prepared':prepared,'environment':str(environment)}),text=True,capture_output=True,cwd=ROOT);assert result.returncode==0,result.stderr;rendered=json.loads(result.stdout)
  admission={'schema_version':1,'kind':'hyperfide.fleet-install-admission','operation_id':operation,'logical_operation_id':operation,'organisation_id':uid(),'run_id':uid(),'environment_id':environment_id,'environment_generation':1,'environment_root':str(environment),'sandbox_id':uid(),'boot_id':uid(),'boot_generation':'1','authority_epoch':request['authority_epoch'],'input_digest':sha(b'DECLARED_LOCAL_NATIVE_CONTEXT_INPUT'),'package_digest':rendered['plan']['package_digest'],'source_config_digest':rendered['plan']['source_config_digest'],'plan_digest':rendered['plan_digest'],'source_revision':'git:'+revision,'source_manifest_digest':prepared['source_manifest_digest'],'read_scope':rendered['neron']['workspace']['read_scope'],'write_scope':rendered['neron']['workspace']['write_scope'],'slot_bindings':[],'expires_at':'2099-01-01T00:00:00.000Z'};worker={n:rendered['package']['workers'][n+'_template'].replace('{slot}','0') for n in ['source','home','build','temporary','dirty']};admission['slot_bindings']=[{'slot':0,'worker_slot_id':uid(),'slot_generation':'1','uid':41470,'gid':41470,'worker_root':str(Path(worker['source']).parent),**worker}];admission['admission_digest']=sha(canonical(admission))
  staged={'input-manifest':{'schema_version':1,'kind':'hyperfide.fleet-install-bootstrap','admission':admission,'plan_digest':rendered['plan_digest']},'fleet.plan':rendered['plan'],'fleet.package':rendered['packageText'],'fleet.source-config':rendered['source'],'fleet.source-manifest':prepared['source_manifest'],'fleet.interfaces':prepared['interfaces'],'fleet.interface-proof':rendered['proof']};refs=[]
  for number,(role,value) in enumerate(staged.items()):
   file=stage/('input-'+str(number));file.write_bytes(value.encode() if isinstance(value,str) else canonical(value));file.chmod(0o440);refs.append({'role':role,'path':str(file)})
  context={'schema_version':1,'operation_id':operation,'job_binding':{'namespace':'FLEET_INSTALL','job_id':operation,'lease_generation':'1','input_packet_digest':admission['admission_digest']},'scope':{'sandbox_id':admission['sandbox_id'],'boot_id':admission['boot_id'],'boot_generation':'1'},'staging':refs,'out_root':str(stage/'out')};context_file=stage/'context.json';context_file.write_bytes(canonical(context));context_file.chmod(0o440)
  identity=hashlib.sha256((environment_id+':1:'+rendered['plan_digest']).encode()).hexdigest()[:24];staging=environment.parent/('.hyperfide-install-'+identity);lock=Path(str(staging)+'.lock');staging.mkdir(mode=0o700);sentinel=staging/'dirty-sentinel';sentinel.write_bytes(b'preserve dirty staging\n')
  child=os.fork()
  if child==0:os._exit(0)
  for _ in range(200):
   state,zombie_start=start(child)
   if state=='Z':break
   time.sleep(.005)
  assert state=='Z','Actual unreaped zombie required';_,live_start=start(os.getpid())
  cases=[('live',os.getpid(),live_start,'FLEET_INSTALL_BUSY'),('missing-start',os.getpid(),None,'FLEET_INSTALL_BUSY'),('malformed-start',os.getpid(),'invalid','FLEET_INSTALL_BUSY'),('zombie',child,zombie_start,'FLEET_CACHE_PATH')];observed=[]
  for name,pid,ticks,expected in cases:
   if lock.exists():shutil.rmtree(lock)
   lock.mkdir(mode=0o700);owner={'operation_id':operation,'plan_digest':rendered['plan_digest'],'pid':pid}
   if ticks is not None:owner['process_start']=ticks
   owner_file=lock/'owner.json';owner_file.write_bytes(canonical(owner));owner_file.chmod(0o600);before=owner_file.read_bytes()
   p=subprocess.run(['node',str(runtime/'preparation/fleet_install.js'),'--job-context',str(context_file)],text=True,capture_output=True,cwd=owned,timeout=30);lines=[json.loads(line) for line in p.stderr.splitlines() if line.startswith('{')];code=lines[-1]['error']['code'] if lines else None;observed.append({'case':name,'code':code,'expected':expected,'exit_code':p.returncode})
   assert p.returncode==1 and not p.stdout,(name,p.returncode,p.stdout,p.stderr)
   assert sentinel.read_bytes()==b'preserve dirty staging\n' and not Path(rendered['package']['readiness']['receipt']).exists(),'Dirty staging/receipt invariant violated'
   if code=='FLEET_INSTALL_BUSY':assert owner_file.read_bytes()==before,'Busy or malformed lock changed'
   if name=='zombie' and code=='FLEET_CACHE_PATH':assert not lock.exists(),'Recovered dead-owner lock retained'
  print(json.dumps({'status':'PASS' if all(row['code']==row['expected'] for row in observed) else 'FAIL','scope':'public installer --job-context lock boundary with declared protected input, actual unreaped child and independent downstream cache-policy refusal; no completed install/native qualification','cases':observed,'dirty_sentinel_preserved':True,'ready_receipt_created':False,'runtime':subprocess.check_output(['node','--version'],text=True).strip()}))
  return int(any(row['code']!=row['expected'] for row in observed))
 finally:
  if child:
   try:os.waitpid(child,0)
   except ChildProcessError:pass
  shutil.rmtree(stage,ignore_errors=True);shutil.rmtree(owned,ignore_errors=True)
if __name__=='__main__':raise SystemExit(main())
