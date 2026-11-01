#!/usr/bin/env python3
"""Actual signed role calls and HTTPS gateway request capture; gateway returns503 only."""
import hashlib,importlib.util,json,os,socket,ssl,subprocess,sys,tempfile,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from identity_fixture import uid
s=importlib.util.spec_from_file_location('role_gateway_adoption',ROOT/'tests/hyperfide/cases/tasks/3_4.py');adoption=importlib.util.module_from_spec(s);s.loader.exec_module(adoption)
TOKEN='owned-local-gateway-test-token-not-a-real-secret'
def instructions_and_observation(prompt):
 instructions,body=prompt.rsplit('\n',1);observation=json.loads(body);decoder=json.JSONDecoder();lists=[]
 for index,value in enumerate(instructions):
  if value!='[':continue
  try:array,_=decoder.raw_decode(instructions[index:])
  except json.JSONDecodeError:continue
  if isinstance(array,list) and array and all(isinstance(x,str) for x in array) and 'REPLAN' in array and 'COORDINATE_DEPENDENCY' in array:lists.append(array)
 assert len(lists)==1,'Actual gateway prompt must convey one unambiguous allowed-action array'
 return lists[0],observation
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 with tempfile.TemporaryDirectory(prefix='hf-role-gateway-') as temporary:
  home=Path(temporary);cert=home/'ca.pem';key=home/'tls.pem'
  subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-sha256','-nodes','-keyout',str(key),'-out',str(cert),'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1','-days','1'],check=True,capture_output=True);key.chmod(0o600)
  captured=[]
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*_):pass
   def do_POST(self):
    count=int(self.headers.get('Content-Length','0'));assert 0<count<=1048576
    body=json.loads(self.rfile.read(count));captured.append({'path':self.path,'tls':self.connection.version(),'auth_matches_owned_dummy':self.headers.get('Authorization')=='Bearer '+TOKEN,'body':body})
    data=b'{"error":{"code":"CONTROLLED_UNAVAILABLE"}}';self.send_response(503);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  gateway=ThreadingHTTPServer(('127.0.0.1',0),Handler);gateway.daemon_threads=True;context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.minimum_version=ssl.TLSVersion.TLSv1_3;context.load_cert_chain(cert,key);gateway.socket=context.wrap_socket(gateway.socket,server_side=True);thread=threading.Thread(target=gateway.serve_forever,daemon=True);thread.start();f=None
  try:
   def setup(f):
    adoption.native_profiles(f)
    f.env.update(HYPERFIDE_FLEET_MODEL_BACKEND='gateway',HYPERFIDE_FLEET_GATEWAY_ENDPOINT='https://localhost:'+str(gateway.server_port)+'/chat/completions',HYPERFIDE_FLEET_GATEWAY_KEY_ENV='CLUSTER_1_GATEWAY_API_KEY',CLUSTER_1_GATEWAY_API_KEY=TOKEN,MODEL='owned-test-profile',HYPERFIDE_FLEET_HOST_ID=socket.gethostname(),NODE_EXTRA_CA_CERTS=str(cert))
   f=adoption.sched.SchedulerFixture(extra_components=component_closure(['fleet-orchestration']),extra_setup=setup);i=f.ids;common=[i['organisation'],i['run']]
   f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
   budget={'allowed_actions':['REPLAN'],'provider_ids':['fixture'],'profile_ids':[i['profile']],'max_sandboxes':1,'max_concurrent_workers':1,'task_ids':[i['task_b']]}
   f.sql('INSERT INTO hyperfide.fleet_delegations(organisation_id,run_id,package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id) VALUES($1,$2,$3,$4,2,1,$5,$6)',common+[i['wave_package'],i['manager2'],json.dumps(budget),uid()])
   primary={'actor_id':i['leader'],'actor_role':'PRIMARY','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':None,'manager_generation':None}
   manager={'actor_id':i['manager2'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':'1','delegation_id':i['wave_package'],'manager_generation':'2'}
   f.ok('fleet.session.bind',{'binding':manager},key='manager2',component='fleet-orchestration')
   def effects():return {table:f.sql('SELECT count(*)::int AS n FROM hyperfide.'+table)[0]['n'] for table in ['fleet_decisions','fleet_effect_receipts','attempts','compute_leases','provisioning_intents']}
   before=effects();results=[]
   for key,binding in [('leader',primary),('manager2',manager)]:
    observation=f.ok('fleet.observe',{'binding':binding,'after':None,'limit':100},key=key,component='fleet-orchestration')
    request={'binding':binding,'operation_id':uid(),'observation_id':observation['observation_id']}
    response=f.invoke('fleet.session.reason',request,key=key,component='fleet-orchestration')[1];assert response.get('ok'),response
    answer=response['result'];assert answer['state']=='WAITING_FOR_MANAGER' and answer['reason']=='FLEET_GATEWAY_HTTP_503' and answer['deterministic_fallback'] is False,answer
    retained=f.sql('SELECT state,reason,actor_id::text FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND id=$3',common+[request['operation_id']]);assert len(retained)==1 and retained[0]=={'state':'WAITING_FOR_MANAGER','reason':'FLEET_GATEWAY_HTTP_503','actor_id':binding['actor_id']},retained
    assert len(captured)==len(results)+1,'Reasoning failed to reach actual owned TLS gateway exactly once'
    wire=captured[-1];assert wire['tls']=='TLSv1.3' and wire['auth_matches_owned_dummy'] and wire['path']=='/chat/completions',wire
    body=wire['body'];assert body['model']=='owned-test-profile' and 'tools' not in body and 'tool_choice' not in body,body
    allowed,observed=instructions_and_observation(body['messages'][1]['content']);assert observed['binding']['actor_role']==binding['actor_role'],observed['binding']
    if binding['actor_role']=='PRIMARY':assert 'REPLACE_MANAGER' in allowed,allowed
    else:assert 'REPLACE_MANAGER' not in allowed,allowed
    history=observed['action_contracts']['REPLAN']['history_request'];assert {'collection','cursor','limit'}<=set(history.get('required',[])),history
    selector=observed['action_contracts']['fleet.install.admit']['slot_bindings'];items=selector['items'];assert set(items['required'])=={'slot','worker_slot_id'} and set(items['properties'])=={'slot','worker_slot_id'} and items['additional_properties'] is False,selector
    replay=f.ok('fleet.session.reason',request,key=key,component='fleet-orchestration');assert replay['replayed'] is True and len(captured)==len(results)+1,replay
    results.append({'actor_role':binding['actor_role'],'allowed_actions':allowed,'history_contract_present':True,'install_selector_only':True,'state':answer['state'],'reason':answer['reason']})
   assert effects()==before,'Unavailable model reasoning created execution/model effects'
   capture=(ROOT/'build/fleet/integration/private'/('fleet-model-role-gateway-capture-'+uid()+'.json')).resolve();capture.parent.mkdir(parents=True,exist_ok=True);capture.write_text(json.dumps({'schema_version':1,'scope':'OWNED_HTTPS_503_ONLY_NO_SUCCESSFUL_MODEL_OUTPUT','requests':captured},indent=2)+'\n');capture.chmod(0o600)
   print(json.dumps({'capture':{'path':str(capture),'sha256':'sha256:'+hashlib.sha256(capture.read_bytes()).hexdigest()},'status':'PASS','scope':'actual role-authenticated PostgreSQL/TLS reasoning and captured real reasonWithGateway request; owned HTTPS503 only, no successful model output','results':results,'gateway_requests':len(captured),'model_decisions_created':0,'provider_live':'UNRUN'}));return 0
  finally:
   if f:f.close()
   gateway.shutdown();gateway.server_close();thread.join(timeout=5)
if __name__=='__main__':raise SystemExit(main())
