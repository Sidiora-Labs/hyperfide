#!/usr/bin/env python3
"""Actual native result collection after an isolated post-submit PostgreSQL fault."""
import importlib.util,json,os,signal,sqlite3,subprocess,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('collection_native_install',Path(__file__).with_name('fleet_install_interrupted.py'))
fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

def install_fault(c):
 f=c['f'];operation=c['logical']
 f.sql("""CREATE FUNCTION hyperfide.component_collection_serialization_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,hyperfide AS $$ BEGIN
 IF NEW.remote_operation_id='"""+operation+"""'::uuid AND EXISTS(SELECT 1 FROM hyperfide.provider_remote_operations WHERE organisation_id=NEW.organisation_id AND id=NEW.remote_operation_id AND process_claimed AND native_process_ref IS NOT NULL) AND EXISTS(SELECT 1 FROM hyperfide.runner_remote_jobs WHERE organisation_id=NEW.organisation_id AND run_id=NEW.run_id AND operation_id=NEW.remote_operation_id AND native_claimed_at IS NOT NULL) THEN
 RAISE EXCEPTION 'isolated component post-submit serialization fault' USING ERRCODE='40001'; END IF; RETURN NEW; END $$""")
 f.sql('CREATE TRIGGER component_collection_serialization_fault BEFORE INSERT ON hyperfide.provider_remote_observations FOR EACH ROW EXECUTE FUNCTION hyperfide.component_collection_serialization_fault()')

def run_collection(c):
 f=c['f'];i=c['i'];operation=c['logical'];executor=c['executor'];handlers=c['handlers'];heartbeat=c['heartbeat'];checks=c['checks'];state=c['state']
 def query(columns='*'):
  return f.sql('SELECT '+columns+' FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation])[0]
 def wait(predicate,seconds=65):
  deadline=time.monotonic()+seconds;last=None
  while time.monotonic()<deadline:
   heartbeat();last=predicate()
   if last:return last
   if executor.poll() is not None:raise AssertionError(('actual executor exited',executor.returncode,(c['owned']/'executor.stderr').read_text()[-4000:]))
   time.sleep(.2)
  raise AssertionError({'timeout':seconds,'job':query(),'processes':{name:handlers.describe(name) for name in handlers.processes},'stderr':(c['owned']/'executor.stderr').read_text()[-4000:]})
 initial=wait(lambda: (row if row['state']=='UNKNOWN' else None) if (row:=query()) else None)
 assert initial['claim_id'] and initial['native_claimed_at'] and initial['result'] is None,initial
 assert 'TX_RETRY_EXHAUSTED' in initial['failure_code'],initial
 sql_failures=[]
 for line in (c['owned']/'executor.stderr').read_text().splitlines():
  try:event=json.loads(line)
  except json.JSONDecodeError:continue
  if event.get('event')=='provider_remote_transaction_failed' and event.get('operation_id')==operation:sql_failures.append(event)
 assert any(event.get('sqlstate')=='40001' and event.get('error_code')=='TX_RETRY_EXHAUSTED' and event.get('attempts',0)>0 for event in sql_failures),sql_failures
 remote=f.sql('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[i['organisation'],i['run'],operation])[0]
 assert remote['process_claimed'] and remote['native_process_ref'] and remote['process_record']['process_ref'],remote
 assert len(handlers.processes)==1,handlers.processes
 process_name=next(iter(handlers.processes));physical=handlers.describe(process_name)
 assert str(physical['pid'])==remote['native_process_ref'] and physical['status']=='running',(physical,remote)
 checks.append('actual SDK named process and native claim preceded real SQLSTATE40001/TX_RETRY_EXHAUSTED; original job retained UNKNOWN')
 print('POST_SUBMIT_FAULT '+json.dumps({'failure_code':initial['failure_code'],'operation_id':operation,'claim_id':initial['claim_id'],'native_process_ref':remote['native_process_ref'],'process_name':process_name}),flush=True)
 f.sql('DROP TRIGGER component_collection_serialization_fault ON hyperfide.provider_remote_observations')
 f.sql('DROP FUNCTION hyperfide.component_collection_serialization_fault()')
 secondary_log=(c['owned']/'collector-secondary.stderr').open('w+')
 secondary=subprocess.Popen(['node',str(ROOT/'tests/hyperfide/support/archive_executor_process.mjs'),str(ROOT/'core/control-plane/dist'),str(f.components),str(f.policy)],cwd=f.path,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=secondary_log,text=True,bufsize=1)
 c['collectors'].append((secondary,secondary_log))
 wait(lambda:'archive-component-executor-ready' in (c['owned']/'collector-secondary.stderr').read_text(),seconds=20)
 assert secondary.poll() is None,(secondary.returncode,(c['owned']/'collector-secondary.stderr').read_text())
 wait(lambda:f.sql("SELECT attempts::text FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND attempts>=1 AND lease_until<=clock_timestamp()",[i['organisation'],i['run'],operation]))
 running=query();assert running['state']=='UNKNOWN' and running['claim_id']==initial['claim_id'] and running['result'] is None,running
 assert len(handlers.processes)==1 and handlers.describe(process_name)['pid']==physical['pid'],handlers.processes
 checks.append('production collector observed running original process without completion or another execution')
 def native_child():
  if not (state/'jobs.db').exists():return None
  with sqlite3.connect(state/'jobs.db') as db:row=db.execute('SELECT pid FROM jobs WHERE id=?',(operation,)).fetchone()
  return row[0] if row and row[0] else None
 staging=c['parent']/('.hyperfide-install-'+fixture.sha(c['env_id']+':1:'+c['inputs']['plan_digest'])[7:31])
 wait(lambda:(staging/'.installer-home/interrupted-install-ready').exists())
 child=wait(native_child)
 os.kill(child,signal.SIGKILL)
 completed=wait(lambda:(row if row['state']=='COMPLETED' else None) if (row:=query()) else None)
 assert completed['claim_id']==initial['claim_id'] and completed['claimed_at']==initial['claimed_at'] and completed['executor_credential_id']==initial['executor_credential_id'],completed
 assert completed['result']['outcome']=='FAILED' and completed['result']['cleanup']['complete'] is True and completed['result']['cleanup']['observed_process_absent'] is True,completed
 assert completed['result_digest'] and completed['result_signature'] and completed['result']['native_receipt'],completed
 assert completed['native_claimed_at']==initial['native_claimed_at'] and len(handlers.processes)==1,completed
 links=f.sql('SELECT role,artifact_id,content_digest FROM hyperfide.runner_result_artifacts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 ORDER BY role',[i['organisation'],i['run'],operation])
 assert {'native_receipt','stdout','stderr'}<={row['role'] for row in links},links
 verify="""import fs from 'node:fs';import{createPublicKey,verify}from'node:crypto';import{runnerCanonical,runnerResultSigningBytes}from'./core/control-plane/dist/runner/bridge.js';import{hash}from'./core/control-plane/dist/transport/protocol.js';const i=JSON.parse(fs.readFileSync(0,'utf8')),r=i.row;if(hash(runnerCanonical(r.result))!==r.result_digest||!verify(null,runnerResultSigningBytes(r.organisation_id,r.run_id,r.operation_id,r.plan_digest,r.result_digest),createPublicKey(fs.readFileSync(i.key)),Buffer.from(r.result_signature,'base64url')))throw Error('actual executor signature invalid');console.log('VERIFIED');"""
 subprocess.run(['node','--input-type=module','-e',verify],input=json.dumps({'row':completed,'key':str(f.keys['provisioner']['path'])}).encode(),cwd=ROOT,check=True)
 checks.append('late actual native FAILED/quiescence receipt captured into artifacts and signed by original executor without changing claim or process')
 time.sleep(5.5);assert query()==completed,(query(),completed)
 assert len(handlers.processes)==1,handlers.processes
 process_posts=[row for row in c['backend'].requests if row['method']=='POST' and row['path'].rstrip('/').endswith('/process')]
 assert len(process_posts)==1,process_posts
 assert secondary.poll() is None,(secondary.returncode,(c['owned']/'collector-secondary.stderr').read_text())
 lease=f.sql('SELECT claim_id,executor_credential_id,attempts::text FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',[i['organisation'],i['run'],operation])[0]
 assert lease['claim_id']==initial['claim_id'] and lease['executor_credential_id']==initial['executor_credential_id'] and int(lease['attempts'])>=2,lease
 checks.append('two real executor processes contend on durable collection leases; terminal replay preserves result/signature and one SDK process POST')
 print(json.dumps({'status':'PASS','scope':'isolated actual PG/SDK/native result-collection component','controlled_inputs':['initial accepted graph, identity, ownership and capacity metadata'],'operation_id':operation,'claim_id':initial['claim_id'],'process_name':process_name,'native_process_ref':remote['native_process_ref'],'sdk_named_processes':len(handlers.processes),'post_submit_sql_failures':sql_failures,'checks':checks}),flush=True)
 return 0

def collect(c):
 c['collectors']=[]
 try:return run_collection(c)
 finally:
  for process,log in c['collectors']:
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
   log.close()

if __name__=='__main__':
 if not os.environ.get('DATABASE_URL'):
  import sys
  raise SystemExit(subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode)
 raise SystemExit(fixture.main(before_executor=install_fault,scenario=collect))
