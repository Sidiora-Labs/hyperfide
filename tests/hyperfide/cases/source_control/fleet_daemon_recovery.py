#!/usr/bin/env python3
"""Actual native observer replacement, retained pending RPC, and TLS/PG acknowledgement."""
import hashlib,json,os,shutil,signal,subprocess,sys,tempfile,time,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture
BIN=ROOT/'build/hyperfide-native'
def pin(p):return 'sha256:'+hashlib.sha256(Path(p).read_bytes()).hexdigest()
def write(p,v):p.write_text(json.dumps(v,separators=(',',':')));p.chmod(0o600)
def wait(fn,seconds=15):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  try:
   v=fn()
   if v:return v
  except (FileNotFoundError,json.JSONDecodeError):pass
  time.sleep(.05)
 raise AssertionError('Bounded native condition not reached')
def process(pid):
 stat=(Path('/proc')/str(pid)/'stat').read_text();tail=stat[stat.rfind(')')+2:].split();return {'pid':pid,'pgid':int(tail[2]),'start_time':tail[19],'os_boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 base=Path(tempfile.mkdtemp(prefix='hf-observer-',dir='/var/lib/hyperfide'));base.chmod(0o700);f=None;child=None;recovered=None;checks=[]
 try:
  f=IdentityFixture();f.bootstrap_runner();i=f.ids
  original=base/'original-native';shutil.copyfile(ROOT/'build/fleet/integration/private/retained-hyperfide-native-695cbd2b',original);original.chmod(0o555)
  helper=base/'recovery-helper';shutil.copyfile(BIN,helper);helper.chmod(0o500)
  state_root=base/'state';boot=state_root/i['sandbox']/i['boot'];boot.mkdir(parents=True,mode=0o700)
  for p in [state_root,state_root/i['sandbox']]:p.chmod(0o700)
  daemon=boot/'daemon';daemon.mkdir(mode=0o700);registration=boot/'registration.json';write(registration,{'preparation_digest':f.preparation,'inventory':[]})
  transport=boot/'transport.json';write(transport,{'origin':f.origin,'ca_file':str(f.ca),'key_path':str(f.keys['runner']['path']),'credential_id':i['runner'],'run_id':i['run'],'timeout_ms':2000})
  config=boot/'daemon.json';write(config,{'transport_config':str(transport),'state_dir':str(daemon),'organisation_id':i['organisation'],'run_id':i['run'],'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','runner_registration_path':str(registration),'heartbeat_interval_ms':1000})
  child=subprocess.Popen([str(original),'--component','12.1','--action','supervisor.serve'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True);child.stdin.write(json.dumps({'config_path':str(config)}).encode());child.stdin.close()
  state=daemon/'daemon-state.json';wait(lambda:state.exists()and json.loads(state.read_text()).get('registered'))
  old=process(child.pid);manifest=base/'manifest.json';write(manifest,{'schema_version':1,'kind':'FLEET_NATIVE_BOOTSTRAP_V1','bootstrap_id':i['intent'],'binding':{'organisation_id':i['organisation'],'run_id':i['run'],'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1'},'template':{'state_root':str(state_root),'runner_binary':str(original),'runner_binary_digest':pin(original),'origin':f.origin}})
  original_receipt=boot/'bootstrap-receipt.json';write(original_receipt,{'schema_version':1,'kind':'FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1','bootstrap_id':i['intent'],'manifest_digest':pin(manifest),'credential_id':i['runner'],'daemon':old});original_bytes=original_receipt.read_bytes()
  f.stop();pending=wait(lambda:(lambda s:s if s.get('pending')else None)(json.loads(state.read_text())));child.kill();child.wait(timeout=5);expected=pending['state_version'];payload=json.loads(pending['pending']['payload'])
  if payload['input']['expected_version']!=expected:raise AssertionError('Real pending version differs')
  operation=str(uuid.uuid4());attempt=boot/'daemon-recoveries'/operation;attempt.mkdir(parents=True,mode=0o700);(boot/'daemon-recoveries').chmod(0o700)
  fields=pending['pending'];permit={'schema_version':1,'kind':'FLEET_NATIVE_DAEMON_RECOVERY_V1','operation_id':operation,'bootstrap_id':i['intent'],'manifest_digest':pin(manifest),'helper_path':str(helper),'helper_digest':pin(helper),'bootstrap_receipt_digest':pin(original_receipt),'daemon_config_digest':pin(config),'transport_digest':pin(transport),'daemon_state_digest':pin(state),'previous_daemon':old,'pending':{**{k:fields[k]for k in ['kind','operation_id','idempotency_key','correlation_id']},'payload_digest':'sha256:'+hashlib.sha256(fields['payload'].encode()).hexdigest(),'expected_state_version':expected},'credential_id':i['runner'],'previous_recovery_operation_id':None,'previous_recovery_receipt_digest':None};permit_file=attempt/'permit.json';write(permit_file,permit)
  def invoke():
   r=subprocess.run([str(helper),'--component','12.1','--action','supervisor.daemon.recover'],input=json.dumps({'manifest_path':str(manifest),'manifest_digest':pin(manifest),'recovery_path':str(permit_file),'recovery_digest':pin(permit_file)}),text=True,capture_output=True,timeout=35)
   return r,json.loads(r.stdout)if r.stdout.strip()else None
  bad=dict(permit,daemon_state_digest='sha256:'+'0'*64);write(permit_file,bad);r,_=invoke()
  if r.returncode==0 or 'DAEMON_RECOVERY_STATE_CHANGED' not in r.stderr or (attempt/'submitted.json').exists():raise AssertionError('Wrong state pin did not reach exact protected-state refusal '+r.stderr)
  checks.append('wrong protected-state pin refused before execution');write(permit_file,permit)
  helper_request=json.dumps({'manifest_path':str(manifest),'manifest_digest':pin(manifest),'recovery_path':str(permit_file),'recovery_digest':pin(permit_file)})
  parent=subprocess.Popen([str(helper),'--component','12.1','--action','supervisor.daemon.recover'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  parent.stdin.write(helper_request.encode());parent.stdin.close()
  submitted=wait(lambda:json.loads((attempt/'submitted.json').read_text()))
  if (attempt/'receipt.json').exists():raise AssertionError('Offline server produced an accepted recovery')
  os.kill(parent.pid,signal.SIGKILL);parent.wait(timeout=5)
  if process(submitted['daemon']['pid'])!=submitted['daemon']:raise AssertionError('Helper loss replaced or terminated native daemon')
  f.start();wait(lambda:(attempt/'receipt.json').is_file())
  if process(submitted['daemon']['pid'])!=submitted['daemon']:raise AssertionError('Late acknowledgement changed retained daemon')
  checks.append('monitor durably recorded actual late TLS/PG acknowledgement after helper SIGKILL')
  r,v=invoke()
  if r.returncode:raise AssertionError('Recovery reconciliation refused '+r.stderr)
  recovered=v['result'];new=recovered['daemon']
  if new!=submitted['daemon']:raise AssertionError('Reconciliation launched another observer')
  if new['pid']==old['pid'] or int(recovered['accepted_state_version'])<=int(expected):raise AssertionError('Observer did not advance actual pending state')
  rows=f.sql('SELECT operation_id,payload_digest,response FROM hyperfide.identity_operation_results WHERE scope_id=$1 AND operation=$2 AND idempotency_key=$3',[i['runner'],'identity.runner.heartbeat',fields['idempotency_key']])
  if len(rows)!=1 or rows[0]['operation_id']!=fields['operation_id'] or rows[0]['response']['state_version']!=str(int(expected)+1):raise AssertionError('Original pending RPC was replaced or not committed')
  checks.append('actual replacement daemon committed exact retained pending operation through TLS/PG')
  receipt=(attempt/'receipt.json').read_bytes();r,replayed=invoke()
  if r.returncode or replayed['result']!=recovered or (attempt/'receipt.json').read_bytes()!=receipt:raise AssertionError('Stable recovery replay changed daemon or receipt')
  if original_receipt.read_bytes()!=original_bytes:raise AssertionError('Original bootstrap receipt changed')
  checks.extend(['same recovery reconciles existing daemon without second execution','original bootstrap receipt and enrolled identity preserved'])
  print(json.dumps({'status':'PASS','scope':'actual native daemon-recovery TLS/PG component boundary','fixture_preconditions':['baseline bootstrap receipt binds actual prior native daemon; no provider claim'],'checks':checks}));return 0
 finally:
  if child and child.poll()is None:child.kill();child.wait(timeout=5)
  observed=[recovered]if recovered else []
  if not observed:
   for saved in base.glob('state/*/*/daemon-recoveries/*/submitted.json'):
    observed.append(json.loads(saved.read_text()))
  for record in observed:
   for key in ['daemon','monitor']:
    try:
     actual=process(record[key]['pid'])
     if actual==record[key]:os.kill(actual['pid'],signal.SIGTERM)
    except (ProcessLookupError,FileNotFoundError):pass
  if f:f.close()
  if len(checks)>=4:shutil.rmtree(base,ignore_errors=True)
  else:print('RETAINED_FAILED_RECOVERY_ROOT '+str(base),file=sys.stderr)
if __name__=='__main__':raise SystemExit(main())
