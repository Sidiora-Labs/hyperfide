#!/usr/bin/env python3
"""Actual final-guard40001, original-operation retry and delayed native claim."""
import argparse,importlib.util,json,os,signal,sqlite3,subprocess,sys,threading,time
from pathlib import Path
from urllib.parse import urlsplit,parse_qs
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support'
s=importlib.util.spec_from_file_location('prepost_native_fixture',Path(__file__).with_name('fleet_install_interrupted.py'));fixture=importlib.util.module_from_spec(s);s.loader.exec_module(fixture)
STATE={'lock':threading.RLock(),'fault_enabled':True,'paused_pid':None};CASE='retry'
def before_executor(c):
 f=c['f'];session=c['registered']['session_id']
 f.sql('CREATE TABLE hyperfide.component_prepost_fault(enabled boolean NOT NULL)');f.sql('INSERT INTO hyperfide.component_prepost_fault VALUES(false)')
 f.sql("CREATE FUNCTION hyperfide.component_prepost_guard_fault(session uuid) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hyperfide AS $$ BEGIN IF session='"+session+"'::uuid AND EXISTS(SELECT 1 FROM hyperfide.component_prepost_fault WHERE enabled) THEN RAISE EXCEPTION 'isolated resource guard serialization fault' USING ERRCODE='40001'; END IF; RETURN true; END $$")
 f.sql('ALTER TABLE hyperfide.runner_registry ENABLE ROW LEVEL SECURITY')
 f.sql('CREATE POLICY component_prepost_guard_fault ON hyperfide.runner_registry TO "'+f.runtime_role+'" USING (hyperfide.component_prepost_guard_fault(session_id))')
 underlying=c['backend'].process_handler
 def boundary(method,identifier,body):
  if method=='POST' and identifier is None:
   with STATE['lock']:f.sql('UPDATE hyperfide.component_prepost_fault SET enabled=false')
  status,value=underlying(method,identifier,body)
  if method=='GET' and identifier and status==404:
   with STATE['lock']:
    if STATE['fault_enabled']:f.sql('UPDATE hyperfide.component_prepost_fault SET enabled=true')
  if method=='POST' and identifier is None and status==200:
   if CASE=='retry':
    pid=int(value['pid']);os.killpg(pid,signal.SIGSTOP);STATE['paused_pid']=pid
   else:return 503,{'message':'owned post-submit reply unavailable'}
  return status,value
 c['backend'].process_handler=boundary

def scenario(c):
 f=c['f'];i=c['i'];operation=c['logical'];checks=c['checks'];executor=c['executor']
 def job():return f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation])[0]
 def remote():
  rows=f.sql('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],operation]);return rows[0] if rows else None
 def posts():return [r for r in c['backend'].requests if r['method']=='POST' and r['path'].rstrip('/').endswith('/process')]
 def wait(call,seconds=65):
  deadline=time.monotonic()+seconds
  while time.monotonic()<deadline:
   c['heartbeat']();value=call()
   if value:return value
   if executor.poll() is not None:raise AssertionError(('executor exited',executor.returncode,(c['owned']/'executor.stderr').read_text()[-4000:]))
   time.sleep(.15)
  raise AssertionError({'timeout':seconds,'job':job(),'remote':remote(),'sdk':c['backend'].requests[-8:],'stderr':(c['owned']/'executor.stderr').read_text()[-4000:]})
 initial=wait(lambda:(r if r['state']=='UNKNOWN' else None) if (r:=job()) else None);first=remote()
 assert first and initial['claim_id'] and initial['native_claimed_at'] is None and initial['result'] is None,(initial,first)
 failures=[]
 for line in (c['owned']/'executor.stderr').read_text().splitlines():
  try:event=json.loads(line)
  except json.JSONDecodeError:continue
  if event.get('event')=='provider_remote_transaction_failed' and event.get('operation_id')==operation and event.get('sqlstate')=='40001':failures.append(event)
 assert failures and any(e.get('attempts',0)>0 for e in failures),failures
 print('PREPOST_40001 '+json.dumps({'failures':failures,'process_claimed':first['process_claimed'],'process_record':first['process_record'],'native_process_ref':first['native_process_ref'],'sdk_posts':len(posts())}),flush=True)
 assert first['process_claimed'] is False and first['process_record'] is None and first['native_process_ref'] is None and not posts(),('guard failure before POST must leave original command durably unclaimed',first,posts())
 checks.append('actual SDK lookup404 armed PG guard40001; exhausted guard left original UNKNOWN durably unclaimed/PIDnull with zero POST')
 status,result=f.invoke('runner.job.claim',{'operation_id':operation},component='12.4',key='runner')
 assert result.get('ok') is False and result['error']['code']=='REMOTE_JOB_NOT_CLAIMED',(status,result)
 assert job()==initial,'Native claim without dispatch grant changed original job'
 from runner_prepost_refusals import run_refusals
 checks.extend(run_refusals(c,initial))
 with STATE['lock']:
  STATE['fault_enabled']=False;f.sql('UPDATE hyperfide.component_prepost_fault SET enabled=false')
 if CASE=='postcas-unknown':
  wait(lambda:len(posts())==1 and (r:=remote()) and r['process_claimed']);time.sleep(7)
  after=job();retained=remote()
  assert after['state']=='UNKNOWN' and after['claim_id']==initial['claim_id'] and after['result'] is None and retained['process_claimed'] is True and len(posts())==1,(after,retained,posts())
  checks.append('actual SDK accepted one process then HTTP503; claimed uncertainty was not submitted again')
  print(json.dumps({'status':'PASS','scope':'owned PG/actual SDK post-CAS uncertainty boundary','checks':checks,'sdk_posts':len(posts())}),flush=True);return 0
 paused=wait(lambda:STATE['paused_pid'])
 assert Path('/proc/'+str(paused)+'/stat').read_text().split(') ',1)[1].split()[0] in ['T','t'],'SDK process kernel state is not stopped'
 retained=remote();grant=retained['process_record']['provider_metadata']['predispatch_retry']
 assert retained['process_claimed'] and retained['native_process_ref']==str(paused) and len(posts())==1,(retained,posts())
 assert grant['schema_version']==1 and grant['operation_id']==operation and grant['claim_id']==initial['claim_id'] and grant['executor_credential_id']==initial['executor_credential_id'] and grant['runner_plan_digest']==initial['plan_digest'] and grant['request_digest']==first['request_digest'] and grant['deadline_at']==first['operation']['deadline_at'],grant
 lease_before=f.sql('SELECT *,clock_timestamp() AS db_now,lease_until>clock_timestamp() AS live FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation])[0]
 assert lease_before['lease_id']==grant['lease_id'] and lease_before['live'],lease_before
 assert grant['job_expires_at']==initial['expires_at'],grant
 assert job()['native_claimed_at'] is None,'Native claim won the measured process interruption race'
 def released_lease():
  rows=f.sql('SELECT *,clock_timestamp() AS db_now,lease_until<=clock_timestamp() AS expired FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation]);return rows[0] if rows and rows[0]['lease_id']==grant['lease_id'] and rows[0]['expired'] else None
 lease=wait(released_lease,seconds=135)
 assert job()['native_claimed_at'] is None and job()['claim_id']==initial['claim_id'],job()
 checks.append('actual retry CAS pinned original grant and one SDK POST; real SIGSTOP delayed native claim until the producer lease expired')
 try:f.sql("UPDATE hyperfide.provider_remote_operations SET process_record=jsonb_set(process_record,'{provider_metadata,predispatch_retry,claim_id}',to_jsonb($3::text)) WHERE organisation_id=$1 AND id=$2",[i['organisation'],operation,fixture.uid()])
 except AssertionError as error:assert 'Provider process claim and identity cannot be reset' in str(error),str(error)
 else:raise AssertionError('Immutable grant accepted changed claim pin')
 assert remote()['process_record']['provider_metadata']['predispatch_retry']==grant
 headroom=f.sql("SELECT $1::timestamptz-clock_timestamp()>interval '120 seconds' AS enough,clock_timestamp() AS db_now",[first['operation']['deadline_at']])[0]
 assert headroom['enough'],('original fixture deadline lacks delayed-claim headroom',headroom,first['operation']['deadline_at'])
 print('PREPOST_DELAY_RESUME '+json.dumps({'lease_before':lease_before,'lease_after':lease,'original_deadline':first['operation']['deadline_at'],'clock':headroom}),flush=True)
 os.killpg(paused,signal.SIGCONT)
 def native_claim():
  current=job()
  if current['native_claimed_at']:return current
  if any(row['child'].poll() is not None for row in c['handlers'].processes.values()):
   spool=Path(remote()['process_record']['provider_metadata']['spool_path'])
   native={name:(spool/name).read_text()[-4000:] for name in ['stdout','stderr','receipt.json'] if (spool/name).is_file()}
   pglog=Path(parse_qs(urlsplit(os.environ['DATABASE_URL']).query)['host'][0])/'server.log'
   errors=[line for line in pglog.read_text().splitlines() if 'ERROR:' in line or 'STATEMENT:' in line][-24:]
   print('PREPOST_NATIVE_CLAIM_DIAGNOSTIC '+json.dumps({'spool':native,'postgres':errors,'grant':grant,'job':{'state':current['state'],'native_claimed_at':current['native_claimed_at']}}),flush=True)
   raise AssertionError('Actual resumed native process exited without claimed marker; retained PG/spool diagnostics')
  return None
 claimed=wait(native_claim)
 assert claimed['claim_id']==initial['claim_id'] and claimed['executor_credential_id']==initial['executor_credential_id'],claimed
 checks.append('delayed actual native signed job.claim accepted immutable CAS grant after lease expiry on same claim and process')
 staging=c['parent']/('.hyperfide-install-'+fixture.sha(c['env_id']+':1:'+c['inputs']['plan_digest'])[7:31]);wait(lambda:(staging/'.installer-home/interrupted-install-ready').exists())
 def child_pid():
  if not (c['state']/'jobs.db').exists():return None
  with sqlite3.connect(c['state']/'jobs.db') as db:r=db.execute('SELECT pid FROM jobs WHERE id=?',(operation,)).fetchone()
  return r[0] if r and r[0] else None
 os.kill(wait(child_pid),signal.SIGKILL)
 completed=wait(lambda:(r if r['state']=='COMPLETED' else None) if (r:=job()) else None)
 assert completed['claim_id']==initial['claim_id'] and completed['claimed_at']==initial['claimed_at'] and completed['result']['outcome']=='FAILED' and completed['result']['cleanup']['complete'] is True and completed['result']['cleanup']['observed_process_absent'] is True,completed
 assert completed['result_digest'] and completed['result_signature'] and len(posts())==1 and remote()['operation']==first['operation'],completed
 verify="import fs from 'node:fs';import{createPublicKey,verify}from'node:crypto';import{runnerCanonical,runnerResultSigningBytes}from'./core/control-plane/dist/runner/bridge.js';import{hash}from'./core/control-plane/dist/transport/protocol.js';const i=JSON.parse(fs.readFileSync(0,'utf8')),r=i.row;if(hash(runnerCanonical(r.result))!==r.result_digest||!verify(null,runnerResultSigningBytes(r.organisation_id,r.run_id,r.operation_id,r.plan_digest,r.result_digest),createPublicKey(fs.readFileSync(i.key)),Buffer.from(r.result_signature,'base64url')))throw Error('actual executor signature invalid');"
 subprocess.run(['node','--input-type=module','-e',verify],input=json.dumps({'row':completed,'key':str(f.keys['provisioner']['path'])}).encode(),cwd=ROOT,check=True)
 checks.append('actual native FAILED/quiescence receipt captured and signature verified on original claim/op, original deadlines, SDK POST1')
 print(json.dumps({'status':'PASS','scope':'controlled initial metadata; actual PG/SDK/native forward pre-POST retry','checks':checks,'sdk_posts':len(posts()),'original_claim':initial['claim_id'],'retry_grant':grant,'lease_before':lease_before,'lease_after':lease,'sql_failures':failures}),flush=True);return 0

if __name__=='__main__':
 p=argparse.ArgumentParser(add_help=False);p.add_argument('--case',choices=['retry','postcas-unknown'],default='retry');a,rest=p.parse_known_args();CASE=a.case;sys.argv=[sys.argv[0],*rest]
 if not os.environ.get('DATABASE_URL'):raise SystemExit(subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),'--case',CASE,*rest],cwd=ROOT).returncode)
 raise SystemExit(fixture.main(before_executor=before_executor,scenario=scenario,job_timeout_ms=540000))
