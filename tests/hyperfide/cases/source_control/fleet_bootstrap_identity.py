#!/usr/bin/env python3
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type

OUT = ROOT / 'build/fleet/bootstrap-identity'


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', sys.executable, str(Path(__file__).resolve())], cwd=ROOT).returncode
    f = None
    checks = []
    try:
        host = socket.gethostname()
        f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration']), bootstrap=False,
            seed_historical_runtime=False, parent_managers=True, native_session_placeholders=False,
            extra_env={'HYPERFIDE_FLEET_HOST_ID': host})
        ids = f.ids
        cohort = str(uuid.uuid4())
        actions = ['hierarchy.leader.acquire', 'fleet.cohort.bind', 'fleet.session.bind', 'fleet.observe', 'fleet.session.reason', 'fleet.decision.inspect', 'fleet.decision.apply']
        payload = {'session_id': ids['leader'], 'public_key_b64': f.keys['leader']['public_key_b64'],
            'allowed_actions': actions, 'ttl_seconds': 300, 'authority_epoch': ids['epoch'],
            'leader_generation': '0', 'delegation_id': None, 'manager_generation': None,
            'host_id': host, 'cohort_id': cohort, 'cohort_generation': '0'}

        def request(action, value, key='operator', credential=None, component='fleet-orchestration'):
            return f.invoke(action, value, component=component, key=key, **({'credential': credential} if credential else {}))[1]

        def rejected(name, response, code):
            if response.get('ok') is not False or response.get('error', {}).get('code') != code:
                raise AssertionError(name + ': expected ' + code + ', observed ' + json.dumps(response))
            checks.append({'id': name, 'status': 'PASS'})

        def accepted(name, response):
            if response.get('ok') is not True:
                raise AssertionError(name + ': ' + json.dumps(response))
            checks.append({'id': name, 'status': 'PASS'})
            return response['result']

        rejected('operator-only', request('fleet.identity.bootstrap', payload, key='provisioner'), 'FLEET_BOOTSTRAP_OPERATOR_REQUIRED')
        rejected('action-escalation', request('fleet.identity.bootstrap', dict(payload, allowed_actions=['provider.intents.execute'])), 'FLEET_BOOTSTRAP_SCOPE')
        rejected('wrong-host', request('fleet.identity.bootstrap', dict(payload, host_id='wrong-host')), 'FLEET_BOOTSTRAP_SCOPE')
        rejected('unacquired-generation', request('fleet.identity.bootstrap', dict(payload, leader_generation='1')), 'FLEET_BOOTSTRAP_STALE')
        rejected('manager-before-delegation', request('fleet.identity.bootstrap', dict(payload, session_id=ids['manager'], public_key_b64=f.keys['manager']['public_key_b64'], allowed_actions=['fleet.observe'])), 'FLEET_BOOTSTRAP_SCOPE')
        accepted('foreign-key-principal-revoked', request('identity.principal.revoke', {'credential_id':ids['provisioner'],'expected_version':'1'}, component='14.1'))
        rejected('revoked-crossactor-key-reuse', request('fleet.identity.bootstrap', dict(payload, public_key_b64=f.keys['provisioner']['public_key_b64'])), 'FLEET_BOOTSTRAP_KEY_REUSED')
        operation = f.operation('fleet-orchestration', 'fleet.identity.bootstrap', payload)
        first = accepted('initial-primary-issued', f.request(operation)[1])
        replay = accepted('same-issuance-replayed', f.request(operation)[1])
        if first != replay or first.get('model_observed') is not False:
            raise AssertionError('Bootstrap replay changed or invented a model observation')
        credential = first['credential_id']
        binding = {'actor_id':ids['leader'],'actor_role':'PRIMARY','authority_epoch':ids['epoch'],'leader_generation':'1','delegation_id':None,'manager_generation':None}
        rejected('reason-before-leadership', request('fleet.observe', {'binding':binding,'after':None,'limit':1}, key='leader', credential=credential), 'FLEET_BOOTSTRAP_LEADERSHIP_REQUIRED')
        leader = accepted('actual-initial-leadership', request('hierarchy.leader.acquire', {'idempotency_key':'bootstrap-boundary-leader','expected_generation':'0','reason':'Initial supervisor enrollment'}, key='leader', credential=credential, component='3.1'))
        if leader['leader_generation'] != '1':
            raise AssertionError('Initial leader generation differs')
        rejected('reason-before-cohort', request('fleet.observe', {'binding':binding,'after':None,'limit':1}, key='leader', credential=credential), 'FLEET_BOOTSTRAP_COHORT_REQUIRED')
        bound = accepted('actual-initial-cohort', request('fleet.cohort.bind', {'cohort_id':cohort,'host_id':host,'leader_generation':'1','expected_generation':'0'}, key='leader', credential=credential))
        if bound['cohort_generation'] != '1':
            raise AssertionError('Initial cohort generation differs')
        accepted('current-session-bound', request('fleet.session.bind', {'binding':binding}, key='leader', credential=credential))
        rejected('implicit-cohort-replacement', request('fleet.cohort.bind', {'cohort_id':cohort,'host_id':host,'leader_generation':'1','expected_generation':'1'}, key='leader', credential=credential), 'FLEET_BOOTSTRAP_REPLACEMENT_REQUIRED')
        renewed = accepted('same-key-current-renewal', request('fleet.identity.bootstrap', dict(payload, leader_generation='1', cohort_generation='1')))
        rejected('old-credential-revoked', request('fleet.session.bind', {'binding':binding}, key='leader', credential=credential), 'AUTH_REVOKED')
        credential = renewed['credential_id']
        accepted('renewed-credential-authenticates', request('fleet.session.bind', {'binding':binding}, key='leader', credential=credential))
        replacement = accepted('explicit-cohort-replacement-issued', request('fleet.identity.bootstrap', dict(payload, leader_generation='1', cohort_generation='1', replace_cohort=True)))
        credential = replacement['credential_id']
        if replacement['cohort_generation'] != '2':
            raise AssertionError('Replacement did not pin exact next generation')
        rejected('replacement-cannot-reason-before-bind', request('fleet.observe', {'binding':binding,'after':None,'limit':1}, key='leader', credential=credential), 'FLEET_BOOTSTRAP_COHORT_STALE')
        accepted('explicit-replacement-bound', request('fleet.cohort.bind', {'cohort_id':cohort,'host_id':host,'leader_generation':'1','expected_generation':'1'}, key='leader', credential=credential))
        accepted('replacement-current-session-bound', request('fleet.session.bind', {'binding':binding}, key='leader', credential=credential))
        observed = f.sql('SELECT native_session_id FROM hyperfide.agent_sessions WHERE organisation_id=$1 AND run_id=$2 AND id=$3', [ids['organisation'], ids['run'], ids['leader']])
        if observed[0]['native_session_id'] is not None:
            raise AssertionError('Bootstrap invented a native session identity')
        checks.append({'id':'native-identity-remains-unobserved','status':'PASS'})
        report = {'status':'PASS','scope':'signed-supervisor-bootstrap-authority','assertions':checks}
        (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'status':'PASS','assertions':len(checks),'receipt':str(OUT / 'receipt.json')}))
        return 0
    except Exception as error:
        (OUT / 'receipt.json').write_text(json.dumps({'status':'FAIL','scope':'signed-supervisor-bootstrap-authority','assertions':checks,'error':str(error)}, indent=2) + '\n')
        print(str(error), file=sys.stderr)
        return 1
    finally:
        if f is not None:
            f.close()


if __name__ == '__main__':
    raise SystemExit(main())
