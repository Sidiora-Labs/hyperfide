#!/usr/bin/env python3
"""Signed fleet admission preflight with protected local descriptor metadata, not cloud execution proof."""
import copy
import importlib.util
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type
from identity_fixture import sha
spec = importlib.util.spec_from_file_location('capability_preparation_fixture', ROOT / 'tests/hyperfide/cases/tasks/11_1.py')
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)


def uid():
    return str(uuid.uuid4())


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def main():
    anchor_only = os.environ.get('HF_PROVISION_ANCHOR_ONLY') == '1'
    if os.environ.get('HF_PROVISION_ANCHOR_RUNTIME_ROOT'):
        import identity_fixture
        identity_fixture.ROOT = Path(os.environ['HF_PROVISION_ANCHOR_RUNTIME_ROOT'])
    def setup(f):
        secrets, attachments = f.path / 'capability-secrets', f.path / 'capability-attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'capability-credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        f.env['HF_CREDENTIAL_CONFIG_FILE'] = str(credentials)
        native = json.loads((ROOT / 'build/fleet/worker/private/native-profile.json').read_text())
        native['profiles'] = native['profiles'][:1]
        profile = native['profiles'][0]
        binary = ROOT / 'build/fleet/worker/private/claude-2.1.300'
        assert sha(binary.read_bytes()) == profile['binary']['digest']
        home = f.path / 'capability-native-home'
        home.mkdir(mode=0o700)
        os.chown(home, int(profile['target_uid']), int(profile['target_uid']))
        profile['binary']['path'], profile['runtime_home'] = str(binary), str(home)
        inventory = f.path / 'capability-native-profiles.json'
        inventory.write_text(json.dumps(native))
        inventory.chmod(0o600)
        f.env['HF_NATIVE_AUTH_PROFILES_FILE'] = str(inventory)
        declared = preparation.Fixture(f.path / 'declared-capability-profile')
        f.manifest = declared.create()
        f.profile_id = uid()
        f.pool_ids = {'coding': uid(), 'test': uid()}
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'railway','linux-amd64',$4)", [f.ids['organisation'], f.profile_id, f.manifest['digest'], f.manifest])
        limits = {'SANDBOX': '10', 'PROVISIONING': '10', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'ISOLATED_CAPABILITY_PREREQUISITES', 'accounts': [{'provider': 'railway', 'account_key': 'capability-component', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': pool, 'provider': 'railway', 'account_key': 'capability-component', 'environment_key': 'capability-' + role, 'region': 'component-region', 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'approved_limits': limits, 'planning_limits': limits, 'execution_role': {'schema_version': 1, 'kind': role.upper()}, 'create_policy': {'seed_reference': 'ISOLATED_NOT_PROVISIONED', 'network': 'ISOLATED', 'stdin_required': False}} for role, pool in f.pool_ids.items()], 'maximum_operation_ms': 120000}
        config_file = f.path / 'capability-pools.json'
        config_file.write_text(json.dumps(f.config))
        config_file.chmod(0o600)
        f.env['HYPERFIDE_POOL_CONFIG'] = str(config_file)
        f.descriptor_path = f.path / 'capability-bootstrap.json'
        f.descriptor_path.write_text('{}')
        f.descriptor_path.chmod(0o600)
        f.env['HF_PROVIDER_BOOTSTRAP_CONFIG_FILE'] = str(f.descriptor_path)

    if anchor_only:
        module = importlib.util.spec_from_file_location('anchor_capability_assignment', ROOT / 'tests/hyperfide/cases/source_control/fleet_selected_assignment.py')
        assignment = importlib.util.module_from_spec(module); module.loader.exec_module(assignment)
        f = assignment.AssignmentFixture(extra_components=component_closure(['fleet-orchestration']), extra_setup=setup)
    else:
        f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration']), extra_setup=setup, seed_historical_runtime=False, parent_managers=True)
    try:
        i = f.ids
        manager_key = 'manager' if anchor_only else 'manager2'
        package_id = i['package'] if anchor_only else i['wave_package']
        common = [i['organisation'], i['run']]

        def api(action, value, key='leader'):
            return f.invoke(action, value, component='fleet-orchestration', key=key)[1]

        def ok(action, value, key='leader'):
            response = api(action, value, key)
            assert response.get('ok'), response
            return response['result']

        cohort = uid()
        ok('fleet.cohort.bind', {'cohort_id': cohort, 'host_id': socket.gethostname(), 'leader_generation': '1', 'expected_generation': '0'})
        binding = {'actor_id': i[manager_key], 'actor_role': 'WAVE_MANAGER', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': package_id, 'manager_generation': '2'}
        budget = {'allowed_actions': ['PROVISION_SANDBOX'], 'provider_ids': ['railway'], 'profile_ids': [f.profile_id], 'max_sandboxes': 10, 'max_concurrent_workers': 1, 'task_ids': [i['task_a'], i['task_overlap']] if anchor_only else []}
        f.sql('INSERT INTO hyperfide.fleet_delegations(organisation_id,run_id,package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id) VALUES($1,$2,$3,$4,2,1,$5,$6)', common + [package_id, i[manager_key], json.dumps(budget), uid()])
        ok('fleet.session.bind', {'binding': binding}, manager_key)
        scopes = {}
        accounts = []
        for pool in f.config['pools']:
            scope = {'organisation_id': i['organisation'], 'pool_id': pool['id'], 'provider': pool['provider'], 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': digest({'revision': f.config['revision'], 'pool': pool, 'account': f.config['accounts'][0]})}
            scopes[pool['id']] = scope
            f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'railway',$3,$4,$5,$6)", [i['organisation'], pool['id'], pool['account_key'], pool['environment_key'], pool['region'], f.profile_id])
            f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], pool['id'], scope['configuration_digest'], json.dumps({'scope': scope, 'pool': pool, 'account': f.config['accounts'][0]})])
            resources = {'SANDBOX': '1', 'CPU_MILLIS': str(f.manifest['profile']['resources']['cpu_millis']), 'MEMORY_BYTES': str(f.manifest['profile']['resources']['memory_bytes']), 'DISK_BYTES': str(f.manifest['profile']['resources']['disk_bytes'])}
            for dimension, quantity in resources.items():
                account = uid()
                limit = f.config['accounts'][0]['approved_limits'][dimension]
                f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,provenance_digest,qualification_state) VALUES($1,$2,$3,$4,'PHYSICAL',$5,$6,'QUALIFIED')", [i['organisation'], account, pool['id'], dimension, limit, sha(b'controlled-capacity-prerequisite')])
                if pool['id'] == f.pool_ids['coding']:
                    accounts.append({'capacity_account_id': account, 'quantity': quantity})
            for dimension, limit in pool['approved_limits'].items():
                for kind, key in [('ACCOUNT', pool['account_key']), ('ENVIRONMENT', pool['environment_key'])]:
                    f.sql("INSERT INTO hyperfide.provider_quota_observations(organisation_id,id,pool_id,configuration_digest,provider,account_key,scope_kind,scope_key,dimension,quota_limit,observed_at,expires_at,evidence_digest,basis,evidence_reference) VALUES($1,$2,$3,$4,'railway',$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp()+interval '1 hour',$10,'VERIFIED_OPERATOR_ATTESTATION','ISOLATED_COMPONENT_PREREQUISITE')", [i['organisation'], uid(), pool['id'], scope['configuration_digest'], pool['account_key'], kind, key, dimension, limit, sha(b'controlled-quota-prerequisite')])
        recipe = {'pool_id': f.pool_ids['coding'], 'configuration_digest': scopes[f.pool_ids['coding']]['configuration_digest'], 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'native_path': '/opt/component/native', 'native_digest': sha(b'declared-native-metadata-only'), 'manifest_path': '/run/component/manifest', 'secret_path': '/run/component/secret', 'files': [{'artifact_id': uid(), 'storage_kind': 'object', 'digest': sha(b'declared-artifact-only'), 'size_bytes': '0', 'target': '/opt/component/input', 'mode': '0444'}], 'allowed_actions': ['identity.principal.delegate', 'instructions.consumer.register'], 'grant_ttl_seconds': 600, 'native_template': {'runner_config': {'schema_version': 1}, 'slots': [{'kind': 'PREPARATION'}, {'kind': 'AGENT'}]}, 'install_template': {}}
        descriptor = {'schema_version': 1, 'origin': 'https://component.invalid', 'ca_file': '/etc/component/ca.pem', 'state_root': '/remote-component-state-not-on-control-host', 'pools': [recipe]}

        def write_descriptor(value):
            f.descriptor_path.write_text(json.dumps(value))
            f.descriptor_path.chmod(0o600)

        def decision(value):
            operation, ident, observation, reasoning = [uid() for _ in range(4)]
            plan = f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3', common + [i[manager_key]])[0]['plan_generation']
            body = {'schema_version': 1, 'kind': 'hyperfide.fleet-decision', 'decision_id': ident, 'operation_id': operation, 'run_id': i['run'], **binding, 'source_revision': 'git:' + (f.source if anchor_only else 'a' * 40), 'spec_revision': i['accepted_spec'] if anchor_only else i['spec'], 'context_digest': sha(operation.encode()), 'action': 'PROVISION_SANDBOX', 'input': value, 'input_digest': digest(value), 'expected_version': plan, 'rationale_summary': 'Explicit isolated admission contract input; no model inference claimed'}
            f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{\"component_fixture\":true}')", common + [observation, i[manager_key], body['context_digest']])
            f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED','{\"component_fixture\":true}')", common + [reasoning, i[manager_key], body['context_digest'], observation])
            f.sql('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', common + [ident, operation, i[manager_key], body['action'], body['context_digest'], digest(body), reasoning, json.dumps(body)])
            return body

        def provision():
            return {'pool_id': f.pool_ids['coding'], 'provider_id': 'railway', 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'sandbox_id': uid(), 'purpose': 'PREPARATION', 'deadline_at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + 60)), 'capacity': accounts}

        def snapshot():
            return {**{table: f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.' + table + ' t ORDER BY id') for table in ['reservations', 'provisioning_intents', 'capacity_accounts', 'sandboxes', 'provider_remote_operations']}, 'fleet_effect_receipts': f.sql('SELECT to_jsonb(e) AS row FROM hyperfide.fleet_effect_receipts e ORDER BY operation_id')}

        checks = []
        if anchor_only:
            def anchor_snapshot():
                return {**snapshot(), 'effects': f.sql('SELECT operation_id,result FROM hyperfide.fleet_effect_receipts ORDER BY operation_id'), 'attempts': f.sql('SELECT id FROM hyperfide.attempts ORDER BY id'), 'allocations': f.sql('SELECT id,state FROM hyperfide.resource_job_allocations ORDER BY id')}
            def apply_anchor(name, selector=None, code=None):
                value = provision()
                if selector is not None: value['preparation_task_id'] = selector
                chosen = decision(value)
                before = anchor_snapshot()
                response = api('fleet.decision.apply', {'decision': chosen}, manager_key)
                if code:
                    assert response.get('error', {}).get('code') == code, (name, response)
                    assert anchor_snapshot() == before, name
                else:
                    assert response.get('ok') is True, (name, response)
                    result = response['result']
                    assert result['kind'] == 'PROVISION_SANDBOX' and result['external_call_performed'] is False
                    assert f.sql('SELECT state FROM hyperfide.provisioning_intents WHERE id=$1', [result['provider_intent_id']]) == [{'state': 'RECORDED'}]
                    assert not f.sql('SELECT id FROM hyperfide.attempts')
                checks.append(name)
                return response, chosen
            descriptor['pools'][0]['install_template'] = {'schema_version': 1}
            write_descriptor(descriptor)
            apply_anchor('explicit-v1-refuses-before-effects', i['task_a'], 'FLEET_PREPARATION_TASK_TEMPLATE')
            legacy, _ = apply_anchor('legacy-omission-retains-admission')
            assert 'preparation_task_id' not in legacy['result']
            descriptor['pools'][0]['install_template'] = {'schema_version': 2}
            write_descriptor(descriptor)
            apply_anchor('ambiguous-v2-refuses-before-effects', code='BOOTSTRAP_INSTALL_TASK_SELECTION_REQUIRED')
            apply_anchor('cross-wave-v2-refuses-before-effects', i['task_b'], 'BOOTSTRAP_INSTALL_TASK_SCOPE')
            apply_anchor('unknown-task-v2-refuses-before-effects', uid(), 'BOOTSTRAP_INSTALL_TASK_SCOPE')
            accepted, chosen = apply_anchor('explicit-v2-current-accepted-anchor-admitted', i['task_overlap'])
            assert accepted['result']['preparation_task_id'] == i['task_overlap'] and accepted['result']['preparation_task_selection'] == 'EXPLICIT_PREPARATION_TASK'
            before = anchor_snapshot()
            replay = api('fleet.decision.apply', {'decision': chosen}, manager_key)
            assert replay.get('ok') is True and replay['result']['replayed'] is True and anchor_snapshot() == before
            checks.append('exact-replay-retains-anchor-and-ledger')
            f.sql("UPDATE hyperfide.fleet_delegations SET budget=jsonb_set(budget,'{task_ids}',$2::jsonb) WHERE package_id=$1", [package_id, json.dumps([i['task_a']])])
            sole, _ = apply_anchor('sole-v2-accepted-fallback-admitted')
            assert sole['result']['preparation_task_id'] == i['task_a'] and sole['result']['preparation_task_selection'] == 'SOLE_CURRENT_DELEGATED_TASK'
            f.sql("UPDATE hyperfide.fleet_delegations SET budget=jsonb_set(budget,'{task_ids}',$2::jsonb) WHERE package_id=$1", [package_id, json.dumps([i['task_missing']])])
            apply_anchor('unaccepted-v2-refuses-before-effects', i['task_missing'], 'BOOTSTRAP_INSTALL_TASK_UNACCEPTED')
            report = {'status': 'PASS', 'scope': 'actual signed PROVISION and PostgreSQL; declared profile/recipe/decision prerequisites, no model/native/provider execution', 'checks': checks, 'provider_calls': 0, 'model_inference': 'UNRUN', 'native_execution': 'UNRUN'}
            out = ROOT / 'build/fleet/integration/private/fleet-provision-anchor-component-receipt.json'
            out.parent.mkdir(parents=True, exist_ok=True); out.write_text(json.dumps(report, indent=2)+'\n'); out.chmod(0o600)
            print(json.dumps(report))
            return
        cases = [
            ('missing-recipe', lambda d: d['pools'][0].update(pool_id=uid()), 'UNCONFIGURED', None),
            ('mismatched-configuration', lambda d: d['pools'][0].update(configuration_digest=sha(b'wrong-configuration')), 'MISMATCH', None),
            ('mismatched-profile', lambda d: d['pools'][0].update(profile_id=uid()), 'MISMATCH', None),
            ('null-slots', lambda d: d['pools'][0]['native_template'].update(slots=[None]), 'MISMATCH', None),
            ('missing-runner-config', lambda d: d['pools'][0]['native_template'].pop('runner_config'), 'UNCONFIGURED', 'RUNNER_CONFIG_PRODUCER_UNCONFIGURED'),
            ('wrong-runner-config-schema', lambda d: d['pools'][0]['native_template'].update(runner_config={'schema_version': 2}), 'UNCONFIGURED', 'RUNNER_CONFIG_PRODUCER_UNCONFIGURED'),
            ('caller-selected-consumer-id', lambda d: d['pools'][0]['native_template'].update(runner_config={'schema_version': 1, 'consumer_id': uid()}), 'UNCONFIGURED', 'RUNNER_CONFIG_PRODUCER_UNCONFIGURED'),
            ('missing-consumer-registration-grant', lambda d: d['pools'][0].update(allowed_actions=['identity.principal.delegate']), 'UNCONFIGURED', 'RUNNER_CONSUMER_REGISTRATION_REQUIRED'),
        ]
        for name, mutate, status, reason in cases:
            changed = copy.deepcopy(descriptor)
            mutate(changed)
            write_descriptor(changed)
            support_observation = ok('fleet.observe', {'binding': binding, 'after': None, 'limit': 100}, manager_key)
            support = next(pool['native_bootstrap'] for pool in support_observation['provider_pools'] if pool['id'] == f.pool_ids['coding'])
            assert support['status'] == status, (name, support)
            if reason:
                assert support['reason'] == reason, (name, support)
            before = snapshot()
            response = api('fleet.decision.apply', {'decision': decision(provision())}, manager_key)
            assert response.get('error', {}).get('code') == 'FLEET_BOOTSTRAP_UNSUPPORTED', (name, response)
            assert snapshot() == before, name
            checks.append(name + ' refuses before reservations, counters, sandboxes or provider intents')
        write_descriptor(descriptor)
        value = provision()
        accepted = ok('fleet.decision.apply', {'decision': decision(value)}, manager_key)
        assert accepted['kind'] == 'PROVISION_SANDBOX' and accepted['external_call_performed'] is False, accepted
        assert f.sql('SELECT state FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND id=$2', [i['organisation'], accepted['provider_intent_id']])[0]['state'] == 'RECORDED'
        checks.append('exact runner_config schema1 marker and consumer registration grant admit existing CREATE intent path without provider call')
        test_intent, sandbox = uid(), uid()
        f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id) VALUES($1,$2,$3,'component-retained-ACK-TEST')", [i['organisation'], sandbox, f.pool_ids['test']])
        f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$9,'{}','ACKNOWLEDGED','component-retained-ACK-TEST',1)", common + [test_intent, f.pool_ids['test'], sandbox, scopes[f.pool_ids['test']]['configuration_digest'], f.profile_id, 'component-' + test_intent, sha(test_intent.encode())])
        f.sql('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) SELECT organisation_id,run_id,$3,id,payload_digest,$4 FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2 ORDER BY created_at LIMIT 1', common + [uid(), json.dumps({'provider_intent_id': test_intent, 'sandbox_id': sandbox, 'component_fixture': True})])
        observed = ok('fleet.observe', {'binding': binding, 'after': None, 'limit': 100}, manager_key)
        test_pool = next(pool for pool in observed['provider_pools'] if pool['id'] == f.pool_ids['test'])
        assert test_pool['declared_execution_role'] == 'TEST' and test_pool['native_bootstrap']['status'] == 'UNCONFIGURED', test_pool
        retained = next(row for row in observed['provider_intents'] if row['provider_intent_id'] == test_intent)
        assert retained['bootstrap_dispatch']['state'] == 'UNCONFIGURED' and retained['bootstrap_dispatch']['support']['execution_role'] == 'TEST', retained
        checks.append('retained ACK TEST without recipe exposes UNCONFIGURED and preserves TEST role')
        f.descriptor_path.write_text('{invalid descriptor')
        script = "import assert from'node:assert/strict';import{readDeployment}from'./core/control-plane/dist/providers/pools.js';import{fleetBootstrapSupportInventory}from'./core/control-plane/dist/providers/bootstrap.js';const c=await readDeployment(process.env),r=await fleetBootstrapSupportInventory(process.env,c,JSON.parse(process.argv[1]));assert.ok(Object.values(r).every(v=>v.status==='UNCONFIGURED'));await new Promise(resolve=>setImmediate(resolve));console.log(JSON.stringify(r));"
        missing = subprocess.run(['node', '--unhandled-rejections=strict', '--input-type=module', '-e', script, json.dumps([uid(), uid()])], cwd=ROOT, env=f.env, text=True, capture_output=True, timeout=15)
        assert missing.returncode == 0, missing.stderr
        checks.append('historical pool IDs absent from deployment plus invalid descriptor cause no unhandled rejection')
        print(json.dumps({'status': 'PASS', 'scope': 'signed fleet API and real PostgreSQL with protected descriptor metadata only', 'provider_calls': 0, 'model_inference': 'NOT_CLAIMED', 'native_runtime_qualification': 'NOT_CLAIMED', 'checks': checks, 'retained_test_dispatch': retained['bootstrap_dispatch']}))
    finally:
        f.close()


if __name__ == '__main__':
    main()
