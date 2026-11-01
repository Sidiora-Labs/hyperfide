#!/usr/bin/env python3
"""Real READY CLI reuse after the existing native recovery fixture; no live-provider claim."""
import copy,importlib.util,json,os,re,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
s=importlib.util.spec_from_file_location('replay_interrupted_base',ROOT/'tests/hyperfide/cases/source_control/fleet_install_interrupted.py');base=importlib.util.module_from_spec(s);s.loader.exec_module(base)
import fleet_live_qualification as oracle
Original=base.stackmod.SubmissionStack
class ReplayStack(Original):
 completed=0
 def close(self):
  try:
   if getattr(self,'fixture',None) and not getattr(self,'_replay_checked',False):
    self._replay_checked=True
    ready=self.fixture.sql("SELECT * FROM hyperfide.fleet_environment_installs WHERE state='READY'")
    if ready:check_replay(self.fixture,ready);ReplayStack.completed+=1
  finally:super().close()
def check_replay(f,ready):
 assert len(ready)==1,ready;install=ready[0];operation=install['operation_id'];stage=Path('/run/hyperfide-stage')/operation;source=stage/'out/fleet-bootstrap';owned=source.parent/'root-replay-inputs';owned.mkdir(mode=0o700)
 envelope=json.loads((source/'envelope.json').read_bytes())
 for name in ['package.kvx','.neron']:shutil.copyfile(source/name,owned/name);(owned/name).chmod(0o600)
 for field in ['source_manifest_path','interface_fragment_path','interface_proof_path']:
  old=Path(envelope[field]);new=owned/old.name;shutil.copyfile(old,new);new.chmod(0o600);envelope[field]=str(new)
 for name,filename in envelope['configuration_paths'].items():
  old=Path(filename);new=owned/old.name;shutil.copyfile(old,new);new.chmod(0o600);envelope['configuration_paths'][name]=str(new)
 profile=json.loads(re.search(r'^auth_profile\s*=\s*(.+)$',(owned/'.neron').read_text(),re.M).group(1));authority=owned/'authority.json';authority.write_text(json.dumps({'schema_version':1,'origin':f.origin,'ca_file':str(f.ca),'key_file':str(f.keys['runner']['path']),'credential_id':f.ids['runner'],'run_id':install['run_id'],'auth_profile':profile}));authority.chmod(0o600);envelope['authority_config_path']=str(authority)
 file=owned/'envelope.json';file.write_text(json.dumps(envelope));file.chmod(0o600)
 slot=install['receipt']['slots'][0];owner=install['admission']['slot_bindings'][0];dirty=Path(slot['source'])/'replay-dirty-overlay.txt'
 def worker():os.setgroups([]);os.setgid(owner['gid']);os.setuid(owner['uid'])
 subprocess.run(['/usr/bin/python3','-c',"from pathlib import Path;import os,sys;p=Path(sys.argv[1]);p.write_bytes(b'actual worker-owned dirty overlay\\n');os.chmod(p,0o640)",str(dirty)],preexec_fn=worker,check=True,capture_output=True)
 job=f.sql('SELECT plan FROM hyperfide.runner_remote_jobs WHERE operation_id=$1',[operation])[0];runtime=job['plan']['request']['argv'][1]
 def state():return {'installs':f.sql('SELECT operation_id::text,admission_digest,receipt_digest,state FROM hyperfide.fleet_environment_installs ORDER BY operation_id'),'heads':f.sql('SELECT * FROM hyperfide.fleet_install_heads ORDER BY current_operation_id'),'jobs':f.sql('SELECT operation_id::text,state,result_digest FROM hyperfide.runner_remote_jobs ORDER BY operation_id'),'decisions':f.sql('SELECT id::text,operation_id::text FROM hyperfide.fleet_decisions ORDER BY id')}
 nodes=[p['path'] for p in envelope['plan']['runtime_files'] if Path(p['path']).name=='node'];assert len(nodes)==1,'Exact admitted Node required';node=nodes[0]
 before=state();p=subprocess.run([node,str(ROOT/'tests/hyperfide/support/fleet_install_replay_probe.mjs'),'--runtime',runtime,'--package',str(owned/'package.kvx'),'--source-config',str(owned/'.neron'),'--envelope',str(file),'--dirty-path',str(dirty)],text=True,capture_output=True,timeout=150,env={'PATH':str(Path(shutil.which('node')).parent)+':/usr/bin:/bin','LANG':'C.UTF-8'})
 assert p.returncode==0,p.stderr;capture=json.loads(p.stdout);oracle.verified_install_replay_capture(install,capture);assert state()==before,'Repeated CLI created or changed installs/head/jobs/decisions'
 for mutation in ['changed-operation','changed-receipt','changed-dirty','status-only']:
  altered=copy.deepcopy(capture)
  if mutation=='changed-operation':altered['invocations'][1]['receipt']['operation_id']=base.uid()
  elif mutation=='changed-receipt':altered['invocations'][1]['receipt']['receipt_digest']=base.sha(b'wrong receipt')
  elif mutation=='changed-dirty':altered['dirty_after']['digest']=base.sha(b'wrong bytes')
  else:altered['invocations']=[]
  try:oracle.verified_install_replay_capture(install,altered)
  except oracle.Refused:pass
  else:raise AssertionError('Replay oracle admitted altered '+mutation)
 receipt_path=Path(json.loads(re.search(r'^receipt\s*=\s*(.+)$',(owned/'package.kvx').read_text(),re.M).group(1)));original=receipt_path.read_bytes()
 def cli_error():
  answer=subprocess.run([node,runtime,'--package',str(owned/'package.kvx'),'--source-config',str(owned/'.neron'),'--envelope',str(file),'--json'],text=True,capture_output=True,timeout=60,env={'PATH':str(Path(shutil.which('node')).parent)+':/usr/bin:/bin','LANG':'C.UTF-8'})
  assert answer.returncode==1 and not answer.stdout,answer.stdout
  return json.loads(answer.stderr)['error']['code']
 changed=json.loads(original);changed['completed_at']='2000-01-01T00:00:00.000Z';receipt_path.write_text(json.dumps(changed))
 try:assert cli_error()=='FLEET_INSTALL_ARTIFACT_PIN','Altered authenticated installed receipt accepted'
 finally:receipt_path.write_bytes(original)
 backup=receipt_path.with_name(receipt_path.name+'.replay-backup');receipt_path.rename(backup);receipt_path.symlink_to(backup)
 try:assert cli_error()=='FLEET_BOOTSTRAP_PATH','Installed receipt symlink accepted'
 finally:receipt_path.unlink();backup.rename(receipt_path)
 generic="import{readProtectedFile}from"+json.dumps('file://'+str(Path(runtime).parent/'fleet_client.js'))+";try{await readProtectedFile(process.argv[1]);process.exitCode=1}catch(e){if(e.code!=='FLEET_BOOTSTRAP_PERMISSIONS')throw e;}"
 strict=subprocess.run(['node','--input-type=module','-e',generic,str(receipt_path)],text=True,capture_output=True,timeout=20);assert strict.returncode==0,'Generic cross-owner bootstrap read was widened: '+strict.stderr
 assert state()==before,'Refused read attempts changed authority state'
 print(json.dumps({'status':'PASS','scope':'actual native READY predecessor, two public CLI reuse invocations, signed TLS status and real worker-UID dirty filesystem; no live provider or signed replay-driver qualification','same_operation':operation,'negative_cases':['changed-operation','changed-receipt','changed-dirty','status-only','actual-receipt-tamper','actual-receipt-symlink','generic-bootstrap-owner-strict'],'dirty_mode':capture['dirty_after']['mode'],'new_install_head_job_decision':False}),flush=True)
def main():
 base.stackmod.SubmissionStack=ReplayStack;code=base.main();assert code or ReplayStack.completed==1,'READY replay gate did not execute';return code
if __name__=='__main__':raise SystemExit(main())
