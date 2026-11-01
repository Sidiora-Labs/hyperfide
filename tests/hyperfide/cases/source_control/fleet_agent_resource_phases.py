#!/usr/bin/env python3
"""Real signed AGENT claims and TEST job admission preserve separate resource phases."""
import importlib.util
import json
import os
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
spec = importlib.util.spec_from_file_location('agent_phase_scheduler_fixture', ROOT / 'tests/hyperfide/cases/tasks/5_1.py')
scheduler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scheduler)


def main():
    def setup(f):
        secrets, attachments = f.path / 'phase-secrets', f.path / 'phase-attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'phase-credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        f.env['HF_CREDENTIAL_CONFIG_FILE'] = str(credentials)
        native = json.loads((ROOT / 'build/fleet/worker/private/native-profile.json').read_text())
        native['profiles'] = native['profiles'][:1]
        profile = native['profiles'][0]
        binary = ROOT / 'build/fleet/worker/private/claude-2.1.300'
        assert scheduler.sha(binary.read_bytes()) == profile['binary']['digest']
        home = f.path / 'phase-native-home'
        home.mkdir(mode=0o700)
        os.chown(home, int(profile['target_uid']), int(profile['target_uid']))
        profile['binary']['path'], profile['runtime_home'] = str(binary), str(home)
        inventory = f.path / 'phase-native-profiles.json'
        inventory.write_text(json.dumps(native))
        inventory.chmod(0o600)
        f.env['HF_NATIVE_AUTH_PROFILES_FILE'] = str(inventory)
        f.sql('DELETE FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND id=$2', [f.ids['organisation'], f.accounts['TEST']])

    f = scheduler.SchedulerFixture(extra_components=component_closure(['fleet-orchestration']), extra_setup=setup)
    try:
        i = f.ids
        common = [i['organisation'], i['run']]
        requirements = f.packet_definition['resource_requirements']
        assert requirements['test_slots'] == 1 and requirements['build_slots'] == 1, requirements
        checks = []

        def account(ident):
            return f.sql('SELECT id::text,configured_limit::text,reserved::text,allocated::text,state_version::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND id=$2', [i['organisation'], ident])

        def dimensions(request):
            return f.sql('SELECT a.dimension,r.quantity::text,r.state FROM hyperfide.reservations r JOIN hyperfide.capacity_accounts a ON a.organisation_id=r.organisation_id AND a.id=r.capacity_account_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.request_id=$3 ORDER BY a.dimension', common + [request])

        scope = {'organisation_id': i['organisation'], 'run_id': i['run'], 'pool_id': i['pool'], 'authority_epoch': i['epoch'], 'leader_generation': '1', 'package_generation': '2', 'package_id': i['package']}

        def test_request():
            return {**scope, 'request_id': scheduler.uid(), 'task_id': i['task_a'], 'job_kind': 'TEST', 'priority': 0, 'wait_reason': 'CAPACITY', 'deadline_ms': 300000, 'dimensions': f.capacity('TEST')}

        f.ok('fleet.cohort.bind', {'cohort_id': scheduler.uid(), 'host_id': socket.gethostname(), 'leader_generation': '1', 'expected_generation': '0'}, component='fleet-orchestration')
        binding = {'actor_id': i['leader'], 'actor_role': 'PRIMARY', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': None, 'manager_generation': None}
        observed = f.ok('fleet.observe', {'binding': binding, 'after': None, 'limit': 100}, component='fleet-orchestration')
        contract = observed['action_contracts']['ASSIGN_WORKER']
        assert contract['slot_capacity_kind'] == 'AGENT' and contract['capacity_class'] == 'EXECUTION' and contract['test_slots_select_worker_kind'] is False and contract['build_and_test_admission'] == 'SEPARATE_JOB', contract
        task = next(row for row in observed['tasks'] if row['id'] == i['task_a'])
        policy = task['capacity_policy']
        assert policy['state'] == 'ACCEPTED_RESOURCE_POLICY' and policy['authority'] == 'NO_EXECUTION_ADMISSION', policy
        assignment = policy['worker_assignment']
        assert assignment['action'] == 'ASSIGN_WORKER' and assignment['slot_capacity_kind'] == 'AGENT' and assignment['capacity_class'] == 'EXECUTION', assignment
        assert assignment['base_dimensions'] == {'AGENT': '1', 'CPU_MILLIS': str(requirements['cpu_millis']), 'MEMORY_BYTES': requirements['memory_bytes'], 'DISK_BYTES': requirements['disk_bytes']}, assignment
        assert assignment['build_slots_reserved'] == 0 and assignment['test_slots_reserved'] == 0, assignment
        assert assignment['execution_profile'] == f.packet_definition['execution_profile'], assignment
        for kind, field in [('BUILD', 'build_slots'), ('TEST', 'test_slots')]:
            permission = policy['separate_job_permissions'][kind]
            assert permission['declared_slots'] == requirements[field] and permission['permitted'] is True and permission['admission'] == 'SEPARATE_JOB' and permission['slot_capacity_kind'] == kind, permission
            assert permission['base_dimensions'] == {kind: '1', 'CPU_MILLIS': str(requirements['cpu_millis']), 'MEMORY_BYTES': requirements['memory_bytes'], 'DISK_BYTES': requirements['disk_bytes']}, permission
        checks.append('signed fleet observation separates AGENT assignment vector from permitted BUILD/TEST job vectors without reserving either')
        build_before = account(f.accounts['BUILD'])
        absent_claim = f.prepare_claim('a')
        first = f.claim('a', absent_claim)
        assert first and account(f.accounts['TEST']) == []
        first_dimensions = dimensions(absent_claim['request_id'])
        assert {row['dimension'] for row in first_dimensions} == {'AGENT', 'CPU_MILLIS', 'MEMORY_BYTES', 'DISK_BYTES'}, first_dimensions
        assert account(f.accounts['BUILD']) == build_before
        response = f.invoke('scheduler.resources.queue', test_request(), key='manager', component='5.4')[1]
        assert response.get('error', {}).get('code') == 'CAPACITY_SCOPE_INVALID', response
        checks.append('accepted build_slots=1/test_slots=1 AGENT claim succeeds with no TEST account; TEST queue refuses missing account')
        f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,reserved,provenance_digest,qualification_state) VALUES($1,$2,$3,'TEST','EXECUTION',2,2,$4,'QUALIFIED')", [i['organisation'], f.accounts['TEST'], i['pool'], scheduler.sha(b'explicit exhausted TEST prerequisite')])
        held = scheduler.uid()
        f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,2,clock_timestamp()+interval '1 hour','PROVISIONING')", common + [held, scheduler.uid(), f.accounts['TEST']])
        test_before = account(f.accounts['TEST'])
        held_before = f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE id=$1', [held])
        exhausted_claim = f.prepare_claim('b')
        second = f.claim('b', exhausted_claim)
        assert second and account(f.accounts['TEST']) == test_before and account(f.accounts['BUILD']) == build_before
        assert f.sql('SELECT to_jsonb(r) AS row FROM hyperfide.reservations r WHERE id=$1', [held]) == held_before
        second_dimensions = dimensions(exhausted_claim['request_id'])
        assert {row['dimension'] for row in second_dimensions} == {'AGENT', 'CPU_MILLIS', 'MEMORY_BYTES', 'DISK_BYTES'}, second_dimensions
        checks.append('second AGENT claim succeeds with TEST exhausted and leaves TEST/BUILD accounts and held reservation unchanged')
        request = test_request()
        queued = f.ok('scheduler.resources.queue', request, key='manager', component='5.4')
        admission = {**scope, 'waiter_id': queued['waiter_id']}
        blocked = f.ok('scheduler.resources.admit', admission, key='manager', component='5.4')
        assert blocked['admitted'] is False and blocked['limiting_resource']['dimension'] == 'TEST', blocked
        assert dimensions(request['request_id']) == [] and account(f.accounts['TEST']) == test_before
        checks.append('actual TEST waiter stays queued at TEST exhaustion without partial reservation')
        f.sql('UPDATE hyperfide.capacity_accounts SET configured_limit=3,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], f.accounts['TEST']])
        admitted = f.ok('scheduler.resources.admit', admission, key='manager', component='5.4')
        assert admitted['admitted'] is True, admitted
        test_dimensions = dimensions(request['request_id'])
        assert {row['dimension'] for row in test_dimensions} == {'TEST', 'CPU_MILLIS', 'MEMORY_BYTES', 'DISK_BYTES'} and all(row['state'] == 'ALLOCATED' for row in test_dimensions), test_dimensions
        reservation = f.sql('SELECT r.id FROM hyperfide.reservations r WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.request_id=$3 AND r.capacity_account_id=$4', common + [request['request_id'], f.accounts['TEST']])[0]['id']
        binding = {'task_id': i['task_a'], 'job_kind': 'TEST', 'reservation_id': reservation, 'slot_id': i['slot_overlap'], 'sandbox_id': i['sandbox'], 'sandbox_boot_generation': '1', 'assignee_session_id': scheduler.uid()}
        refused = f.primary('return claims.bindJobReservation(tx,{...data.scope,...data.binding});', {'binding': binding})
        assert refused.get('error', {}).get('code') == 'JOB_SLOT_UNAVAILABLE', refused
        assert f.sql('SELECT id FROM hyperfide.resource_job_allocations WHERE organisation_id=$1 AND run_id=$2 AND request_id=$3', common + [request['request_id']]) == []
        slot, verifier = scheduler.uid(), scheduler.uid()
        f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,'separate-test-phase',1,'TEST','READY')", [i['organisation'], slot, i['sandbox']])
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,state) VALUES($1,$2,$3,'VERIFIER','fixture','fixture','declared-test-component-verifier',$4,$5,1,'REGISTERED')", common + [verifier, slot, i['sandbox']])
        binding.update(slot_id=slot, assignee_session_id=verifier)
        bound = f.primary('return claims.bindJobReservation(tx,{...data.scope,...data.binding});', {'binding': binding})
        assert bound.get('result', {}).get('slot_id') == slot and bound['result']['job_kind'] == 'TEST', bound
        assert account(f.accounts['BUILD']) == build_before
        checks.append('TEST admission uses its own account/vector and physical TEST slot; READY AGENT-only slot refuses')
        print(json.dumps({'status': 'PASS', 'scope': 'signed scheduler claims/job admission and real branded primary executor binding; controlled fixed envelope metadata', 'native_provider_qualification': 'NOT_CLAIMED', 'checks': checks, 'agent_claim_dimensions': [first_dimensions, second_dimensions], 'test_job_dimensions': test_dimensions, 'observed_capacity_policy': policy}))
    finally:
        f.close()


if __name__ == '__main__':
    main()
