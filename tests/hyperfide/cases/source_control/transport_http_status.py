#!/usr/bin/env python3
"""Signed TLS and real PG identity; component-boundary typed fault injection only."""
import http.client,json,os,select,shutil,signal,subprocess,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture,uid
ACTION='transport.fixture.failure'
CANARY='private-redaction-canary-'+uid()
COMPONENT="""import {FoundationError} from './policy/programme.js';
export function createComponent(){return {apiVersion:1,actions:{'transport.fixture.failure':async input=>{if(input.stage==='timer')await new Promise(resolve=>setTimeout(resolve,2000));if(input.code==='HANDLER_FAILED')throw new Error(input.canary??'Controlled unhandled component failure');throw new FoundationError(input.code,input.canary??'Controlled component boundary fault')}}}}
"""
SERVER=r"""
import fs from 'node:fs';import {pathToFileURL} from 'node:url';
const d=JSON.parse(fs.readFileSync(0,'utf8')),url=name=>pathToFileURL(d.modules+'/'+name).href;
const {ComponentRegistry}=await import(url('components/registry.js')),{handleRequest}=await import(url('components/service.js')),{startHttpTransport}=await import(url('transport/http.js')),{isIdentityAuthority}=await import(url('identity/enrollment.js')),{FoundationError,validatePolicy}=await import(url('policy/programme.js'));
const controller=new AbortController(),registry=new ComponentRegistry({role:'control',env:process.env,signal:controller.signal,policy:validatePolicy(JSON.parse(fs.readFileSync(d.policy,'utf8')),'fixture-identity-v1','control')});let transport;
const close=async()=>{controller.abort();if(transport)await transport.close();await registry.close()};process.once('SIGTERM',()=>void close().then(()=>process.exit(0)));process.once('SIGINT',()=>void close().then(()=>process.exit(0)));
try{await registry.load(d.components,d.modules);const identity=registry.resolveCapability('14.1','identity.transport',isIdentityAuthority);identity.sealTrustedRegistrations();registry.installInvocationAuthorizer(i=>identity.authorize(i));transport=await startHttpTransport({origin:d.origin,host:'127.0.0.1',port:d.port,certificate:d.ca,privateKey:d.key,deadlineMs:1500,signal:controller.signal,identity,authorize:async i=>{await identity.authorize(i);if(i.payload.input.stage==='predispatch'){if(i.payload.input.code==='HANDLER_FAILED')throw new Error(i.payload.input.canary??'Controlled unhandled authorizer failure');throw new FoundationError(i.payload.input.code,i.payload.input.canary??'Controlled authorizer boundary fault')}},dispatch:i=>handleRequest(registry,{id:i.operation.operation_id,component:i.payload.component,action:i.payload.action,input:i.payload.input},1048576,i)});console.error(JSON.stringify({event:'ready'}))}catch(e){console.error(JSON.stringify({code:e.code,message:e.message}));await close();process.exit(1)}
"""
def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=IdentityFixture(extra_actions=[ACTION]);results=[];failures=[];expected_events={}
 try:
  f.stop();modules=f.path/'modules';shutil.copytree(ROOT/'core/control-plane/dist',modules,symlinks=True);(modules/'package.json').write_text('{"type":"module"}');(f.path/'node_modules').symlink_to(ROOT/'core/control-plane/node_modules',target_is_directory=True);(f.path/'migrations').symlink_to(ROOT/'core/control-plane/migrations',target_is_directory=True)
  (modules/'transport_fixture.js').write_text(COMPONENT)
  (f.components/'99.9.json').write_text(json.dumps(dict(schema_version=1,id='99.9',task='99.9',roles=['control'],module='transport_fixture.js',entry='createComponent',api_version=1,actions=[ACTION],requires=[])))
  payload=dict(modules=str(modules),components=str(f.components),policy=str(f.policy),origin=f.origin,port=f.port,ca=str(f.ca),key=str(f.tlskey));server=f.path/'server.mjs';server.write_text(SERVER)
  f.child=subprocess.Popen(['node',str(server)],cwd=ROOT,env=f.env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);f.child.stdin.write(json.dumps(payload));f.child.stdin.close();f.child.stdin=None
  deadline=time.monotonic()+20;lines=[]
  while time.monotonic()<deadline:
   ready,_,_=select.select([f.child.stderr],[],[],0.1)
   if ready:
    line=f.child.stderr.readline();lines.append(line)
    if '"event":"ready"' in line:break
   if f.child.poll() is not None:break
  else:raise AssertionError('Owned TLS listener startup timed out')
  if not any('"event":"ready"' in line for line in lines):
   _,remaining=f.child.communicate(timeout=5);f.child=None;raise AssertionError(''.join(lines)+remaining)
  for stage in ['predispatch','dispatch']:
   for code,expected in [('HANDLER_FAILED',500),('DB_UNAVAILABLE',503),('TX_RETRY_EXHAUSTED',503),('TX_TIMEOUT',503),('MIGRATION_NOT_READY',503),('INVALID_REQUEST',400),('AUTH_INVALID',401),('IDEMPOTENCY_CONFLICT',409),('OUTCOME_UNKNOWN',504)]:
    envelope=f.operation('99.9',ACTION,dict(stage=stage,code=code,canary=CANARY));status,body=f.request(envelope,headers={'X-Private-Canary':CANARY});expected_events[envelope['operation_id']]={'status':expected,'error_code':code,'correlation_id':envelope['correlation_id']}
    if not(status==expected and body.get('ok') is False and body.get('error',{}).get('code')==code):failures.append(dict(stage=stage,code=code,expected_status=expected,actual_status=status,body=body))
    if stage=='dispatch':assert isinstance(body.get('operation_id'),str) and body['id']==body['operation_id'],body
    results.append(dict(stage=stage,code=code,status=status))
  envelope=f.operation('99.9',ACTION,dict(stage='dispatch',code='DB_UNAVAILABLE',canary=CANARY));status,body=f.request(envelope,credential=uid(),headers={'X-Private-Canary':CANARY});assert status==401 and body.get('error',{}).get('code')=='AUTH_INVALID',(status,body)
  expected_events[envelope['operation_id']]={'status':401,'error_code':'AUTH_INVALID','correlation_id':envelope['correlation_id']}
  unknown_status=status
  for stage in ['predispatch','dispatch']:
   code='invalid-'+CANARY;envelope=f.operation('99.9',ACTION,dict(stage=stage,code=code,canary=CANARY));status,body=f.request(envelope,headers={'X-Private-Canary':CANARY});assert status==400 and body.get('error',{}).get('code')==code,(status,body)
   expected_events[envelope['operation_id']]={'status':400,'error_code':'HANDLER_FAILED','correlation_id':envelope['correlation_id']}
  malformed=f.operation('99.9',ACTION,dict(stage='dispatch',code='INVALID_REQUEST',canary=CANARY));malformed.update(operation_id=CANARY,correlation_id=CANARY);status,body=f.request(malformed,headers={'X-Private-Canary':CANARY});assert status==400 and body.get('ok') is False,(status,body)
  envelope=f.operation('99.9',ACTION,dict(stage='timer',code='OUTCOME_UNKNOWN',canary=CANARY));expected_events[envelope['operation_id']]={'status':504,'error_code':'OUTCOME_UNKNOWN','correlation_id':envelope['correlation_id']}
  try:
   status,body=f.request(envelope,headers={'X-Private-Canary':CANARY},timeout_seconds=5);assert status==504,(status,body)
  except (ConnectionError,http.client.HTTPException,TimeoutError):pass
  count=f.sql('SELECT count(*)::int AS n FROM hyperfide.identity_request_nonces WHERE credential_id=$1',[f.ids['operator']])[0]['n'];assert count>=len(results),'Fault cases did not cross actual PG authentication'
  f.child.send_signal(signal.SIGTERM);_,stderr=f.child.communicate(timeout=8);exit_code=f.child.returncode;f.child=None;assert exit_code==0,'Owned listener termination failed'
  diagnostics=[]
  assert CANARY not in stderr,'Private canary leaked to actual server stderr'
  for line in stderr.splitlines():
   event=json.loads(line);assert event.get('event')=='transport_request_failed',event
   assert len(line.encode())<=512 and set(event)<=set(['event','status','error_code','operation_id','correlation_id']),event
   diagnostics.append(event)
  assert len(diagnostics)==len(expected_events)+1,{'actual_count':len(diagnostics),'expected_count':len(expected_events)+1}
  seen=set();unidentified=[]
  for event in diagnostics:
   operation=event.get('operation_id')
   if operation is None:
    assert event=={'event':'transport_request_failed','status':400,'error_code':'INVALID_REQUEST'},event;unidentified.append(event);continue
   assert operation in expected_events and operation not in seen,event;seen.add(operation);expected=expected_events[operation]
   assert event['status']==expected['status'] and event['error_code']==expected['error_code'] and event.get('correlation_id')==expected['correlation_id'],event
  assert seen==set(expected_events) and len(unidentified)==1,'Failure diagnostics missing or duplicated'
  print(json.dumps(dict(status='FAIL' if failures else 'PASS',failures=failures,scope='actual TLS/Ed25519 and migrated PostgreSQL authentication; typed faults injected at temporary component and authorizer boundaries',results=results,unknown_credential_status=unknown_status,diagnostics={'events':len(diagnostics),'correlated_requests':len(seen),'unvalidated_uuid_omitted':True,'canary_redacted':True,'poisoned_codes_sanitized':True,'timer_event_deduplicated':True,'max_event_bytes':max(len(json.dumps(e).encode()) for e in diagnostics)},native_retry='COVERED_SEPARATELY',provider_live='UNRUN')))
  assert not failures,failures
  return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
