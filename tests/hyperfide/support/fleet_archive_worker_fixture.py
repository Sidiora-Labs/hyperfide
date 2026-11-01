"""Controlled provider HTTP handlers backed by actual local native processes and files."""
from __future__ import annotations
import datetime,os,shlex,signal,stat,subprocess,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]

WORKER_SOURCE=b"from pathlib import Path\nimport time\nPath('src').mkdir(exist_ok=True)\nPath('src/q1.ts').write_text('export const value = 42;\\n')\nprint('actual isolated worker complete',flush=True)\ntime.sleep(0.5)\n"

class NativeArchiveWorkerHandlers:
 def __init__(self,roots,executables,environment,output_root,path_resolver=None):
  self.roots=tuple(Path(p).resolve() for p in roots);self.executables={str(Path(p).resolve()) for p in executables};self.environment=dict(environment);self.output_root=Path(output_root).resolve();self.output_root.mkdir(mode=0o700,parents=True,exist_ok=True);self.processes={};self.observations=[];self.lock=threading.Lock();self.path_resolver=path_resolver
 def checked(self,value):
  p=Path(value)
  if not p.is_absolute() or str(p)!=str(p.resolve()) or not any(p==root or root in p.parents for root in self.roots):raise PermissionError('Controlled provider path outside fixture roots')
  return p
 def execute(self,request):
  name=request['name'];command=request['command'];cwd=self.checked(request['workingDir']) if request['workingDir']!='/' else Path('/');argv=shlex.split(command);environment=dict(self.environment)
  if argv[:2]==['/usr/bin/env','-i']:
   environment={};argv=argv[2:]
   while argv and '=' in argv[0]:
    key,value=argv.pop(0).split('=',1)
    if key not in ['PATH','LANG','LD_LIBRARY_PATH'] or key=='PATH' and value!='/usr/bin:/bin' or key=='LANG' and value!='C' or key=='LD_LIBRARY_PATH' and value!='/opt/hyperfide/lib/hyperfide':raise PermissionError('Unexpected controlled archive environment')
    environment[key]=value
  if self.path_resolver:argv=[str(self.path_resolver(v)) if v.startswith('/') and v!='/' else v for v in argv]
  if not name or len(name)>128 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in name) or not argv or str(Path(argv[0]).resolve()) not in self.executables:raise PermissionError('Controlled provider executable/name outside declared fixture')
  with self.lock:
   if name in self.processes:
    if self.processes[name]['command']!=command:raise ValueError('Immutable controlled process command conflict')
    return self.describe(name)
   stdout=self.output_root/(name+'.stdout');stderr=self.output_root/(name+'.stderr')
   with stdout.open('xb') as out,stderr.open('xb') as err:
    os.chmod(stdout,0o600);os.chmod(stderr,0o600)
    child=subprocess.Popen(argv,cwd=cwd,env=environment,stdin=subprocess.DEVNULL,stdout=out,stderr=err,start_new_session=True)
   row={'child':child,'command':command,'actual_executed_argv':list(argv),'cwd':str(cwd),'stdout_path':stdout,'stderr_path':stderr,'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'completedAt':''};self.processes[name]=row
  if request.get('waitForCompletion'):child.wait(timeout=min(int(request.get('timeout') or 120),180))
  return self.describe(name)
 def describe(self,name):
  row=self.processes.get(name)
  if row is None:raise FileNotFoundError(name)
  child=row['child'];code=child.poll()
  if code is not None and not row['completedAt']:row['completedAt']=datetime.datetime.now(datetime.timezone.utc).isoformat()
  outputs=[]
  for key in ['stdout_path','stderr_path']:
   p=row[key]
   if p.stat().st_size>16*1024*1024:raise ValueError('Actual process output exceeds controlled HTTP bound')
   outputs.append(p.read_bytes().decode('utf8',errors='replace'))
  return {'name':name,'pid':str(child.pid),'command':row['command'],'workingDir':row['cwd'],'status':'running' if code is None else 'completed' if code==0 else 'failed','exitCode':0 if code is None else code,'stdout':outputs[0],'stderr':outputs[1],'logs':outputs[0]+outputs[1],'startedAt':row['startedAt'],'completedAt':row['completedAt'],'keepAlive':True}
 def stop(self,name):
  row=self.processes.get(name)
  if row is None:raise FileNotFoundError(name)
  if row['child'].poll() is None:os.killpg(row['child'].pid,signal.SIGTERM)
  return self.describe(name)
 def read(self,filename):
  p=self.checked(filename);s=p.lstat()
  if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_size>96*1024*1024:raise PermissionError('Controlled provider file is not bounded regular bytes')
  return p.read_bytes()
 def listing(self,dirname):
  p=self.checked(dirname)
  if not p.is_dir():raise NotADirectoryError(dirname)
  files=[];subdirectories=[]
  for child in sorted(p.iterdir()):
   s=child.lstat()
   if stat.S_ISDIR(s.st_mode):subdirectories.append({'name':child.name,'path':str(child)})
   elif stat.S_ISREG(s.st_mode):files.append({'name':child.name,'path':str(child),'size':s.st_size,'owner':str(s.st_uid),'group':str(s.st_gid),'permissions':oct(stat.S_IMODE(s.st_mode))[2:],'lastModified':datetime.datetime.fromtimestamp(s.st_mtime,datetime.timezone.utc).isoformat()})
  return {'name':p.name,'path':str(p),'files':files,'subdirectories':subdirectories}
 def close(self):
  for row in self.processes.values():
   child=row['child']
   if child.poll() is None:
    os.killpg(child.pid,signal.SIGTERM)
    try:child.wait(timeout=5)
    except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=5)
 def process_handler(self,method,identifier,body):
  try:
   if method=='POST' and identifier is None:return 200,self.execute(body)
   if method=='GET' and identifier is not None:return 200,self.describe(identifier)
   if method=='DELETE' and identifier is not None:return 200,self.stop(identifier)
   if method=='GET' and identifier is None:return 200,[self.describe(name) for name in self.processes]
   return 405,{'message':'Controlled provider method not admitted'}
  except FileNotFoundError:return 404,{'message':'Actual local process absent'}
  except (PermissionError,ValueError,KeyError) as error:
   self.observations.append({'method':method,'identifier':identifier,'error':str(error)})
   return 409,{'message':str(error)}
 def resolve_path(self,filename):return self.checked(str(self.path_resolver(filename)) if self.path_resolver else filename)

def prepare_manifest_worker(base,slot_id,slot_generation,user,group,source_revision,source_manifest_digest,source_config_bytes,baseline_files=None):
 """Measure real fixture files under the worker UID; returns inputs, never a readiness publication."""
 import hashlib,json,shutil,uuid
 base=Path(base);base.mkdir(mode=0o755,parents=True,exist_ok=True);base.chmod(0o755)
 barrier=base/'worker';barrier.mkdir(mode=0o700);os.chown(barrier,user,group)
 paths={name:barrier/name for name in ['source','home','temporary','build','dirty']}
 for directory in paths.values():directory.mkdir(mode=0o700);os.chown(directory,user,group)

 files_to_write=dict(baseline_files or {});files_to_write['worker.py']=WORKER_SOURCE;files_to_write['.neron']=source_config_bytes
 for name,data in files_to_write.items():
  if Path(name).is_absolute() or '..' in Path(name).parts:raise ValueError('Unsafe baseline file')
  (paths['source']/name).parent.mkdir(parents=True,exist_ok=True)
  for parent in (paths['source']/name).parents:
   if parent==paths['source']:break
   if paths['source'] in parent.parents:os.chown(parent,user,group);parent.chmod(0o700)
  p=paths['source']/name;p.write_bytes(data);p.chmod(0o600);os.chown(p,user,group)
 runtime=base/'runtime';shutil.copytree(ROOT/'core/control-plane/dist',runtime);runtime.chmod(0o755)
 for directory,names,files in os.walk(runtime):
  os.chmod(directory,0o755)
  for filename in files:os.chmod(Path(directory)/filename,0o444)
 node=runtime/'node';shutil.copyfile(shutil.which('node'),node);node.chmod(0o555)
 (runtime/'package.json').write_text('{"type":"module"}\n');(runtime/'package.json').chmod(0o444)
 interface=base/'interfaces.kvx';interface_bytes=b'[interface.worker.run]\nkind = "cli_command"\npath = "worker.py"\nline = 1\nsignature = "python3 worker.py"\ncallers = []\nstatus = "active"\ncontract = "Write actual isolated source output."\nnotes = ""\n';interface.write_bytes(interface_bytes);interface.chmod(0o444)
 pin=lambda data:'sha256:'+hashlib.sha256(data).hexdigest()
 canonical=lambda value:json.dumps(value,separators=(',',':'),sort_keys=True).encode()
 slot={'worker_slot_id':slot_id,'slot_generation':str(slot_generation),'uid':user,'gid':group,'worker_root':str(barrier),**{k:str(v) for k,v in paths.items()}}
 files=[{'path':name,'mode':'100644','size':len(data),'digest':pin(data)} for name,data in sorted(files_to_write.items()) if name!='.neron']
 state=pin(canonical({'kind':'FLEET_MANIFEST_SOURCE_V1','source_revision':source_revision,'source_manifest_digest':source_manifest_digest,'files':files}))
 workspace=pin(canonical({'kind':'FLEET_MANIFEST_WORKSPACE_V1','slot':slot,'source_config_digest':pin(source_config_bytes)}))
 read_input={'schema_version':1,'kind':'FLEET_MANIFEST_V1','operation_id':str(uuid.uuid4()),'environment_root':str(base),'admission_digest':pin(canonical(slot)),'plan_digest':pin(canonical(files)),'package_digest':pin(WORKER_SOURCE),'source_manifest_digest':source_manifest_digest,'source_revision':source_revision,'slot':slot,'source_files':files,'source_config_digest':pin(source_config_bytes),'dependency_inventory_digest':pin(b'{"entries":[],"kind":"hyperfide.installed-dependency-inventory","schema_version":1}'),'toolchain_manifest':{},'toolchains':[],'configurations':[],'interfaces':{'target':str(interface),'digest':pin(interface_bytes),'catalogue_digest':pin(interface_bytes),'source_revision':source_revision,'selected_ids':['interface.worker.run'],'max_bytes':65536,'max_blocks':10},'probes':[],'source_state_digest':state,'workspace_digest':workspace}
 probe=runtime/'preparation/fleet_readiness_probe.js'
 observed=subprocess.run([str(node),str(probe)],input=json.dumps(read_input),text=True,capture_output=True,user=user,group=group,extra_groups=[],cwd=paths['source'],env={'PATH':'/usr/bin:/bin','HOME':str(paths['home']),'TMPDIR':str(paths['temporary']),'LANG':'C.UTF-8'},timeout=20)
 if observed.returncode:raise RuntimeError('Actual isolated worker readiness probe failed: '+observed.stderr[:500])
 measured=json.loads(observed.stdout)
 if measured.get('status')!='READY':raise RuntimeError('Actual isolated worker readiness measurement not READY')
 return {'slot':slot,'paths':{k:str(v) for k,v in paths.items()},'source_root':str(paths['source']),'seal_root':str(barrier),'runtime':str(runtime),'worker_argv':['/usr/bin/python3',str(paths['source']/'worker.py')],'readiness_input':read_input,'measurement':measured,'verifier':{'node_path':str(node),'node_digest':pin(node.read_bytes()),'module_path':str(probe),'module_digest':pin(probe.read_bytes())},'input_digest':pin(canonical(read_input)),'source_state_digest':state,'workspace_digest':workspace}

def prepare_native_manifest_launch(base,identity,transport_path,consumer_id,source_revision,source_manifest_digest,source_config_bytes,baseline_commit,baseline_tree,slot_uid,slot_gid,baseline_files=None):
 """DECLARED connector metadata is fixture input; worker measurement/execution are real."""
 import base64,hashlib,json,sqlite3
 measured=prepare_manifest_worker(base,identity['slot_id'],'1',slot_uid,slot_gid,source_revision,source_manifest_digest,source_config_bytes,baseline_files)
 base=Path(base);state=base/'runner-state';state.mkdir(mode=0o700);slots=base/'native-slots';slots.mkdir(mode=0o711)
 pin=lambda data:'sha256:'+hashlib.sha256(data).hexdigest()
 canonical=lambda value:json.dumps(value,separators=(',',':'),sort_keys=True).encode()
 executable=Path('/usr/bin/python3').resolve();binary_digest=pin(executable.read_bytes());version=subprocess.run([str(executable),'--version'],text=True,capture_output=True,check=True).stdout.strip()
 profile_id='fixture-declared-python';profile_digest=pin(canonical({'kind':'DECLARED_LOCAL_PYTHON_FIXTURE','binary_digest':binary_digest,'version':version}))
 snapshot={'schema_version':1,'profile_id':profile_id,'profile_revision':'1','profile_digest':profile_digest,'connector':'claude','auth_mode':'account_session','binary':{'path':str(executable),'digest':binary_digest,'version':version},'credential_reference':'fixture-no-credential-resolution','configured_model_alias':'fixture-no-model','requested_model_id':'fixture-no-model','observed_model_id':None,'configured_provider_id':'fixture-local','observed_provider_id':None,'permission_profile_id':'fixture-local-source','capabilities':{'unattended':True,'refresh':False,'concurrent_account':False,'portable_session':False,'explicit_resume':False},'qualification':{'state':'DECLARED','live_qualified':False,'receipt_digest':None}}
 readiness={'kind':'FLEET_MANIFEST_V1','verifier':measured['verifier'],'readiness_input':measured['readiness_input'],'input_digest':measured['input_digest'],'source_state_digest':measured['source_state_digest'],'workspace_digest':measured['workspace_digest'],'source_object_id':baseline_commit,'source_tree_id':baseline_tree,'readiness_digest':pin(canonical(measured['measurement']))}
 plan={'connector':'claude','profile_digest':profile_digest,'auth_profile':profile_id,'requested_model_id':'fixture-no-model','configured_provider_id':'fixture-local','auth_profile_snapshot':snapshot,'argv':[str(executable),measured['worker_argv'][1]],'binary_digest':binary_digest,'cwd':measured['paths']['source'],'home':measured['paths']['home'],'temp':measured['paths']['temporary'],'dispatch_eligible':True,'requires_supervisor':True,'attempt_id':identity['attempt_id'],'attempt_generation':identity['attempt_generation'],'fleet_binding':{**{k:identity[k] for k in ['organisation_id','run_id','sandbox_id','boot_id','slot_id']},'boot_generation':identity['boot_generation'],'uid':slot_uid,'gid':slot_gid},'binding':{'workspace_path':measured['paths']['source'],'home_path':measured['paths']['home'],'tmp_path':measured['paths']['temporary'],'uid':slot_uid,'gid':slot_gid},'readiness':readiness}
 config={'transport_config':str(transport_path),'state_dir':str(state),'slot_root':str(slots),'connector_plan_path':str(state/'not-yet-fetched-plan.json'),**{k:identity[k] for k in ['organisation_id','run_id','sandbox_id','boot_id','boot_generation']},'consumer_id':consumer_id}
 config_path=state/'runner.json';config_path.write_bytes(canonical(config));config_path.chmod(0o600)
 with sqlite3.connect(slots/'.supervisor-slots.db') as db:
  db.execute('CREATE TABLE slots(id TEXT PRIMARY KEY,uid INTEGER UNIQUE NOT NULL,gid INTEGER UNIQUE NOT NULL,boot_id TEXT NOT NULL,preparation TEXT NOT NULL,port INTEGER UNIQUE NOT NULL,state TEXT NOT NULL)')
  db.execute("INSERT INTO slots VALUES(?,?,?,?,?,?,'READY')",(identity['slot_id'],slot_uid,slot_gid,identity['boot_id'],pin(b'isolated-local-fixture-preparation'),42175))
 (slots/'.supervisor-slots.db').chmod(0o600)
 return {**measured,'identity':dict(identity),'native_plan':plan,'native_plan_bytes':canonical(plan),'native_plan_digest':pin(canonical(plan)),'native_plan_base64':base64.urlsafe_b64encode(canonical(plan)).decode().rstrip('='),'runner_config':str(config_path),'runner_state_dir':str(state),'slot_root':str(slots),'native_binary':str(ROOT/'build/hyperfide-native'),'declared_profile':snapshot,'fixture_preconditions':{'connector_qualification':'DECLARED_ONLY','model_execution':'NOT_REQUESTED','physical_slot_metadata':'CONTROLLED_FIXTURE_INPUT'}}
