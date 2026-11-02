#!/usr/bin/env python3
"""Actual SDK/native-stage and PostgreSQL bootstrap setup/submission deadline boundaries."""
import argparse,base64,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support';sys.path.insert(0,str(SUPPORT))
from bootstrap_deadline_fixture import prepare

def sha(value):return 'sha256:'+hashlib.sha256(value).hexdigest()
def main():
 p=argparse.ArgumentParser();p.add_argument('--native-path',required=True);p.add_argument('--native-digest',required=True);p.add_argument('--case',choices=['budget','precas','postcas'],default='budget');a=p.parse_args()
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
 stages=[];finals=[];delays=[];target={'native':None};delayed=0
 def process_boundary(method,identifier,body,underlying):
  status,value=underlying(method,identifier,body)
  if method=='POST' and identifier is None:
   if body['name'].endswith('-stage'):
    stages.append({'name':body['name'],'status':value.get('status'),'exit_code':value.get('exitCode'),'stdout':value.get('stdout'),'stderr':value.get('stderr')})
   else:
    finals.append({'name':body['name'],'status':status,'pid':value.get('pid'),'at':time.time()})
    if status==200:os.killpg(int(value['pid']),signal.SIGSTOP)
  return status,value
 def http_delay(method,path):
  nonlocal delayed
  if a.case!='budget' or delayed>=2 or not target['native']:return None
  from urllib.parse import unquote
  if str(target['native']) not in unquote(path):return None
  if not (method=='POST' and '/filesystem-multipart/initiate/' in path or method=='GET' and '/filesystem/' in path):return None
  delayed+=1;delays.append({'method':method,'path':path,'delay_seconds':31,'started':time.time()});return 31
 fixture=prepare(a.native_path,a.native_digest,process_boundary=process_boundary,http_delay=http_delay);f=fixture['f'];d=fixture['payload'];target['native']=d['native_path']
 try:
  if a.case=='precas':
   f.sql("CREATE FUNCTION hyperfide.component_bootstrap_cas_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='DELIVERING' AND OLD.state<>'DELIVERING' THEN PERFORM pg_sleep(7); END IF; RETURN NEW; END $$")
   f.sql('CREATE TRIGGER component_bootstrap_cas_delay BEFORE UPDATE ON hyperfide.provider_native_bootstraps FOR EACH ROW EXECUTE FUNCTION hyperfide.component_bootstrap_cas_delay()')
  body=json.dumps(f.operation('8.3','provider.intents.reconcile',{'intent_id':d['intent']}),sort_keys=True,separators=(',',':')).encode();seconds=str(int(time.time()));nonce=__import__('uuid').uuid4().__str__();credential=f.ids['provisioner']
  signature=f.sign('provisioner',('\n'.join(('HYPERFIDE-REQUEST-V1','POST','/v1/invoke',f.origin,credential,seconds,nonce,sha(body),''))).encode())
  proof={'body':base64.b64encode(body).decode(),'headers':['hf-credential-id',credential,'hf-request-time',seconds,'hf-request-nonce',nonce,'hf-request-signature',signature]}
  result=subprocess.run(['node',str(SUPPORT/'bootstrap_deadline_actor.mjs'),str(ROOT/'core/control-plane/dist'),str(f.components),str(f.policy)],input=json.dumps({'payload':d,'case':a.case,'proof':proof}),text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,cwd=ROOT,env=f.env,timeout=180)
  print(result.stdout,end='',flush=True);print(result.stderr,end='',file=sys.stderr,flush=True)
  print('ACTUAL_BOOTSTRAP_TRANSPORT '+json.dumps({'case':a.case,'stages':stages,'final_posts':finals,'delays':delays,'sdk_requests':fixture['backend'].requests}),flush=True)
  if result.returncode:return result.returncode
  assert stages and all(s['status']=='completed' and s['exit_code']==0 for s in stages),stages
  if a.case=='budget':assert len(finals)==1 and len(delays)==2,(finals,delays)
  else:assert not finals,finals
  print(json.dumps({'status':'PASS','scope':'actual signed coordinator/PG/pinned SDK and actual native protected stage; no READY qualification','case':a.case,'actual_native_stages':len(stages),'final_process_posts':len(finals),'delayed_legs':len(delays)}),flush=True)
  return 0
 finally:fixture['close']()
if __name__=='__main__':raise SystemExit(main())
