#!/usr/bin/env python3
"""Real signed API/PG boundary: cohort fencing and unavailable model idempotency.

Logical fixture identities establish authentication only; native model execution
and three actor/provider qualification are explicitly the separate 0.14 journey.
"""
from pathlib import Path
import json
import socket
import sys
import uuid
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type


def run():
    out = ROOT / 'build/fleet/0.12'
    out.mkdir(parents=True, exist_ok=True)
    f = None
    report = {'task':'0.12', 'status':'FAIL', 'live_model_qualified':False, 'assertions':[]}
    try:
        f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration']), bootstrap=False, seed_historical_runtime=False)
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
        waiting = f.ok('fleet.session.reason', request, component='fleet-orchestration')
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
    raise SystemExit(run())
