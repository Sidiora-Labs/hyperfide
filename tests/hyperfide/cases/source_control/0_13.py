#!/usr/bin/env python3
"""Signed manager-effect refusal boundary on owned PostgreSQL/TLS.

Unjournalled client proposals must never create provider or worker effects.
These are adversarial API inputs, never fabricated model-session records.
Real model/provider/installation execution belongs to the live 0.14 campaign.
"""
from pathlib import Path
import hashlib
import json
import importlib.util
import select
import subprocess
import datetime
import socket
import sys
import uuid

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type


def effect_snapshot(f):
    tables = ('fleet_decisions', 'fleet_reasoning', 'fleet_effect_receipts',
              'fleet_environment_installs', 'provisioning_intents', 'reservations',
              'attempts', 'compute_leases', 'runner_remote_jobs', 'fleet_worker_launches')
    result = {table: f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.' + table +
                           ' t ORDER BY to_jsonb(t)::text') for table in tables}
    result['actors'] = f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.fleet_actor_sessions t ORDER BY session_id')
    return result


def proposal(f, action, payload, **binding):
    value = {'schema_version': 1, 'kind': 'hyperfide.fleet-decision',
             'decision_id': str(uuid.uuid4()), 'operation_id': str(uuid.uuid4()),
             'run_id': f.ids['run'], 'actor_id': f.ids['leader'], 'actor_role': 'PRIMARY',
             'authority_epoch': f.ids['epoch'], 'leader_generation': '1',
             'delegation_id': None, 'manager_generation': None,
             'source_revision': 'git:' + 'a' * 40, 'spec_revision': f.ids['spec'],
             'context_digest': 'sha256:' + hashlib.sha256(b'{}').hexdigest(),
             'action': action, 'input': payload,
             'input_digest': 'sha256:' + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
             'expected_version': '0', 'rationale_summary': 'Adversarial unjournalled API proposal'}
    return dict(value, **binding)


def test_manager_execute_scope_refusals(f, report):
    for package, manager, feature in [('package', 'manager', 'alpha'), ('wave_package', 'manager2', 'beta')]:
        f.ok('hierarchy.package.configure', {'idempotency_key': '013-configure-' + package,
             'leader_generation': '1', 'package_id': f.ids[package],
             'feature_key': feature, 'allocation_policy': 'WAVE'})
        f.ok('hierarchy.package.assign', {'idempotency_key': '013-assign-' + package,
             'leader_generation': '1', 'package_id': f.ids[package],
             'expected_generation': '1', 'manager_session_id': f.ids[manager]})
    binding = {'actor_id': f.ids['manager'], 'actor_role': 'WAVE_MANAGER',
               'authority_epoch': f.ids['epoch'], 'leader_generation': '1',
               'delegation_id': f.ids['package'], 'manager_generation': '2'}
    f.ok('fleet.session.bind', {'binding': binding}, key='manager', component='fleet-orchestration')
    for action in ('ASSIGN_WORKER', 'DESTROY_SANDBOX'):
        # A current manager reaches the journal boundary; no model decision is invented.
        current = proposal(f, action, {}, **binding)
        before = effect_snapshot(f)
        f.reject('fleet.manager.execute', {'decision': current}, 'FLEET_MODEL_DECISION_REQUIRED',
                 key='manager', component='fleet-manager-effects')
        assert effect_snapshot(f) == before, 'Current unjournalled manager proposal left effects'
        for label, changes, code in [
            ('stale-manager-generation', {'manager_generation': '1'}, 'PACKAGE_GENERATION_STALE'),
            ('cross-package-selection', {'delegation_id': f.ids['wave_package']}, 'PACKAGE_OWNER_MISMATCH'),
        ]:
            decision = proposal(f, action, {}, **dict(binding, **changes))
            before = effect_snapshot(f)
            response = f.reject('fleet.manager.execute', {'decision': decision}, code,
                                key='manager', component='fleet-manager-effects')
            assert response['error']['code'] == code
            assert effect_snapshot(f) == before, label + ' left durable effects or advanced the actor plan'
            report['assertions'].append(action + ' ' + label + ' refuses with ' + code + ' and no effects')
            report['refusals'].append({'case': label, 'action': action, 'code': code,
                                       'decision_id': decision['decision_id'], 'operation_id': decision['operation_id']})


def main():
    out = ROOT / 'build/fleet/0.13'
    out.mkdir(parents=True, exist_ok=True)
    f = None
    source_backend = None
    report = {'task': '0.13', 'status': 'FAIL', 'component_status': 'FAIL',
              'live_model_provider_installation': 'UNRUN', 'qualified': False, 'assertions': [], 'refusals': []}
    try:
        setup_spec = importlib.util.spec_from_file_location('fleet_component_setup_013', Path(__file__).with_name('0_12.py'))
        setup_module = importlib.util.module_from_spec(setup_spec)
        setup_spec.loader.exec_module(setup_module)
        source_backend = subprocess.Popen(['node', '--input-type=module', '-e',
            "import{createSourceS3Fixture}from'./tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],
            cwd=ROOT, stdout=subprocess.PIPE, text=True)
        assert select.select([source_backend.stdout], [], [], 15)[0], 'Owned source backend readiness failed'
        storage = json.loads(source_backend.stdout.readline())
        source_environment = {'HF_SOURCE_S3_ENDPOINT': storage['endpoint'], 'HF_SOURCE_S3_REGION': storage['region'],
            'HF_SOURCE_S3_BUCKET': storage['bucket'], 'HF_SOURCE_S3_ACCESS_KEY_ID': storage['accessKey'],
            'HF_SOURCE_S3_SECRET_ACCESS_KEY': storage['secretKey'], 'HF_SOURCE_ALLOW_LOOPBACK_HTTP': '1',
            'HF_SOURCE_CURSOR_KEY': 'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk',
            'HF_SOURCE_CACHE_BYTES': '16777216', 'HF_SOURCE_CACHE_ENTRIES': '1024', 'HF_SOURCE_MAX_FILE_BYTES': '8388608',
            'HF_SOURCE_MATERIALIZED_BYTES': '67108864', 'HF_SOURCE_DIRTY_BYTES': '16777216'}
        components = component_closure(['fleet-manager-effects', 'fleet-orchestration'])
        grants = {'programme.activate', 'programme.provision', 'programme.dispatch'}
        for name in set(components + ['1.4', '4.1', '4.2', '4.4', '14.1']):
            grants.update(action for action in json.loads((ROOT / 'core/control-plane/components' / (name + '.json')).read_text())['actions'] if not action.startswith('source.'))
        f = hierarchy_type()(extra_components=components, credential_actions=sorted(grants),
                             bootstrap=False, seed_historical_runtime=False,
                             extra_setup=setup_module.credential_store, extra_env=source_environment)
        f.ok('hierarchy.leader.acquire', {'idempotency_key': '013-leader', 'expected_generation': '0',
                                        'reason': 'Owned signed effect refusal qualification'})
        f.ok('fleet.cohort.bind', {'cohort_id': str(uuid.uuid4()), 'host_id': socket.gethostname(),
                                 'leader_generation': '1', 'expected_generation': '0'}, component='fleet-orchestration')
        for action in ['PROVISION_SANDBOX', 'ASSIGN_WORKER', 'DESTROY_SANDBOX', 'fleet.install.admit']:
            payload = {}
            if action == 'PROVISION_SANDBOX':
                payload = {'pool_id': f.ids['pool'], 'provider_id': 'fixture', 'profile_id': 'ungranted',
                           'sandbox_id': str(uuid.uuid4()), 'preparation_digest': f.preparation,
                           'deadline_at': (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5)).isoformat(),
                           'capacity': [], 'purpose': 'CODING'}
            decision = proposal(f, action, payload)
            f.reject('fleet.manager.execute', {'decision': decision}, 'FLEET_MODEL_DECISION_REQUIRED',
                     component='fleet-manager-effects')
            report['assertions'].append(action + ' refuses an unjournalled client proposal before effects')
        for table in ['fleet_decisions', 'fleet_effect_receipts', 'fleet_environment_installs', 'provisioning_intents']:
            rows = f.sql('SELECT count(*)::int AS n FROM hyperfide.' + table)
            if rows[0]['n'] != 0:
                raise AssertionError('Refused proposals left durable effects in ' + table)
        report['assertions'].append('Refused proposals leave no model journals, effect receipts, installs or provider intents')
        test_manager_execute_scope_refusals(f, report)
        report['component_status'] = 'PASS'
        report['status'] = 'UNQUALIFIED'
    except Exception as error:
        report['error'] = str(error)[:2400]
    finally:
        if f:
            f.close()
        if source_backend:
            source_backend.terminate()
            source_backend.wait(timeout=15)
        (out / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
        (out / 'receipt.json').chmod(0o600)
    print(json.dumps(report))
    return 0 if report['component_status'] == 'PASS' else 1


if __name__ == '__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.13', main, ROOT / 'build/fleet/0.13'))
