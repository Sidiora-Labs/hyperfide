#!/usr/bin/env python3
import hashlib,json,os,subprocess,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
MODULE=Path(os.environ.get('HYPERFIDE_SOURCE_ARCHIVE_MODULE',str(ROOT/'core/control-plane/dist/artifacts/fleet_source_archive.js')))
def identity():return str(uuid.uuid4())
def pin(data):return 'sha256:'+hashlib.sha256(data).hexdigest()
def main():
 checks=[]
 with tempfile.TemporaryDirectory(prefix='hf-source-archive-') as temporary:
  root=Path(temporary);root.chmod(0o700);seal=root/'worker';source=seal/'source';source.mkdir(parents=True);os.chown(seal,61874,61874);os.chown(source,61874,61874);seal.chmod(0o700);source.chmod(0o700)
  binding={key:identity() for key in ['organisation_id','run_id','custody_id','task_id','attempt_id','sandbox_id','boot_id','slot_id','session_id','workspace_id','launch_id','command_id','quiescence_operation_id']}
  binding.update({key:'1' for key in ['custody_generation','attempt_generation','boot_generation','slot_generation']});binding.update({key:pin(key.encode()) for key in ['quiescence_receipt_digest','native_launch_plan_digest','captured_result_digest','report_digest']});binding.update(uid=61874,gid=61874,os_boot_id=Path('/proc/sys/kernel/random/boot_id').read_text().strip())
  request={'schema_version':1,'kind':'FLEET_SOURCE_ARCHIVE_CAPTURE_V1','binding':binding,'baseline':{'source_revision':'baseline-revision','source_manifest_digest':pin(b'baseline')},'policy':{'max_files':10,'max_bytes':1024,'excluded_paths':[]},'source_root':str(source),'seal_root':str(seal),'archive_path':str(root/'archive.json')}
  filename=root/'request.json'
  def invoke():
   filename.write_text(json.dumps(request));filename.chmod(0o600)
   return subprocess.run(['node',str(MODULE),str(filename)],text=True,capture_output=True,timeout=15)
  real_boot=binding['os_boot_id'];binding['os_boot_id']=identity()
  if invoke().returncode==0 or (root/'archive.json').exists():raise AssertionError('Wrong physical kernel boot captured')
  binding['os_boot_id']=real_boot;checks.append('wrong-physical-kernel-boot-refused')
  root.chmod(0o711)
  worker=subprocess.Popen(['/usr/bin/python3','-I','-c','import os,sys; open(sys.argv[1],"wb").write(b"actual worker output\\n"); print("ready",flush=True); sys.stdin.read()',str(source/'result.txt')],user=61874,group=61874,extra_groups=[],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,cwd='/')
  try:
   if worker.stdout.readline().strip()!='ready':raise AssertionError('Actual worker did not write output')
   refused=invoke()
   if refused.returncode==0 or (root/'archive.json').exists():raise AssertionError('Active UID was captured')
   checks.append('actual-live-worker-uid-refused')
  finally:worker.stdin.close();worker.wait(timeout=10)
  accepted=invoke()
  if accepted.returncode:raise AssertionError(accepted.stderr)
  receipt=json.loads(accepted.stdout);raw=(root/'archive.json').read_bytes();archive=json.loads(raw)
  import base64
  entry=archive['files'][0]
  if base64.b64decode(entry['content_base64'])!=b'actual worker output\n' or entry['digest']!=pin(b'actual worker output\n') or receipt['archive_digest']!=pin(raw):raise AssertionError('Actual worker bytes not retained')
  if archive['binding']!=binding or receipt['source_sealed'] is not True or source.stat().st_uid!=0 or source.stat().st_mode&0o222:raise AssertionError('Source binding/seal missing')
  checks.extend(['actual-worker-content-and-archive-digest','exact-attempt-boot-result-binding','root-sealed-source-prevents-late-worker-writes'])
  overwrite=subprocess.run(['/usr/bin/python3','-I','-c','import sys; open(sys.argv[1],"wb").write(b"late")',str(source/'result.txt')],user=61874,group=61874,extra_groups=[],capture_output=True,cwd='/')
  if overwrite.returncode==0:raise AssertionError('Late source overwrite permitted')
  checks.append('actual-late-worker-write-refused')
  (source/'escape').symlink_to('/etc/passwd');request['archive_path']=str(root/'archive-escape.json')
  if invoke().returncode==0 or (root/'archive-escape.json').exists():raise AssertionError('Source symlink escape archived')
  checks.append('actual-source-symlink-escape-refused')
  (source/'escape').unlink();os.link(source/'result.txt',source/'duplicate');request['archive_path']=str(root/'archive-hardlink.json')
  if invoke().returncode==0 or (root/'archive-hardlink.json').exists():raise AssertionError('Hardlinked source archived')
  checks.append('actual-source-hardlink-refused')
  print(json.dumps({'status':'PASS','scope':'real-unix-source-archive','checks':checks}))
 return 0
if __name__=='__main__':raise SystemExit(main())
