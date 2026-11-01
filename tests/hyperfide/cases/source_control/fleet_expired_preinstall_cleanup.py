#!/usr/bin/env python3
"""Signed manager DESTROY and real SDK absence over controlled never-installed PREP lineage."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type
from identity_fixture import sha
spec = importlib.util.spec_from_file_location('cleanup_sdk_fixture', ROOT / 'tests/hyperfide/cases/source_control/blaxel_rejected_create_absence.py')
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


def uid():
    return str(uuid.uuid4())


def digest(value):
    return sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def main():
    http = sdk.ReadOnlyHTTP()

    def setup(f):
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        native = json.loads((ROOT / 'build/fleet/worker/private/native-profile.json').read_text())
        native['profiles'] = native['profiles'][:1]
        profile = native['profiles'][0]
        binary = ROOT / 'build/fleet/worker/private/claude-2.1.300'
        assert sha(binary.read_bytes()) == profile['binary']['digest']
        home = f.path / 'native-home'
        home.mkdir(mode=0o700)
        os.chown(home, int(profile['target_uid']), int(profile['target_uid']))
        profile['binary']['path'], profile['runtime_home'] = str(binary), str(home)
        inventory = f.path / 'native-profiles.json'
        inventory.write_text(json.dumps(native))
        inventory.chmod(0o600)
        f.profile, f.pool = uid(), uid()
        manifest = sdk.provider.prepared.Fixture(f.path / 'declared-profile').create()
        manifest['profile']['image']['provider'] = 'blaxel'
        manifest.pop('digest')
        manifest['digest'] = digest(manifest)
        f.preparation = manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'blaxel','linux-amd64',$4)", [f.ids['organisation'], f.profile, f.preparation, manifest])
        limits = {'SANDBOX': '20', 'PROVISIONING': '20', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        policy = {'schema_version': 1, 'lifecycle': {'schema_version': 1, 'run_seconds': 3600, 'checkpoint_lead_seconds': 60, 'termination_grace_seconds': 10, 'api_wait_seconds': 5, 'process': {'keep_alive': True, 'timeout_seconds': 0}, 'expiration_policies': [], 'runtime_ttl': None, 'runtime_expires_at': None}, 'network_mode': 'ISOLATED', 'network': {}, 'volumes': [], 'runtime_extra_args': {}, 'runtime_env_refs': {}, 'preparation_seed_reference': 'CONTROLLED_PRIOR_CREATE'}
        adapter = f.path / 'adapter.json'
        adapter.write_text(json.dumps({'schema_version': 1, 'profiles': [{'routing': {'organisation_id': f.ids['organisation'], 'pool_id': f.pool, 'provider_account_id': 'cleanup-account', 'environment_id': 'cleanup-workspace', 'region': 'us-pdx-1'}, 'body': policy}]}))
        adapter.chmod(0o600)
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'CONTROLLED_PREINSTALL_COMPONENT', 'accounts': [{'provider': 'blaxel', 'account_key': 'cleanup-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': f.pool, 'provider': 'blaxel', 'account_key': 'cleanup-account', 'environment_key': 'cleanup-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': 'CONTROLLED_PRIOR_CREATE', 'adapter_policy_digest': digest(policy), 'network': 'ISOLATED', 'stdin_required': False}}], 'maximum_operation_ms': 60000}
        poolfile = f.path / 'pools.json'
        poolfile.write_text(json.dumps(f.config))
        poolfile.chmod(0o600)
        executor = f.path / 'executor.json'
        executor.write_text(json.dumps({'schema_version': 1, 'principals': [{'credential_id': f.ids['provisioner'], 'key_path': str(f.keys['provisioner']['path'])}], 'concurrency': 1}))
        executor.chmod(0o600)
        f.env.update(HYPERFIDE_POOL_CONFIG=str(poolfile), HF_NATIVE_AUTH_PROFILES_FILE=str(inventory), HF_CREDENTIAL_CONFIG_FILE=str(credentials), HF_PROVISIONER_EXECUTOR_CONFIG_FILE=str(executor), HYPERFIDE_PROVISIONER_POLL_MS='60000', NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=http.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='isolated-cleanup-no-live-authority', HF_BLAXEL_WORKSPACE='cleanup-workspace', HF_BLAXEL_ACCOUNT_ID='cleanup-account')

    f = None
    try:
        f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration', '10.3']), extra_setup=setup, bootstrap=False, seed_historical_runtime=False, parent_managers=True)
        i = f.ids
        common = [i['organisation'], i['run']]

        def api(action, value, key='leader', component='fleet-orchestration'):
            return f.invoke(action, value, component=component, key=key, timeout_seconds=60)[1]

        def ok(action, value, **kwargs):
            answer = api(action, value, **kwargs)
            assert answer.get('ok'), answer
            return answer['result']

        # Stop the real automatic provisioner before any controlled pending intents exist.
        f.stop()
        f.service_role = 'provisioner'
        f.start()
        ok('provider.worker.stop', {}, key='provisioner', component='8.3')
        f.stop()
        f.service_role = 'control'
        f.start()

        ok('hierarchy.leader.acquire', {'idempotency_key': 'cleanup-leader', 'expected_generation': '0', 'reason': 'Controlled cleanup component'}, component='3.1')
        ok('hierarchy.package.configure', {'idempotency_key': 'cleanup-wave', 'leader_generation': '1', 'package_id': i['package'], 'feature_key': 'alpha', 'allocation_policy': 'WAVE'}, component='3.1')
        cohort = uid()
        ok('fleet.cohort.bind', {'cohort_id': cohort, 'host_id': socket.gethostname(), 'leader_generation': '1', 'expected_generation': '0'})

        def record(action, value, primary=False):
            actor = i['leader'] if primary else i['manager2']
            plan = f.sql('SELECT plan_generation::text FROM hyperfide.fleet_actor_sessions WHERE organisation_id=$1 AND run_id=$2 AND session_id=$3', common + [actor])[0]['plan_generation']
            d = {'schema_version': 1, 'kind': 'hyperfide.fleet-decision', 'decision_id': uid(), 'operation_id': uid(), 'run_id': i['run'], 'actor_id': actor, 'actor_role': 'PRIMARY' if primary else 'WAVE_MANAGER', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': None if primary else i['package'], 'manager_generation': None if primary else '2', 'source_revision': 'git:' + 'a' * 40, 'spec_revision': i['spec'], 'context_digest': sha(('CONTROLLED_DECISION_INPUT:' + uid()).encode()), 'action': action, 'input': value, 'input_digest': digest(value), 'expected_version': plan, 'rationale_summary': 'Controlled component decision input; no model inference or runtime qualification claimed'}
            observation, reasoning = uid(), uid()
            f.sql('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,$6)', common + [observation, actor, d['context_digest'], {'controlled_component_prerequisite': True}])
            f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7)", common + [reasoning, actor, d['context_digest'], observation, {'controlled_component_prerequisite': True}])
            f.sql('INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', common + [d['decision_id'], d['operation_id'], actor, action, d['context_digest'], digest(d), reasoning, d])
            return d

        i['cleanup_task'] = i['task']
        task_pin = f.sql('SELECT spec_revision_id,spec_generation::text,criteria_digest,feature_package_id FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2 AND id=$3', common + [i['cleanup_task']])[0]
        assert task_pin['feature_package_id'] == i['package']
        budget = {'allowed_actions': ['DESTROY_SANDBOX'], 'provider_ids': ['blaxel'], 'profile_ids': [f.profile], 'max_sandboxes': 20, 'max_concurrent_workers': 1, 'task_ids': [i['cleanup_task']]}
        delegation = record('DELEGATE_WAVE', {'package_id': i['package'], 'manager_session_id': i['manager2'], 'expected_generation': '1', 'budget': budget}, primary=True)
        ok('fleet.decision.apply', {'decision': delegation})
        ok('fleet.session.bind', {'binding': {'actor_id': i['manager2'], 'actor_role': 'WAVE_MANAGER', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': i['package'], 'manager_generation': '2'}}, key='manager2')
        pool, account = f.config['pools'][0], f.config['accounts'][0]
        configuration = digest({'revision': f.config['revision'], 'pool': pool, 'account': account})
        scope = {'organisation_id': i['organisation'], 'pool_id': f.pool, 'provider': 'blaxel', 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': configuration}
        f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'blaxel',$3,$4,$5,$6)", [i['organisation'], f.pool, pool['account_key'], pool['environment_key'], pool['region'], f.profile])
        f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], f.pool, configuration, {'scope': scope, 'pool': pool, 'account': account}])
        accounts = {}
        for name, kind in [('SANDBOX', 'PHYSICAL'), ('CPU_MILLIS', 'PHYSICAL'), ('MEMORY_BYTES', 'PHYSICAL'), ('DISK_BYTES', 'PHYSICAL'), ('PREPARATION', 'EXECUTION'), ('CPU_MILLIS', 'EXECUTION'), ('MEMORY_BYTES', 'EXECUTION'), ('DISK_BYTES', 'EXECUTION')]:
            aid = uid()
            f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,pool_id,id,dimension,capacity_class,configured_limit,qualification_state,provenance_digest) VALUES($1,$2,$3,$4,$5,'1000000000000','QUALIFIED',$6)", [i['organisation'], f.pool, aid, name, kind, sha(b'controlled capacity prerequisite')])
            accounts[name if kind == 'PHYSICAL' or name == 'PREPARATION' else 'EXEC_' + name] = aid

        def seed(label):
            sandbox, create, slot, session, allocation, request, reservation, delivery, credential = [uid() for _ in range(9)]
            native = 'hf-' + uuid.uuid4().hex
            f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)", [i['organisation'], sandbox, f.pool, native, f.preparation])
            boot = f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2', [i['organisation'], sandbox])[0]['boot_id']
            f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$9,'{}','ACKNOWLEDGED',$10,1)", common + [create, f.pool, sandbox, configuration, f.profile, uid(), sha(label.encode()), native])
            physical = []
            for name, quantity in {'SANDBOX': '1', 'CPU_MILLIS': '2000', 'MEMORY_BYTES': '4294967296', 'DISK_BYTES': '4294967296'}.items():
                rid = uid()
                f.sql('UPDATE hyperfide.capacity_accounts SET reserved=reserved+$3::numeric,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], accounts[name], quantity])
                f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '1 hour')", common + [rid, uid(), accounts[name], quantity])
                f.sql('INSERT INTO hyperfide.provisioning_intent_reservations VALUES($1,$2,$3,$4)', common + [create, rid])
                physical.append(rid)
            f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$4,1,'PREPARATION','ALLOCATED')", [i['organisation'], slot, sandbox, label])
            f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation,state) VALUES($1,$2,$3,'WORKER','hyperfide-native',$4,($3::uuid)::text,$5,$6,1,'REGISTERED')", common + [session, credential, slot, sandbox])
            f.sql("INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,boot_preparation_digest,preparation_digest,slot_generation,uid,gid,observation_digest,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,'/controlled/state','/controlled/native','/controlled/workspace','/controlled/home','/controlled/tmp',$8,$9,$9,1,64001,64001,$8,'PREPARING')", common + [session, credential, sandbox, boot, slot, sha(b'controlled native metadata'), f.preparation])
            f.sql("INSERT INTO hyperfide.resource_waiters(organisation_id,run_id,id,request_id,pool_id,owner_session_id,task_id,spec_revision_id,spec_generation,criteria_digest,resource_policy_digest,job_kind,priority,state,deadline_at,admitted_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,'PREPARATION',0,'ADMITTED',clock_timestamp()+interval '1 hour',clock_timestamp())", common + [uid(), request, f.pool, i['manager2'], i['cleanup_task'], task_pin['spec_revision_id'], task_pin['spec_generation'], task_pin['criteria_digest']])
            f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+1,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], accounts['PREPARATION']])
            f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,state,expires_at) VALUES($1,$2,$3,$4,$5,'1','ALLOCATED',clock_timestamp()-interval '1 minute')", common + [reservation, request, accounts['PREPARATION']])
            logical = [reservation]
            for name, quantity in {'CPU_MILLIS': '1000', 'MEMORY_BYTES': '2147483648', 'DISK_BYTES': '4294967296'}.items():
                rid = uid()
                f.sql('UPDATE hyperfide.capacity_accounts SET allocated=allocated+$3::numeric,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], accounts['EXEC_' + name], quantity])
                f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'ALLOCATED',clock_timestamp()-interval '1 minute')", common + [rid, request, accounts['EXEC_' + name], quantity])
                logical.append(rid)
            f.sql("INSERT INTO hyperfide.resource_job_allocations(organisation_id,run_id,id,request_id,task_id,reservation_id,job_kind,slot_id,sandbox_id,sandbox_boot_generation,assignee_session_id) VALUES($1,$2,$3,$4,$5,$6,'PREPARATION',$7,$8,1,$9)", common + [allocation, request, i['cleanup_task'], reservation, slot, sandbox, session])
            inp = sha(('controlled environment ' + label).encode())
            f.sql("INSERT INTO hyperfide.fleet_environment_specs(organisation_id,run_id,input_digest,package_digest,source_config_digest,source_manifest_digest,plan_digest,package_spec,source_config,install_plan,registered_by) VALUES($1,$2,$3,$3,$3,$3,$3,'{}','{}','{}',$4)", common + [inp, i['manager2']])
            f.sql("INSERT INTO hyperfide.fleet_install_deliveries(organisation_id,run_id,id,input_digest,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,session_id,reservation_id,target_binding_id,source,staging,timeout_ms,registration_digest,registered_by) VALUES($1,$2,$3,$4,$5,1,$6,$7,1,$8,$9,$10,'{}','[]',1000,$4,$11)", common + [delivery, inp, label, sandbox, boot, session, reservation, allocation, i['manager2']])
            binding = {'organisation_id': i['organisation'], 'run_id': i['run'], 'sandbox_id': sandbox, 'boot_id': boot, 'boot_generation': '1'}
            manifest = {'component_prerequisite_only': True, 'binding': binding, 'template': {'slots': [{'kind': 'PREPARATION', 'slot_id': slot, 'session_id': session, 'uid': 64001, 'gid': 64001, 'credential_sensitive': False}]}}
            descriptor = {'component_prerequisite_only': True}
            f.sql("INSERT INTO hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id,id,pool_id,sandbox_id,boot_id,boot_generation,native_sandbox_id,configuration_digest,profile_id,preparation_digest,descriptor_digest,descriptor,grant_id,binding_operation_id,grant_operation_id,enrollment_operation_id,secret_ref,verifier,process_id,state,manifest,manifest_digest,receipt,receipt_digest) VALUES($1,$2,$3,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'CONTROLLED_PRIOR_BOOTSTRAP',$11,'CONTROLLED_PRIOR_BOOTSTRAP','READY',$17,$18,'{}',$19)", common + [create, f.pool, sandbox, boot, native, configuration, f.profile, f.preparation, digest(descriptor), descriptor, uid(), uid(), uid(), uid(), manifest, digest(manifest), digest({})])
            prior = record('REPLAN', {'note': 'Controlled original ownership effect only'})
            f.sql('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)', common + [prior['operation_id'], prior['decision_id'], digest(prior), {'delegation_id': i['package'], 'sandbox_id': sandbox, 'controlled_component_prerequisite': True}])
            http.models[native] = (200, {'metadata': {'name': native, 'workspace': scope['environment_id'], 'labels': {'hyperfide-scope': digest(scope), 'hyperfide-boot': '1', 'hyperfide-preparation': f.preparation}}, 'spec': {'region': scope['region']}, 'status': 'DEPLOYED'})
            return locals()

        def state(c):
            return {'reservation': f.sql('SELECT id::text,state FROM hyperfide.reservations WHERE organisation_id=$1 AND id=ANY($2::uuid[]) ORDER BY id', [i['organisation'], [*c['physical'], *c['logical']]]), 'allocation': f.sql('SELECT state FROM hyperfide.resource_job_allocations WHERE id=$1', [c['allocation']]), 'session': f.sql('SELECT state,state_version::text FROM hyperfide.agent_sessions WHERE id=$1', [c['session']]), 'slot': f.sql('SELECT state FROM hyperfide.worker_slots WHERE id=$1', [c['slot']]), 'delivery': f.sql('SELECT to_jsonb(d) AS row FROM hyperfide.fleet_install_deliveries d WHERE id=$1', [c['delivery']]), 'accounts': f.sql('SELECT id::text,reserved::text,allocated::text FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 ORDER BY id', [i['organisation'], f.pool])}

        def destroy(c):
            value = {'sandbox_id': c['sandbox'], 'boot_generation': '1', 'pool_id': f.pool, 'deadline_at': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time()+50)), 'reason': 'Controlled expired preinstall cleanup'}
            decision = record('DESTROY_SANDBOX', value)
            return api('fleet.decision.apply', {'decision': decision}, key='manager2'), decision

        negatives = []
        for label in ([] if sys.argv[1:] == ['--positive-only'] else ['unexpired', 'running', 'disconnected', 'install', 'ambiguous']):
            c = seed(label)
            if label == 'unexpired':
                f.sql("UPDATE hyperfide.reservations SET expires_at=clock_timestamp()+interval '1 hour',state_version=state_version+1 WHERE id=$1", [c['reservation']])
            elif label in ['running', 'disconnected']:
                f.sql('UPDATE hyperfide.agent_sessions SET state=$2,state_version=state_version+1 WHERE id=$1', [c['session'], label.upper()])
            elif label == 'ambiguous':
                f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id,slot_id,sandbox_id,sandbox_boot_generation) VALUES($1,$2,$3,'WORKER','fixture','fixture','controlled-ambiguous',$4,$5,1)", common + [uid(), c['slot'], c['sandbox']])
            else:
                f.sql("INSERT INTO hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id,input_digest,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,authority_epoch,package_id,manager_session_id,manager_generation,leader_generation,cohort_id,cohort_generation,admission,admission_digest,expires_at) VALUES($1,$2,$3,$4,$5,1,$6,$7,1,$8,$9,$10,2,1,$11,1,'{}',$4,clock_timestamp()+interval '1 hour')", common + [uid(), c['inp'], label, c['sandbox'], c['boot'], i['epoch'], i['package'], i['manager2'], cohort])
            before = state(c)
            answer, _ = destroy(c)
            assert answer.get('error', {}).get('code') == 'SANDBOX_HAS_ACTIVE_WORK' and state(c) == before, answer
            assert f.sql("SELECT id FROM hyperfide.command_inbox WHERE organisation_id=$1 AND operation='fleet.preinstall.abandon' AND idempotency_key=$2", [i['organisation'], c['sandbox'] + ':1']) == []
            negatives.append({'case': label, 'error': answer['error']})
        c = seed('expired-positive')
        f.sql("UPDATE hyperfide.worker_slots SET state='RETIRED',state_version=state_version+1 WHERE id=$1", [c['slot']])
        before = state(c)
        answer, decision = destroy(c)
        assert answer.get('ok'), answer
        destroy_id = answer['result']['provider_intent_id']
        pending = state(c)
        assert pending['accounts'] == before['accounts'] and pending['delivery'] == before['delivery']
        assert pending['allocation'][0]['state'] == 'RELEASE_PENDING' and pending['slot'][0]['state'] == 'RETIRED' and pending['session'][0]['state'] == 'STOPPED', pending
        assert int(pending['session'][0]['state_version']) == int(before['session'][0]['state_version']) + 1
        assert next(row for row in pending['reservation'] if row['id'] == c['reservation'])['state'] == 'RELEASE_PENDING'
        audit = f.sql("SELECT result FROM hyperfide.command_inbox WHERE organisation_id=$1 AND operation='fleet.preinstall.abandon' AND idempotency_key=$2", [i['organisation'], c['sandbox'] + ':1'])
        assert len(audit) == 1 and audit[0]['result']['physical_resources_released'] is False, audit
        f.stop()
        f.service_role = 'provisioner'
        f.start()
        ok('provider.worker.stop', {}, key='provisioner', component='8.3')
        owned_present = http.models[c['native']]
        http.models[c['native']] = (503, {'message': 'Controlled actual SDK pre-delete lookup unavailable'})
        execution = ok('provider.intents.execute', {'intent_id': destroy_id}, key='provisioner', component='8.3')
        assert execution['executed'] is True and execution['intent']['state'] == 'UNKNOWN' and state(c)['accounts'] == before['accounts'], execution
        http.models[c['native']] = owned_present
        present = ok('provider.intents.reconcile', {'intent_id': destroy_id}, key='provisioner', component='8.3')
        assert state(c)['accounts'] == before['accounts'], present
        http.models[c['native']] = (404, {'message': 'Controlled actual provider resource absent'})
        absent = ok('provider.intents.reconcile', {'intent_id': destroy_id}, key='provisioner', component='8.3')
        after = state(c)
        assert absent.get('capacity_release', {}).get('confirmed_absence_released') is True and all(row['state'] == 'RELEASED' for row in after['reservation']), (absent, after)
        expected_counters = {row['id']: {'reserved': int(row['reserved']), 'allocated': int(row['allocated'])} for row in before['accounts']}
        for name, quantity in {'SANDBOX': 1, 'CPU_MILLIS': 2000, 'MEMORY_BYTES': 4294967296, 'DISK_BYTES': 4294967296}.items():
            expected_counters[accounts[name]]['reserved'] -= quantity
        expected_counters[accounts['PREPARATION']]['allocated'] -= 1
        for name, quantity in {'CPU_MILLIS': 1000, 'MEMORY_BYTES': 2147483648, 'DISK_BYTES': 4294967296}.items():
            expected_counters[accounts['EXEC_' + name]]['allocated'] -= quantity
        assert {row['id']: {'reserved': int(row['reserved']), 'allocated': int(row['allocated'])} for row in after['accounts']} == expected_counters, after['accounts']
        assert after['session'] == pending['session']
        assert after['allocation'][0]['state'] == 'RELEASED' and after['slot'][0]['state'] == 'RETIRED' and after['session'][0]['state'] == 'STOPPED' and after['delivery'] == before['delivery'], after
        replay = ok('provider.intents.reconcile', {'intent_id': destroy_id}, key='provisioner', component='8.3')
        assert state(c) == after and len(f.sql("SELECT id FROM hyperfide.command_inbox WHERE organisation_id=$1 AND operation='fleet.preinstall.abandon' AND idempotency_key=$2", [i['organisation'], c['sandbox'] + ':1'])) == 1, replay
        assert all(event['method'] == 'GET' for event in http.events), http.events
        print(json.dumps({'status': 'PASS', 'scope': 'signed manager fleet DESTROY application and real PostgreSQL/SDK absence; controlled prior READY/mechanical PREP metadata only', 'model_and_bootstrap_qualification': 'NOT_CLAIMED', 'provider_mutations': 0, 'negatives': negatives, 'checks': ['exact expired unbound preinstall closes allocation/session with immutable audit', 'all capacity counters held during cleanup and actual provider-present reconciliation', 'actual provider404 releases physical4 plus exact logical PREP/CPU/MEMORY/DISK vector once and retires slot', 'delivery lineage preserved and replay stable'], 'audit': audit, 'admission': answer, 'actual_predelete_lookup_uncertainty': execution, 'absence': absent}))
    finally:
        if f:
            f.close()
        http.close()


if __name__ == '__main__':
    main()
