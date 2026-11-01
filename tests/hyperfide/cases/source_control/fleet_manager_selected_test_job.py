#!/usr/bin/env python3
"""Signed manager-selected TEST admission with controlled accepted PG prerequisites; no cloud/readiness proof."""
import base64
import copy
import concurrent.futures
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
spec = importlib.util.spec_from_file_location('capability_preparation_fixture', ROOT / 'tests/hyperfide/cases/tasks/3_2.py')
preparation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparation)
object_spec = importlib.util.spec_from_file_location('manager_selected_objects', ROOT / 'tests/hyperfide/cases/tasks/15_2.py')
objects = importlib.util.module_from_spec(object_spec)
object_spec.loader.exec_module(objects)
PROFILE_PIN_BYTES = b'Actual manifest-backed manager-selected TEST profile input.\n' * 4


def uid():
    return str(uuid.uuid4())


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def main():
    backend = objects.ObjectFixture()

    def setup(f):
        f.env.update({'HF_ARTIFACT_S3_ENDPOINT': backend.endpoint, 'HF_ARTIFACT_ALLOW_LOOPBACK_HTTP': '1', 'HF_ARTIFACT_S3_REGION': objects.REGION, 'HF_ARTIFACT_S3_BUCKET': objects.BUCKET, 'HF_ARTIFACT_S3_ACCESS_KEY_ID': objects.KEY, 'HF_ARTIFACT_S3_SECRET_ACCESS_KEY': objects.SECRET, 'HF_ARTIFACT_S3_SESSION_TOKEN': objects.TOKEN, 'HF_ARTIFACT_ORGANISATION_ID': f.ids['organisation'], 'HF_ARTIFACT_ALLOWED_RUN_IDS': json.dumps([f.ids['run']])})
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
        f.profile_id = uid()
        f.manifest = copy.deepcopy(f.sql('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2', [f.ids['organisation'], f.ids['profile']])[0]['manifest'])
        f.manifest.update(schema_version=2, symlinks=[], hardlinks=[])
        profile = f.manifest['profile']
        profile.update(schema_version=2, profile_id=f.profile_id, profile_version='2.0.0')
        profile['generated_inputs'].append({'path': 'component-manifest-pin.txt', 'digest': sha(PROFILE_PIN_BYTES)})
        pins = [profile['recipe']] + profile['generated_inputs'] + profile['build_config'] + [pin for manager in profile['package_managers'] for pin in manager['locks']] + profile['preparation_evidence']
        profile['result_preparation'] = {'schema_version': 1, 'inputs': [{'path': pin['path'], 'origin': 'PROFILE_ARTIFACT' if pin['path'] == 'component-manifest-pin.txt' else 'SOURCE'} for pin in pins]}
        f.manifest.pop('digest')
        f.manifest['digest'] = digest(f.manifest)
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'railway','linux-amd64',$4)", [f.ids['organisation'], f.profile_id, f.manifest['digest'], f.manifest])
        f.pool_ids = {'coding': uid(), 'test': uid(), 'legacy': uid(), 'bad-manifest': uid(), 'wrong-content': uid()}
        f.jobs = {}
        for name in ['first', 'second', 'race', 'legacy', 'wrong-profile']:
            overrides = {'qualification_environment_profile_id': f.profile_id}
            if name == 'wrong-profile':
                alternate = copy.deepcopy(f.manifest)
                alternate['profile']['profile_id'] = uid()
                alternate['profile']['profile_version'] = '1.0.1'
                alternate.pop('digest')
                alternate['digest'] = digest(alternate)
                f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'railway','linux-amd64',$4)", [f.ids['organisation'], alternate['profile']['profile_id'], alternate['digest'], alternate])
                overrides['qualification_environment_profile_id'] = alternate['profile']['profile_id']
            f.jobs[name] = {'task_id': f.accepted_task('alpha.selected-' + name, **overrides)}
        f.jobs['wrong-package'] = {'task_id': f.ids['task']}
        limits = {'SANDBOX': '10', 'PROVISIONING': '10', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'ISOLATED_CAPABILITY_PREREQUISITES', 'accounts': [{'provider': 'railway', 'account_key': 'capability-component', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': pool, 'provider': 'railway', 'account_key': 'capability-component', 'environment_key': 'capability-' + role, 'region': 'component-region', 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'approved_limits': limits, 'planning_limits': limits, 'execution_role': {'schema_version': 1, 'kind': 'CODING' if role == 'coding' else 'TEST'}, 'create_policy': {'seed_reference': 'ISOLATED_NOT_PROVISIONED', 'network': 'ISOLATED', 'stdin_required': False}} for role, pool in f.pool_ids.items()], 'maximum_operation_ms': 120000}
        config_file = f.path / 'capability-pools.json'
        config_file.write_text(json.dumps(f.config))
        config_file.chmod(0o600)
        f.env['HYPERFIDE_POOL_CONFIG'] = str(config_file)
        f.descriptor_path = f.path / 'capability-bootstrap.json'
        f.descriptor_path.write_text('{}')
        f.descriptor_path.chmod(0o600)
        f.env['HF_PROVIDER_BOOTSTRAP_CONFIG_FILE'] = str(f.descriptor_path)
        scan_policy = {'schema_version': 1, 'kind': 'hyperfide.result-root-scan-policy', 'policy_id': 'manager-selection-component-scan-policy', 'secret_env_refs': ['HF_COMPONENT_NONSECRET_SCAN_CANARY'], 'identity_canaries': ['component-identity-canary-only'], 'lease_canaries': ['component-lease-canary-only'], 'max_files': 1000, 'max_archive_bytes': 1048576, 'max_total_bytes': 2097152}
        scan_path = f.path / 'component-root-scan-policy.json'
        scan_bytes = json.dumps(scan_policy, sort_keys=True, separators=(',', ':')).encode()
        scan_path.write_bytes(scan_bytes)
        scan_path.chmod(0o600)
        f.env.update(HF_RESULT_ROOT_SCAN_POLICY_FILE=str(scan_path), HF_RESULT_ROOT_SCAN_POLICY_DIGEST=sha(scan_bytes), HF_COMPONENT_NONSECRET_SCAN_CANARY='public-component-canary-not-a-credential')

    try:
        f = preparation.PacketFixture(extra_components=component_closure(['fleet-orchestration']), extra_setup=setup, seed_historical_runtime=False, provider_config={'provider': 'railway', 'account': 'component', 'workspace': 'component', 'region': 'component', 'runtime_platform': 'linux-amd64'})
    except BaseException:
        backend.stop()
        raise
    try:
        i = f.ids
        common = [i['organisation'], i['run']]

        def api(action, value, key='leader'):
            return f.invoke(action, value, component='fleet-orchestration', key=key)[1]

        def ok(action, value, key='leader'):
            response = api(action, value, key)
            assert response.get('ok'), response
            return response['result']

        cohort = uid()
        ok('fleet.cohort.bind', {'cohort_id': cohort, 'host_id': socket.gethostname(), 'leader_generation': '1', 'expected_generation': '0'})
        binding = {'actor_id': i['manager'], 'actor_role': 'WAVE_MANAGER', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': i['package2'], 'manager_generation': '2'}
        budget = {'allowed_actions': ['PROVISION_SANDBOX'], 'provider_ids': ['railway'], 'profile_ids': [f.profile_id], 'max_sandboxes': 10, 'max_concurrent_workers': 1, 'task_ids': [job['task_id'] for name, job in f.jobs.items() if name != 'wrong-package']}
        f.sql('INSERT INTO hyperfide.fleet_delegations(organisation_id,run_id,package_id,manager_session_id,manager_generation,leader_generation,budget,decision_id) VALUES($1,$2,$3,$4,2,1,$5,$6)', common + [i['package2'], i['manager'], json.dumps(budget), uid()])
        ok('fleet.session.bind', {'binding': binding}, 'manager')
        scopes = {}
        accounts = {}
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
                accounts.setdefault(pool['id'], []).append({'capacity_account_id': account, 'quantity': quantity})
            for dimension, limit in pool['approved_limits'].items():
                for kind, key in [('ACCOUNT', pool['account_key']), ('ENVIRONMENT', pool['environment_key'])]:
                    f.sql("INSERT INTO hyperfide.provider_quota_observations(organisation_id,id,pool_id,configuration_digest,provider,account_key,scope_kind,scope_key,dimension,quota_limit,observed_at,expires_at,evidence_digest,basis,evidence_reference) VALUES($1,$2,$3,$4,'railway',$5,$6,$7,$8,$9,clock_timestamp(),clock_timestamp()+interval '1 hour',$10,'VERIFIED_OPERATOR_ATTESTATION','ISOLATED_COMPONENT_PREREQUISITE')", [i['organisation'], uid(), pool['id'], scope['configuration_digest'], pool['account_key'], kind, key, dimension, limit, sha(b'controlled-quota-prerequisite')])
        def artifact(label, content=None, expected=None):
            content = content if content is not None else label.encode()
            value = sha(content)
            assert expected is None or value == expected, (label, value, expected)
            result = f.ok('artifact.object.put', {'organisation_id': i['organisation'], 'run_id': i['run'], 'digest': value, 'size_bytes': str(len(content)), 'data_base64': base64.b64encode(content).decode(), 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2', key='operator')
            objects.verified(result, content)
            return result['artifact']['artifact_id']

        def manifest(content):
            chunks = []
            offset = 0
            for part in [content[:17], content[17:]]:
                ident = artifact('manifest chunk', part)
                chunks.append({'sequence': len(chunks), 'artifact_id': ident, 'digest': sha(part), 'size_bytes': str(len(part)), 'offset_bytes': str(offset)})
                offset += len(part)
            result = f.ok('artifact.manifest.commit', {'organisation_id': i['organisation'], 'run_id': i['run'], 'expected_chunks': len(chunks), 'total_size_bytes': str(len(content)), 'content_digest': sha(content), 'complete': True, 'truncated': False, 'missing_ranges': [], 'chunks': chunks, 'retention_class': 'RUN', 'retention_until': None, 'retention_hold': False}, component='15.2', key='operator')
            objects.verified(result)
            assert result['artifact']['digest'] != sha(content), result
            return result

        manifest_pin = manifest(PROFILE_PIN_BYTES)
        wrong_manifest_pin = manifest(PROFILE_PIN_BYTES + b'wrong-content')
        recipe_artifact = artifact('recipe-policy', b'recipe', f.manifest['profile']['recipe']['digest'])
        source_artifact, evidence_artifact = artifact('controlled baseline source catalog'), artifact('controlled source evidence catalog')
        for name, entry in f.jobs.items():
            task = f.sql('SELECT criteria_digest,task_key FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3', common + [entry['task_id']])[0]
            attempt, custody, job = uid(), uid(), uid()
            f.sql("INSERT INTO hyperfide.attempts(organisation_id,run_id,id,task_id,generation,authority_epoch,input_packet_digest,execution_state,compute_authority,sandbox_id,slot_id,sandbox_boot_generation) VALUES($1,$2,$3,$4,1,$5,$6,'CANCELLED','REVOKED',$7,$8,1)", common + [attempt, entry['task_id'], i['epoch'], sha(('component-attempt:' + name).encode()), i['sandbox'], i['packet_slot']])
            f.sql('INSERT INTO hyperfide.submission_custodies(organisation_id,run_id,id,task_id,source_attempt_id,source_generation,custody_generation,authority_epoch,repository_id,source_object_id,source_manifest_digest,evidence_manifest_digest,criteria_digest) VALUES($1,$2,$3,$4,$5,1,1,$6,$7,$8,$9,$10,$11)', common + [custody, entry['task_id'], attempt, i['epoch'], i['repository'], f.source, sha(('source catalog:' + name).encode()), sha(('evidence catalog:' + name).encode()), task['criteria_digest']])
            f.sql("UPDATE hyperfide.tasks SET generation=1,current_attempt_id=$4,current_custody_id=$5,state='SUBMITTED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3", common + [entry['task_id'], attempt, custody])
            f.sql('INSERT INTO hyperfide.qualification_jobs(organisation_id,run_id,id,custody_id,custody_generation,rubric_digest) VALUES($1,$2,$3,$4,1,$5)', common + [job, custody, f.packet_proof['rubric_digest']])
            f.sql('INSERT INTO hyperfide.assurance_submissions(organisation_id,run_id,custody_id,request_id,request_digest,manifest,policy,source_artifact_id,evidence_artifact_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', common + [custody, uid(), sha(('submission:' + name).encode()), json.dumps({'schema_version': 1, 'repository_id': i['repository'], 'source_object_id': f.source, 'component_prerequisite_catalog': True}), json.dumps({'component_prerequisite': True}), source_artifact, evidence_artifact])
            entry.update(job_id=job, expected_state_version='1', custody_id=custody, custody_generation='1', task_key=task['task_key'])

        actions = ['identity.principal.delegate', 'fleet.test.executor.pending', 'qualification.preparation.execute', 'qualification.preparation.inspect', 'qualification.job.claim', 'qualification.execute', 'qualification.execution.inspect']
        policy = {'schema_version': 3, 'preparation_deadline_ms': 1000, 'verification_deadline_ms': 1000, 'recipe_policy_artifact_id': recipe_artifact, 'source_bundles': [{'repository_key': f.manifest['profile']['repositories'][0]['id'], 'artifact_id': source_artifact, 'storage_kind': 'object'}], 'timeout_ms': 1000, 'verifier_ttl_seconds': 300, 'profile_pin_artifacts': [{'path': 'component-manifest-pin.txt', 'artifact_id': manifest_pin['artifact']['artifact_id'], 'storage_kind': 'manifest'}]}
        recipes = []
        for role in ['coding', 'test', 'legacy', 'bad-manifest', 'wrong-content']:
            recipe = {'pool_id': f.pool_ids[role], 'configuration_digest': scopes[f.pool_ids[role]]['configuration_digest'], 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'native_path': '/opt/component/native', 'native_digest': sha(b'declared-native-metadata-only'), 'manifest_path': '/run/component/manifest', 'secret_path': '/run/component/secret', 'files': [{'artifact_id': source_artifact, 'storage_kind': 'object', 'digest': sha(b'controlled baseline source catalog'), 'size_bytes': str(len(b'controlled baseline source catalog')), 'target': '/opt/component/input', 'mode': '0444'}], 'allowed_actions': actions, 'grant_ttl_seconds': 600}
            if role == 'coding':
                recipe.update(native_template={'slots': [{'kind': 'PREPARATION'}, {'kind': 'AGENT'}]}, install_template={})
            else:
                template = copy.deepcopy(policy)
                if role == 'wrong-content':
                    template['profile_pin_artifacts'][0]['artifact_id'] = wrong_manifest_pin['artifact']['artifact_id']
                if role == 'bad-manifest':
                    template['source_bundles'][0]['storage_kind'] = 'manifest'
                if role == 'legacy':
                    template.update(schema_version=2, task_key=f.jobs['legacy']['task_key'], job_id=f.jobs['legacy']['job_id'])
                recipe.update(schema_version=2 if role == 'legacy' else 3, executor_kind='TEST', test_template=template, native_template={'slots': [{'kind': 'TEST', 'credential_sensitive': False, 'isolation_profile': 'distinct_uid'}], 'controller': {'node_path': '/opt/component/node', 'module_path': '/opt/component/test-controller', 'node_digest': sha(b'declared-node'), 'module_digest': sha(b'declared-controller')}})
            recipes.append(recipe)
        descriptor = {'schema_version': 1, 'origin': 'https://component.invalid', 'ca_file': '/etc/component/ca.pem', 'state_root': '/remote-component-state-not-on-control-host', 'pools': recipes}
        f.descriptor_path.write_text(json.dumps(descriptor))
        f.descriptor_path.chmod(0o600)
        descriptor_digest = sha(f.descriptor_path.read_bytes())
        assert 'job_id' not in recipes[1]['test_template'] and 'task_key' not in recipes[1]['test_template']

        def decision(value):
            operation, ident, observation, reasoning = [uid() for _ in range(4)]
            plan = f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3', common + [i['manager']])[0]['plan_generation']
            body = {'schema_version': 1, 'kind': 'hyperfide.fleet-decision', 'decision_id': ident, 'operation_id': operation, 'run_id': i['run'], **binding, 'source_revision': 'git:' + 'a' * 40, 'spec_revision': i['packet_spec'], 'context_digest': sha(operation.encode()), 'action': 'PROVISION_SANDBOX', 'input': value, 'input_digest': digest(value), 'expected_version': plan, 'rationale_summary': 'Explicit isolated manager TEST selection; no model inference or physical runtime proof'}
            f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{\"component_fixture\":true}')", common + [observation, i['manager'], body['context_digest']])
            f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED','{\"component_fixture\":true}')", common + [reasoning, i['manager'], body['context_digest'], observation])
            f.sql('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', common + [ident, operation, i['manager'], body['action'], body['context_digest'], digest(body), reasoning, json.dumps(body)])
            return body

        def provision(name='first', role='test', select=True):
            value = {'pool_id': f.pool_ids[role], 'provider_id': 'railway', 'profile_id': f.profile_id, 'preparation_digest': f.manifest['digest'], 'sandbox_id': uid(), 'purpose': 'PREPARATION', 'deadline_at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time() + 60)), 'capacity': accounts[f.pool_ids[role]]}
            if select:
                value['qualification_job'] = {key: f.jobs[name][key] for key in ['job_id', 'expected_state_version', 'custody_id', 'custody_generation']}
            return value

        def apply(body):
            return api('fleet.decision.apply', {'decision': body}, 'manager')

        def retained():
            return f.sql('SELECT to_jsonb(b) AS row FROM hyperfide.fleet_test_job_bindings b ORDER BY intent_id')

        def effects():
            return {table: f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.' + table + ' t ORDER BY id') for table in ['reservations', 'provisioning_intents', 'capacity_accounts', 'sandboxes']}

        checks = []
        negative = [('missing-selection', provision(select=False), 'FLEET_TEST_SELECTION'), ('manifest-profile-wrong-content', provision(role='wrong-content'), 'FLEET_TEST_ARTIFACT_POLICY'), ('baseline-manifest-ref-to-object-catalog', provision(role='bad-manifest'), 'FLEET_TEST_ARTIFACT_POLICY'), ('wrong-package', provision('wrong-package'), 'FLEET_TEST_SELECTION_STALE'), ('wrong-profile', provision('wrong-profile'), 'FLEET_TEST_PROFILE_MISMATCH'), ('CODING-selector', provision(role='coding'), 'FLEET_TEST_SELECTION'), ('legacy-mismatched-selection', provision('first', role='legacy'), 'FLEET_TEST_SELECTION')]
        stale_job, stale_custody = provision(), provision()
        stale_job['qualification_job']['expected_state_version'] = '2'
        stale_custody['qualification_job']['custody_generation'] = '2'
        negative.extend([('stale-job', stale_job, 'FLEET_TEST_SELECTION_STALE'), ('stale-custody', stale_custody, 'QUALIFICATION_STALE_CUSTODY')])
        for name, value, code in negative:
            before, bindings_before = effects(), retained()
            refused = apply(decision(value))
            assert refused.get('error', {}).get('code') == code, (name, refused)
            assert effects() == before and retained() == bindings_before, name
            checks.append(name + ' refuses ' + code + ' before external or capacity effects')
        accepted = {}
        for name in ['first', 'second']:
            body = decision(provision(name))
            result = apply(body)
            assert result.get('ok'), result
            output = result['result']
            assert output['external_call_performed'] is False, output
            binding_row = f.sql('SELECT * FROM hyperfide.fleet_test_job_bindings WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3', common + [output['provider_intent_id']])[0]
            assert binding_row['job_id'] == f.jobs[name]['job_id'] and binding_row['custody_id'] == f.jobs[name]['custody_id'] and binding_row['state'] == 'ACTIVE', binding_row
            assert binding_row['template']['job_id'] == f.jobs[name]['job_id'] and binding_row['template']['task_key'] == f.jobs[name]['task_key'], binding_row
            assert binding_row['template_digest'] == digest(binding_row['template']) and binding_row['policy_digest'] == digest({**recipes[1], 'origin': descriptor['origin'], 'ca_file': descriptor['ca_file']}), binding_row
            before = retained()
            replay = apply(body)
            assert replay.get('ok') and replay['result']['replayed'] is True and retained() == before, replay
            assert sha(f.descriptor_path.read_bytes()) == descriptor_digest
            accepted[name] = output
        checks.append('two manager-selected pending jobs retain distinct immutable templates from one unchanged jobless policy; exact replay stable')
        race = [decision(provision('race')), decision(provision('race'))]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            raced = list(workers.map(apply, race))
        assert sum(response.get('ok') is True for response in raced) == 1, raced
        assert len(f.sql("SELECT intent_id FROM hyperfide.fleet_test_job_bindings WHERE organisation_id=$1 AND run_id=$2 AND job_id=$3 AND state='ACTIVE'", common + [f.jobs['race']['job_id']])) == 1
        assert all(response.get('ok') or response.get('error', {}).get('code') in ['FLEET_PLAN_STALE', 'FLEET_TEST_BINDING_UNSETTLED'] for response in raced), raced
        checks.append('concurrent distinct CREATE decisions select one job at most once')
        intent = accepted['first']['provider_intent_id']
        f.sql("UPDATE hyperfide.provisioning_intents SET state='UNKNOWN',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [i['organisation'], intent])
        for state in ['UNKNOWN', 'OPERATOR_RELEASED']:
            if state == 'OPERATOR_RELEASED':
                f.sql("UPDATE hyperfide.provisioning_intents SET state='REJECTED',failure_code='OPERATOR_RELEASED',state_version=state_version+1 WHERE organisation_id=$1 AND id=$2", [i['organisation'], intent])
            before, bindings_before = effects(), retained()
            refused = apply(decision(provision('first')))
            assert refused.get('error', {}).get('code') == 'FLEET_TEST_BINDING_UNSETTLED', (state, refused)
            assert effects() == before and retained() == bindings_before
        checks.append('UNKNOWN and OPERATOR_RELEASED held physical reservations preserve ACTIVE job binding and refuse replacement')
        legacy = apply(decision(provision('legacy', role='legacy', select=False)))
        assert legacy.get('ok') and legacy['result']['external_call_performed'] is False, legacy
        assert f.sql('SELECT intent_id FROM hyperfide.fleet_test_job_bindings WHERE organisation_id=$1 AND run_id=$2 AND intent_id=$3', common + [legacy['result']['provider_intent_id']]) == []
        assert sha(f.descriptor_path.read_bytes()) == descriptor_digest
        checks.append('legacy fixed schema2 TEST policy remains compatible without selector')
        print(json.dumps({'status': 'PASS', 'scope': 'signed fleet admission and real PostgreSQL with controlled accepted task/custody/artifact catalog prerequisites', 'provider_calls': 0, 'model_inference': 'NOT_CLAIMED', 'artifact_component_storage': 'actual SigV4 loopback bytes and production manifest commit/read', 'physical_qualification': 'NOT_CLAIMED', 'checks': checks, 'bindings': retained(), 'descriptor_digest': descriptor_digest, 'manifest_pin': {'artifact_id': manifest_pin['artifact']['artifact_id'], 'root_digest': manifest_pin['artifact']['digest'], 'content_digest': sha(PROFILE_PIN_BYTES)}, 'bad_object_signatures': backend.bad_signatures}))
    finally:
        try:
            f.close()
        finally:
            backend.stop()


if __name__ == '__main__':
    main()
