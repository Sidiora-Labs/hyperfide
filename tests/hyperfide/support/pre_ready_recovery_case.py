"""Pre-readiness recovery authority against real scoped SDK, storage and native boundaries."""
import copy
import hashlib
import json
import os
from pathlib import Path
import signal
import time


def run_recovery_case(d):
    f=d['f'];holder=d['holder'];daemon=d['sleeper'];receipt_file=d['receipt_file'];original=receipt_file.read_bytes()
    def pin(data):return 'sha256:'+hashlib.sha256(data).hexdigest()
    def write(file,value):file.write_text(json.dumps(value,sort_keys=True,separators=(',',':')))
    def journals():return f.sql("SELECT id::text,state,result,request_digest FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='provider.bootstrap.daemon-recovery' ORDER BY id",[f.ids['organisation'],f.ids['run']])
    def call():return f.invoke('provider.intents.reconcile',{'intent_id':f.intent,'recover_observer':True},component='8.3',key='provisioner',timeout_seconds=60)[1]
    helper=Path(d['recovery_helper']).read_bytes();helper_digest=pin(helper)
    assert helper_digest!=d['native_pin'],'A genuinely distinct pinned recovery helper is required'
    artifact=d['upload_native'](helper)
    target='/opt/hyperfide/observer-recovery/'+helper_digest[7:]+'/hyperfide-native'
    ref={'artifact_id':artifact['artifact_id'],'storage_kind':'manifest','manifest_digest':artifact['digest'],'digest':helper_digest,'size_bytes':str(len(helper)),'target':target,'mode':'0500'}
    write(f.recovery_file,{'schema_version':1,'pools':[{'pool_id':f.pool,'configuration_digest':d['configuration'],'profile_id':f.profile,'preparation_digest':f.preparation,'helper_path':target,'helper_digest':helper_digest,'helper_file':ref}]})
    holder['handlers'].executables.add(str(d['remote'](target).resolve()))
    errors=[]
    prior=holder['original_process']['status'];holder['original_process']['status']='running'
    result=call();assert result.get('error',{}).get('code')=='DAEMON_RECOVERY_BOOTSTRAP' and journals()==[],result
    errors.append(result['error']['code']);holder['original_process']['status']=prior
    for key,code in [('manifest_digest','PROVIDER_BOOTSTRAP_RECEIPT'),('slot','PROVIDER_BOOTSTRAP_SLOT')]:
        bad=copy.deepcopy(d['receipt'])
        if key=='slot':bad['slots'][0]['uid']+=1
        else:bad[key]=pin(b'wrong physical receipt pin')
        write(receipt_file,bad);result=call();assert result.get('error',{}).get('code')==code and journals()==[],result
        errors.append(result['error']['code']);receipt_file.write_bytes(original)
    # An actual TLS outage leaves the existing native observer's own heartbeat RPC pending.
    state_file=Path(d['boot_root'])/'daemon'/'daemon-state.json'
    os.kill(f.child.pid,signal.SIGSTOP)
    try:
        os.kill(daemon.pid,signal.SIGCONT)
        until=time.monotonic()+8
        while time.monotonic()<until:
            state=json.loads(state_file.read_text())
            if state.get('pending',{} ) and state['pending'].get('kind')=='heartbeat':break
            if daemon.poll() is not None:raise AssertionError('Existing native observer exited before the controlled outage')
            time.sleep(.05)
        else:raise AssertionError('Actual native observer did not retain its pending heartbeat')
        os.kill(daemon.pid,signal.SIGSTOP)
    finally:os.kill(f.child.pid,signal.SIGCONT)
    before=f.sql('SELECT state_version::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[d['credential']])[0]
    os.kill(daemon.pid,signal.SIGKILL);daemon.wait(timeout=5)
    request=f.operation('8.3','provider.intents.reconcile',{'intent_id':f.intent,'recover_observer':True})
    response=f.request(request,key='provisioner',timeout_seconds=60)[1]
    retained=journals();assert len(retained)==1 and retained[0]['state']=='PENDING' and retained[0]['result']['phase']=='SUBMITTED',(response,retained)
    retained_request=retained[0]['result']['request'];assert retained_request['bootstrap_receipt_digest']==pin(original) and retained_request['bootstrap_receipt']==d['receipt']
    assert retained_request['permit']['previous_daemon']==d['previous']
    again=f.request(request,key='provisioner',timeout_seconds=60)[1]
    assert len(journals())==1 and journals()[0]['id']==retained[0]['id']
    row=f.sql('SELECT state,receipt,receipt_digest FROM hyperfide.provider_native_bootstraps WHERE intent_id=$1',[f.intent])[0]
    after=f.sql('SELECT state_version::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[d['credential']])[0]
    assert row=={'state':'OBSERVING','receipt':None,'receipt_digest':None} and after==before and receipt_file.read_bytes()==original,(row,before,after)
    print(json.dumps({'status':'PASS','scope':'signed preREADY recovery admission, trusted SDK historical completion/receipt input, real native pending RPC and actual helper delivery; full native bootstrap and successful recovery are not claimed','checks':['uncompleted original process refuses before journal','wrong manifest or slot receipt refuses before journal','actual existing native TLS outage retains pending RPC','dead observer admits one immutable recovery attempt with original receipt pins','exact replay retains attempt and OBSERVING remains without new signed heartbeat'],'errors':errors,'response':response,'replay':again,'journal':retained,'native_pending_operation_id':state['pending']['operation_id'],'runner_before':before,'runner_after':after}))
