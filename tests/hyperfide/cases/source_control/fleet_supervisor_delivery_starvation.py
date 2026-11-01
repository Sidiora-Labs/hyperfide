#!/usr/bin/env python3
"""Real supervisor and signed PG APIs; transparent owned TLS loss boundary, no model/provider success."""
import argparse,copy,http.client,importlib.util,json,os,shutil,socket,ssl,subprocess,sys,threading,uuid
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
s=importlib.util.spec_from_file_location('starvation_target_fixture',ROOT/'tests/hyperfide/cases/source_control/fleet_install_not_started_delivery.py');target=importlib.util.module_from_spec(s);s.loader.exec_module(target)
base=target.base;insert=base.insert;digest=base.digest;uid=base.uid;original_extension=target.extension
Original=target.DeliveryFixture
class SupervisorFixture(Original):
 def __init__(self,*args,**kwargs):
  prior=kwargs.get('extra_setup')
  def setup(f):
   if prior:prior(f)
   f.env.update(HYPERFIDE_FLEET_MODEL_BACKEND='gateway',HYPERFIDE_FLEET_GATEWAY_ENDPOINT=f.origin+'/owned-unavailable-model',MODEL='owned-unavailable-model',CLUSTER_1_GATEWAY_API_KEY='owned-dummy-no-live-authority',NODE_EXTRA_CA_CERTS=str(f.ca),HYPERFIDE_FLEET_HOST_ID=socket.gethostname())
  kwargs['extra_setup']=setup;super().__init__(*args,**kwargs)
def extension(f,decision,admission):
 original_extension(f,decision,admission)
 i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']];current=admission['operation_id'];aux=f.sql('SELECT * FROM hyperfide.fleet_install_delivery_executions WHERE operation_id=$1',[current])[0];b=aux['target_binding'];allocation=f.sql('SELECT * FROM hyperfide.resource_job_allocations WHERE id=$1',[b['allocation_id']])[0];pin=digest({'declared_queued_preparation_input':current})
 plan={'operation_id':current,'binding':{'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','session_id':b['session_id'],'slot_id':b['slot_id']},'allocation':{'allocation_id':allocation['id'],'request_id':allocation['request_id'],'generation':str(allocation['generation'])},'preparation_request':{'job_binding':{'namespace':'FLEET_INSTALL','job_id':current,'input_packet_digest':admission['admission_digest']}}};expires=f.sql('SELECT expires_at::text FROM hyperfide.reservations WHERE id=$1',[b['reservation_id']])[0]['expires_at']
 insert(f,'runner_remote_jobs',{**scope,'operation_id':current,'session_id':b['session_id'],'job_class':'PREPARATION','plan':plan,'plan_digest':digest(plan),'principal':{'controlled_queued_admission_input':True},'admission_digest':admission['admission_digest'],'authority_epoch':i['epoch'],'reservation_id':b['reservation_id'],'expires_at':expires})
 # A separate historical current head with an obsolete native boot precedes current work.
 stale=str(uuid.UUID(int=uuid.UUID(current).int-1));assert stale<current
 original=f.sql('SELECT * FROM hyperfide.fleet_environment_installs WHERE operation_id=$1',[current])[0];spec=f.sql('SELECT * FROM hyperfide.fleet_environment_specs WHERE input_digest=$1',[admission['input_digest']])[0];stale_input=digest({'historical_stale':stale});stale_environment='historical-stale-'+stale;package=copy.deepcopy(spec['package_spec']);package['environment']['environment_id']=stale_environment;source=copy.deepcopy(spec['source_config']);source['workspace']['environment_id']=stale_environment
 insert(f,'fleet_environment_specs',{**scope,'input_digest':stale_input,'package_digest':digest(package),'source_config_digest':digest(source),'source_manifest_digest':spec['source_manifest_digest'],'plan_digest':spec['plan_digest'],'package_spec':package,'source_config':source,'install_plan':spec['install_plan'],'registered_by':i['manager']})
 a=copy.deepcopy(admission);a.update(operation_id=stale,logical_operation_id=stale,environment_id=stale_environment,input_digest=stale_input,boot_id=uid(),package_digest=digest(package),source_config_digest=digest(source),expires_at='2099-01-01T00:00:00Z');a.pop('admission_digest');a['admission_digest']=digest(a)
 row={k:original[k] for k in ['organisation_id','run_id','environment_generation','sandbox_id','boot_generation','authority_epoch','package_id','manager_session_id','manager_generation','leader_generation','cohort_id','cohort_generation']};row.update(operation_id=stale,input_digest=stale_input,environment_id=stale_environment,boot_id=a['boot_id'],admission=a,admission_digest=a['admission_digest'],expires_at=a['expires_at']);insert(f,'fleet_environment_installs',row);insert(f,'fleet_install_heads',{**scope,'environment_id':stale_environment,'environment_generation':1,'sandbox_id':row['sandbox_id'],'boot_id':row['boot_id'],'boot_generation':row['boot_generation'],'logical_operation_id':stale,'current_operation_id':stale})
 delivery=f.sql('SELECT * FROM hyperfide.fleet_install_deliveries WHERE input_digest=$1',[admission['input_digest']])[0];old={k:delivery[k] for k in ['organisation_id','run_id','environment_generation','sandbox_id','boot_generation','session_id','reservation_id','target_binding_id','timeout_ms','registered_by']};old.update(id=uid(),input_digest=stale_input,environment_id=stale_environment,boot_id=a['boot_id'],source=delivery['source'],staging=json.dumps(delivery['staging']),registration_digest=pin,operation_id=stale,request={'controlled_historical_stale_delivery_input':True},request_digest=pin,state='QUEUED');insert(f,'fleet_install_deliveries',old)
 response=f.invoke('fleet.install.delivery.schedule',{'operation_id':stale},key='operator',component='fleet-install-delivery')[1];assert response.get('error',{}).get('code')=='FLEET_INSTALL_STALE',response
 assert f.ok('fleet.install.delivery.schedule',{'operation_id':current},key='operator',component='fleet-install-delivery')['state']=='QUEUED'
 pending=f.ok('fleet.install.delivery.pending',{'after':None,'limit':100},key='operator',component='fleet-install-delivery');assert [item['operation_id'] for item in pending['items']]==[stale,current],pending
 bindings={'leader':{'actor_id':i['leader'],'actor_role':'PRIMARY','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':None,'manager_generation':None},'manager':{'actor_id':i['manager'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['package'],'manager_generation':'2'}}
 f.ok('fleet.session.bind',{'binding':bindings['leader']},key='leader',component='fleet-orchestration')
 files={}
 for name,role in [('leader','LEADER'),('manager','FEATURE_MANAGER'),('operator','OPERATOR')]:
  principal=f.sql('SELECT credential_id::text,actor_id::text FROM hyperfide.identity_principals WHERE organisation_id=$1 AND run_id=$2 AND actor_id=$3 AND role=$4 AND state=\'ACTIVE\'',common+[i[name],role]);assert len(principal)==1,principal
  record={'schema_version':1,**principal[0],**scope,'role':role,'authority_epoch':i['epoch'],'key_file':str(f.keys[name]['path'])}
  if name=='manager':record.update(cohort_generation='1',enrollment_scope={'delegation_id':i['package'],'manager_generation':'2','handoff_id':None})
  file=f.path/(name+'-supervisor.json');file.write_text(json.dumps(record));file.chmod(0o600);files[name]=file
 before_decisions=int(f.sql('SELECT count(*)::text AS count FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',common)[0]['count'])
 calls=[];drop={'enabled':False};upstream_port=f.port
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*_):pass
  def do_POST(self):
   raw=self.rfile.read(int(self.headers['Content-Length']));body=json.loads(raw);payload=json.loads(__import__('base64').urlsafe_b64decode(body['payload_b64']+'='*(-len(body['payload_b64'])%4)));connection=http.client.HTTPSConnection('localhost',upstream_port,context=ssl.create_default_context(cafile=str(f.ca)),timeout=10)
   headers={k:v for k,v in self.headers.items() if k.lower() not in ['host','connection']}
   try:connection.request('POST',self.path,raw,headers);response=connection.getresponse();data=response.read();status=response.status
   finally:connection.close()
   result=json.loads(data);calls.append({'action':payload['action'],'component':payload['component'],'operation_id':body['operation_id'],'input_operation_id':payload['input'].get('operation_id'),'ok':result.get('ok'),'code':result.get('error',{}).get('code'),'state':result.get('result',{}).get('state')})
   if drop['enabled'] and payload['action']=='fleet.install.delivery.schedule' and payload['input'].get('operation_id')==stale:
    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
   self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
 proxy=ThreadingHTTPServer(('127.0.0.1',0),Handler);proxy.daemon_threads=True;tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);tls.minimum_version=ssl.TLSVersion.TLSv1_3;tls.load_cert_chain(f.ca,f.tlskey);proxy.socket=tls.wrap_socket(proxy.socket,server_side=True);thread=threading.Thread(target=proxy.serve_forever,daemon=True);thread.start()
 try:
  def run(label):
   directory=f.path/('supervisor-'+label);directory.mkdir(mode=0o700);cohort=f.sql('SELECT id::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2',common)[0]['id'];config={'schema_version':1,'origin':f.origin,'ca_file':str(f.ca),**scope,'cohort_id':cohort,'host_id':socket.gethostname(),'leader_generation':'1','expected_cohort_generation':'1','primary':{'session_id':i['leader'],'credential_file':str(files['leader'])},'managers':[{'session_id':i['manager'],'credential_file':str(files['manager'])}],'bootstrap':{'operator_credential_file':str(files['operator']),'ttl_seconds':60},'state_directory':str(directory),'poll_interval_ms':1000,'request_timeout_ms':5000}
   actors={}
   for name in ['leader','manager']:
    observation=f.ok('fleet.observe',{'binding':bindings[name],'after':None,'limit':100},key=name,component='fleet-orchestration');view={k:v for k,v in observation.items() if k not in ['observation_id','context_digest','observed_at']};actors[i[name]]={'binding':bindings[name],'reasoning':None,'observed_state':digest(view)}
   state={'schema_version':1,'config_digest':digest(config),'cohort_generation':'1','leader_generation':'1','pending':None,'grants':{},'actors':actors};file=directory/'state.json';file.write_text(json.dumps(state));file.chmod(0o600);cfg=directory/'config.json';cfg.write_text(json.dumps(config));cfg.chmod(0o600)
   script="import https from'node:https';import{pathToFileURL}from'node:url';const original=https.request,origin=process.argv[1],port=process.argv[2];https.request=function(url,options,callback){const target=new URL(url);if(target.origin===origin&&target.pathname==='/v1/invoke')target.port=port;return original.call(this,target,options,callback)};try{const m=await import(pathToFileURL(process.argv[3]));await m.runFleetSupervisor(process.argv[4],new AbortController().signal,true)}catch(e){console.error(JSON.stringify({error:{code:e.code??'UNEXPECTED',uncertain:e.uncertain===true,...(e.code==='ENOENT'?{path:e.path??null}:{})}}));process.exitCode=e.uncertain?75:78}finally{https.request=original}"
   def execute():return subprocess.run(['node','--input-type=module','-e',script,f.origin,str(proxy.server_port),str(SUPERVISOR),str(cfg)],text=True,capture_output=True,cwd=ROOT,env=f.env,timeout=60)
   execute.state_file=file
   first=len(calls);result=execute();events=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')];retained=json.loads(file.read_text());return result,events,retained,calls[first:],execute
  result,events,state,observed,_=run('definitive');schedules=[row for row in observed if row['action']=='fleet.install.delivery.schedule'];assert schedules and schedules[0]['input_operation_id']==stale and schedules[0]['code']=='FLEET_INSTALL_STALE',{'returncode':result.returncode,'stderr':result.stderr,'calls':observed,'events':events}
  definitive=any(row['input_operation_id']==current and row['ok'] is True and row['state']=='QUEUED' for row in schedules);assert state['pending'] is None,'Definitive refusal retained pending operation'
  drop['enabled']=True;lost,lost_events,persisted,lost_calls,retry=run('uncertain');assert lost.returncode==75 and persisted['pending']['action']=='fleet.install.delivery.schedule' and persisted['pending']['input']['operation_id']==stale,{'stderr':lost.stderr,'state':persisted,'calls':lost_calls};assert not any(row['input_operation_id']==current for row in lost_calls)
  operation=persisted['pending']['operation_id'];prior=len(calls);again=retry();replayed=calls[prior:];assert again.returncode==75 and len(replayed)==1 and replayed[0]['operation_id']==operation and replayed[0]['input_operation_id']==stale,replayed
  assert json.loads(retry.state_file.read_text())['pending']==persisted['pending'],'Uncertain replay changed retained pending command'
  lost_schedules=[row for row in lost_calls if row['action']=='fleet.install.delivery.schedule'];assert len(lost_schedules)==1 and lost_schedules[0]['operation_id']==operation
  refused=[event for event in events if event.get('event')=='mechanical_refused' and event.get('code')=='FLEET_INSTALL_STALE']
  if definitive:assert len(refused)==1 and refused[0]['component']=='fleet-install-delivery' and refused[0]['action']=='fleet.install.delivery.schedule' and refused[0]['operation_id'] is None,refused
  assert not any(event.get('event')=='mechanical_refused' for event in lost_events),'Uncertain failure misclassified as definitive'
  after_decisions=int(f.sql('SELECT count(*)::text AS count FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',common)[0]['count']);assert after_decisions==before_decisions
  print(json.dumps({'status':'PASS' if definitive else 'FAIL','scope':'actual supervisor and signed PostgreSQL/TLS APIs; controlled queued history and transparent TLS reply loss, no model/provider/native success','definitive_continues_to_real_current_queued':definitive,'mechanical_refused_recorded':any(e.get('event')=='mechanical_refused' and e.get('code')=='FLEET_INSTALL_STALE' for e in events),'uncertain_retains_exact_pending':True,'uncertain_no_later_work':True,'uncertain_replay_same_operation':True,'model_decisions_created':after_decisions-before_decisions}),flush=True)
  assert definitive,'Definitive stale delivery starved later actual current work'
 finally:proxy.shutdown();proxy.server_close();thread.join(timeout=2)
SUPERVISOR=None
def main():
 global SUPERVISOR
 parser=argparse.ArgumentParser();parser.add_argument('--supervisor',type=Path,required=True);args=parser.parse_args();SUPERVISOR=args.supervisor.resolve()
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),'--supervisor',str(SUPERVISOR)],cwd=ROOT).returncode
 target.base.a.AssignmentFixture=SupervisorFixture
 target.extension=extension
 return target.base.main()
if __name__=='__main__':raise SystemExit(main())
