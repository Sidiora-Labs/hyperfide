#!/usr/bin/env python3
"""Signed manager-effect refusal boundary on owned PostgreSQL/TLS.

Unjournalled client proposals must never create provider or worker effects.
These are adversarial API inputs, never fabricated model-session records.
Real model/provider/installation execution belongs to the live 0.14 campaign.
"""
from pathlib import Path
import hashlib
import json
import socket
import sys
import uuid

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type


def main():
    out = ROOT / 'build/fleet/0.13'
    out.mkdir(parents=True, exist_ok=True)
    f = None
    report = {'task': '0.13', 'status': 'FAIL', 'component_status': 'FAIL',
              'live_model_provider_installation': 'UNRUN', 'assertions': []}
    try:
        f = hierarchy_type()(extra_components=component_closure(['fleet-manager-effects', 'fleet-orchestration']),
                             bootstrap=False, seed_historical_runtime=False)
        f.ok('hierarchy.leader.acquire', {'idempotency_key': '013-leader', 'expected_generation': '0',
                                        'reason': 'Owned signed effect refusal qualification'})
        f.ok('fleet.cohort.bind', {'cohort_id': str(uuid.uuid4()), 'host_id': socket.gethostname(),
                                 'leader_generation': '1', 'expected_generation': '0'}, component='fleet-orchestration')
        for action in ['PROVISION_SANDBOX', 'ASSIGN_WORKER', 'DESTROY_SANDBOX', 'fleet.install.admit']:
            payload = {}
            digest = 'sha256:' + hashlib.sha256(b'{}').hexdigest()
            decision = {'schema_version': 1, 'kind': 'hyperfide.fleet-decision',
                        'decision_id': str(uuid.uuid4()), 'operation_id': str(uuid.uuid4()),
                        'run_id': f.ids['run'], 'actor_id': f.ids['leader'], 'actor_role': 'PRIMARY',
                        'authority_epoch': f.ids['epoch'], 'leader_generation': '1',
                        'delegation_id': None, 'manager_generation': None,
                        'source_revision': 'git:' + 'a' * 40, 'spec_revision': f.ids['spec'],
                        'context_digest': digest, 'action': action, 'input': payload, 'input_digest': digest,
                        'expected_version': '0', 'rationale_summary': 'Adversarial unjournalled API proposal'}
            f.reject('fleet.manager.execute', {'decision': decision}, 'FLEET_MODEL_DECISION_REQUIRED',
                     component='fleet-manager-effects')
            report['assertions'].append(action + ' refuses an unjournalled client proposal before effects')
        for table in ['fleet_decisions', 'fleet_effect_receipts', 'fleet_environment_installs', 'provisioning_intents']:
            rows = f.sql('SELECT count(*)::int AS n FROM hyperfide.' + table)
            if rows[0]['n'] != 0:
                raise AssertionError('Refused proposals left durable effects in ' + table)
        report['assertions'].append('Refused proposals leave no model journals, effect receipts, installs or provider intents')
        report['component_status'] = 'PASS'
        report['status'] = 'UNQUALIFIED'
    except Exception as error:
        report['error'] = str(error)[:2400]
    finally:
        if f:
            f.close()
        (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))
    return 77 if report['component_status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.13', main, ROOT / 'build/fleet/0.13'))
