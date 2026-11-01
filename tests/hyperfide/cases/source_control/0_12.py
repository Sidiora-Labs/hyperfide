#!/usr/bin/env python3
"""Real signed API/PG boundary: cohort fencing and unavailable model idempotency.

Logical fixture identities establish authentication only; native model execution
and three actor/provider qualification are explicitly the separate 0.14 journey.
"""
from pathlib import Path
import json
import socket
import shutil
import hashlib
import os
import sys
import uuid
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type
from fleet_live_qualification import unavailable_model_response, Refused


def credential_store(f):
    secrets=f.path/'credential-secrets';attachments=f.path/'credential-attachments'
    secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700)
    config=f.path/'credential-store.json'
    config.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}))
    config.chmod(0o600);f.env['HF_CREDENTIAL_CONFIG_FILE']=str(config)
    native=json.loads((ROOT/'build/fleet/worker/private/native-profile.json').read_text())
    profile=native['profiles'][0];binary=f.path/'declared-claude'
    shutil.copyfile(ROOT/'build/fleet/worker/private/claude-2.1.300',binary);binary.chmod(0o555)
    assert 'sha256:'+hashlib.sha256(binary.read_bytes()).hexdigest()==profile['binary']['digest']
    home=f.path/'declared-native-home';home.mkdir(mode=0o700)
    os.chown(home,int(profile['target_uid']),int(profile['target_uid']))
    profile['binary']['path']=str(binary);profile['runtime_home']=str(home)
    inventory=f.path/'declared-native-profiles.json';inventory.write_text(json.dumps(native));inventory.chmod(0o600)
    f.env['HF_NATIVE_AUTH_PROFILES_FILE']=str(inventory)

def run():
    out = ROOT / 'build/fleet/0.12'
    out.mkdir(parents=True, exist_ok=True)
    f = None
    report = {'task':'0.12', 'status':'FAIL', 'live_model_qualified':False, 'assertions':[]}
    try:
        f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration']), bootstrap=False, seed_historical_runtime=False,extra_setup=credential_store)
        report['stage']='leader-acquire'
        f.ok('hierarchy.leader.acquire', {'idempotency_key':'012-leader', 'expected_generation':'0', 'reason':'Owned signed cohort qualification'})
        binding = {'actor_id':f.ids['leader'], 'actor_role':'PRIMARY', 'authority_epoch':f.ids['epoch'], 'leader_generation':'1', 'delegation_id':None, 'manager_generation':None}
        cohort = {'cohort_id':str(uuid.uuid4()), 'host_id':socket.gethostname(), 'leader_generation':'1', 'expected_generation':'0'}
        f.reject('fleet.cohort.bind', dict(cohort,host_id='wrong-host.invalid'), 'FLEET_HOST_MISMATCH', component='fleet-orchestration')
        report['stage']='cohort-bind'
        ready = f.ok('fleet.cohort.bind', cohort, component='fleet-orchestration')
        assert ready['model_session_observed'] is False
        report['stage']='observe'
        observed = f.ok('fleet.observe', {'binding':binding,'after':None,'limit':100}, component='fleet-orchestration')
        request = {'binding':binding,'operation_id':str(uuid.uuid4()),'observation_id':observed['observation_id']}
        report['stage']='reason-unavailable'
        status,body=f.invoke('fleet.session.reason',request,component='fleet-orchestration',key='leader')
        assert status==200 and body.get('ok') is True
        waiting=body['result']
        records=f.sql('SELECT id::text,state,reason FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[f.ids['organisation'],f.ids['run'],request['operation_id']])
        assert len(records)==1
        unavailable_model_response(body,records[0],[waiting['reason']])
        for field,value in [('deterministic_fallback',True),('reason','UNRELATED_FAILURE'),('operation_id',str(uuid.uuid4()))]:
            altered=json.loads(json.dumps(body));altered['result'][field]=value
            try: unavailable_model_response(altered,records[0],[waiting['reason']])
            except Refused: pass
            else: raise AssertionError('Unbound unavailable-model response accepted: '+field)
        assert waiting['state']=='WAITING_FOR_MANAGER' and waiting['deterministic_fallback'] is False
        report['stage']='reason-replay'
        replay = f.ok('fleet.session.reason', request, component='fleet-orchestration')
        assert replay['replayed'] is True and replay['model_replayed'] is False
        assert not f.sql('SELECT id FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',[f.ids['organisation'],f.ids['run']])
        report['assertions'].append('Missing model persists waiting without invented decision or repeated model attempt')
        report['stage']='cohort-replace'
        f.ok('fleet.cohort.bind', dict(cohort,expected_generation='1'), component='fleet-orchestration')
        f.reject('fleet.session.reason', dict(request,operation_id=str(uuid.uuid4())), 'FLEET_OBSERVATION_STALE', component='fleet-orchestration')
        report['assertions'].append('Replaced cohort fences old observations even with unchanged leader generation')
        report['status']='PASS'
    except Exception as error:
        report['error']=str(error)[:2400]
    finally:
        if f: f.close()
        (out/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
    return 0 if report['status']=='PASS' else 1

if __name__=='__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.12', run, ROOT / 'build/fleet/0.12'))
