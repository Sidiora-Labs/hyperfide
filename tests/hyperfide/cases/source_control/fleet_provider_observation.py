#!/usr/bin/env python3
"""Signed HTTPS/PostgreSQL projection of controlled provider evidence; no live provider qualification."""
import json
import os
import socket
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type
from identity_fixture import sha


def uid():
    return str(uuid.uuid4())


def main():
    def setup(f):
        secrets, attachments = f.path / 'observation-secrets', f.path / 'observation-attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credentials = f.path / 'observation-credentials.json'
        credentials.write_text(json.dumps({'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []}))
        credentials.chmod(0o600)
        f.env['HF_CREDENTIAL_CONFIG_FILE'] = str(credentials)
        native = json.loads((ROOT / 'build/fleet/worker/private/native-profile.json').read_text())
        native['profiles'] = native['profiles'][:1]
        profile = native['profiles'][0]
        binary = ROOT / 'build/fleet/worker/private/claude-2.1.300'
        assert sha(binary.read_bytes()) == profile['binary']['digest']
        home = f.path / 'observation-native-home'
        home.mkdir(mode=0o700)
        os.chown(home, int(profile['target_uid']), int(profile['target_uid']))
        profile['binary']['path'], profile['runtime_home'] = str(binary), str(home)
        inventory = f.path / 'observation-native-profiles.json'
        inventory.write_text(json.dumps(native))
        inventory.chmod(0o600)
        f.env['HF_NATIVE_AUTH_PROFILES_FILE'] = str(inventory)

    f = hierarchy_type()(extra_components=component_closure(['fleet-orchestration']), extra_setup=setup, seed_historical_runtime=False, parent_managers=True)
    try:
        i = f.ids
        common = [i['organisation'], i['run']]

        def api(action, value, key='leader'):
            return f.ok(action, value, key=key, component='fleet-orchestration')

        api('fleet.cohort.bind', {'cohort_id': uid(), 'host_id': socket.gethostname(), 'leader_generation': '1', 'expected_generation': '0'})
        bindings = {}
        for key, package in [('manager', 'package'), ('manager2', 'wave_package'), ('leader', None)]:
            binding = {'actor_id': i[key], 'actor_role': 'WAVE_MANAGER' if package else 'PRIMARY', 'authority_epoch': i['epoch'], 'leader_generation': '1', 'delegation_id': i[package] if package else None, 'manager_generation': '2' if package else None}
            if package:
                api('fleet.session.bind', {'binding': binding}, key)
            bindings[key] = binding

        profile, pool, config = uid(), uid(), sha(b'controlled observation configuration')
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'railway','linux-amd64','{}')", [i['organisation'], profile, sha(b'controlled unqualified profile')])
        f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'railway','component-fixture','component-fixture','component-fixture',$3)", [i['organisation'], pool, profile])
        f.sql("INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,'{}')", [i['organisation'], pool, config])

        def seed(known, kind='CREATE', create_unknown=False):
            sandbox, intent, observation, reasoning, decision, operation = [uid() for _ in range(6)]
            native = 'component-known-native-' + kind.lower() + '-' + sandbox if known else None
            state, failure = ('ACKNOWLEDGED', None) if known else ('REJECTED', 'OPERATOR_RELEASED')
            f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,desired_state,observed_state) VALUES($1,$2,$3,$4,'DESTROYED','DESTROYED')", [i['organisation'], sandbox, pool, native])
            latest = {'status': 'SUCCEEDED', 'acceptance': 'CONFIRMED_ACCEPTED', 'result': {'items': [], 'completeness': 'BEST_EFFORT'}}
            f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation,last_outcome,failure_code) VALUES($1,$2,$3,$4,$5,$6,$14,$15,$7,$8,$9,$9,'{}',$10,$11,1,$12,$13)", common + [intent, pool, sandbox, config, profile if kind == 'CREATE' else None, 'component-' + intent, sha(intent.encode()), state, native, json.dumps(latest), failure, kind, 'PREPARATION' if kind == 'CREATE' else None])
            original = {'operation': {'kind': kind.lower()}, 'outcome': {'status': 'SUCCEEDED' if known and not create_unknown else 'UNKNOWN', 'acceptance': 'CONFIRMED_ACCEPTED' if known and not create_unknown else 'UNKNOWN'}}
            if known:
                original['outcome']['resource'] = {'native_sandbox_id': native, 'sandbox_boot_generation': '1'}
            create_id, list_id = uid(), uid()
            for obs_id, body, age in [(create_id, original, '2 minutes'), (list_id, {'operation': {'kind': 'list'}, 'outcome': latest}, '1 minute')]:
                evidence = sha(json.dumps(body, sort_keys=True).encode())
                f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-$7::interval,$5)", [i['organisation'], obs_id, intent, uid(), evidence, json.dumps(body), age])
            f.sql("INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,'{\"controlled_component_prerequisite\":true}')", common + [observation, i['manager'], sha(intent.encode())])
            f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED','{\"controlled_component_prerequisite\":true}')", common + [reasoning, i['manager'], sha(intent.encode()), observation])
            f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,$8,$6,$6,$7,'{\"controlled_component_prerequisite\":true}')", common + [decision, operation, i['manager'], sha(intent.encode()), reasoning, 'PROVISION_SANDBOX' if kind == 'CREATE' else 'DESTROY_SANDBOX'])
            f.sql("INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)", common + [operation, decision, sha(intent.encode()), json.dumps({'provider_intent_id': intent, 'sandbox_id': sandbox, 'controlled_component_prerequisite': True})])
            reservations = []
            if not known:
                f.sql("INSERT INTO hyperfide.provider_resolutions(organisation_id,id,run_id,subject_kind,pool_id,intent_id,resolution,prior_state,resulting_state,reason,released_reservations,decided_by_credential_id,decided_by_actor_id,decided_by_role) VALUES($1,$2,$3,'INTENT',$4,$5,'RELEASE','QUARANTINED','REJECTED','Controlled administrative disposition prerequisite',4,$6,$6,'OPERATOR')", [i['organisation'], uid(), i['run'], pool, intent, i['operator']])
                for dimension in ['SANDBOX', 'CPU_MILLIS', 'MEMORY_BYTES', 'DISK_BYTES']:
                    account, reservation = uid(), uid()
                    f.sql("INSERT INTO hyperfide.capacity_accounts(organisation_id,id,pool_id,dimension,capacity_class,configured_limit,reserved,provenance_digest) VALUES($1,$2,$3,$4,'PHYSICAL',10,1,$5)", [i['organisation'], account, pool, dimension, sha(dimension.encode())])
                    f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour','RELEASE_PENDING')", common + [reservation, uid(), account])
                    f.sql('INSERT INTO hyperfide.provisioning_intent_reservations(organisation_id,run_id,intent_id,reservation_id) VALUES($1,$2,$3,$4)', common + [intent, reservation])
                    reservations.append(reservation)
            return {'intent': intent, 'sandbox': sandbox, 'create_id': create_id, 'list_id': list_id, 'reservations': reservations, 'operation_digest': sha(json.dumps(original, sort_keys=True).encode())}

        unknown, known, destroyed = seed(False), seed(True), seed(True, 'DESTROY')
        matched_get, wrong_native_get, wrong_boot_get = [seed(True, create_unknown=True) for _ in range(3)]
        for entry, mismatch in [(matched_get, None), (wrong_native_get, 'native'), (wrong_boot_get, 'boot')]:
            physical = f.sql('SELECT native_sandbox_id,boot_generation::text FROM hyperfide.provisioning_intents WHERE organisation_id=$1 AND run_id=$2 AND id=$3', common + [entry['intent']])[0]
            body = {'operation': {'kind': 'observe'}, 'outcome': {'status': 'SUCCEEDED', 'acceptance': 'CONFIRMED_ACCEPTED', 'resource': {'native_sandbox_id': physical['native_sandbox_id'] + ('-other' if mismatch == 'native' else ''), 'sandbox_boot_generation': '2' if mismatch == 'boot' else physical['boot_generation']}, 'result': {'provider_state': 'RUNNING'}}}
            entry['get_id'], entry['get_digest'] = uid(), sha(json.dumps(body, sort_keys=True).encode())
            f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()-interval '90 seconds',$5)", [i['organisation'], entry['get_id'], entry['intent'], uid(), entry['get_digest'], json.dumps(body)])


        metadata_ids = set()
        for entry in [known, matched_get]:
            for kind in ['PROVIDER_INVENTORY_ATTRIBUTION_V1', 'FLEET_NATIVE_DAEMON_RECOVERY_OBSERVATION_V1']:
                binding = {'organisation_id': i['organisation'], 'run_id': i['run'], 'sandbox_id': entry['sandbox'], 'boot_generation': '1'}
                body = {'kind': kind, 'binding': binding, 'controlled_component_prerequisite': True}
                if kind == 'PROVIDER_INVENTORY_ATTRIBUTION_V1':
                    native_id = f.sql('SELECT native_sandbox_id FROM hyperfide.sandboxes WHERE organisation_id=$1 AND id=$2', [i['organisation'], entry['sandbox']])[0]['native_sandbox_id']
                    body.update(policy_digest=sha(b'controlled projection-only ownership policy'), scope={'organisation_id': i['organisation'], 'pool_id': pool, 'provider': 'railway', 'provider_account_id': 'component-fixture', 'environment_id': 'component-fixture', 'region': 'component-fixture', 'configuration_digest': config}, native_sandbox_id=native_id, classification='UNKNOWN', presence='PRESENT', foreign=None, probe_evidence_digest=sha(b'controlled projection metadata'))
                else:
                    body.update(request_digest=sha(b'controlled projection request'), receipt={'kind': 'CONTROLLED_PROJECTION_PREREQUISITE_NOT_EXECUTION_PROOF'}, receipt_raw_digest=sha(b'controlled projection receipt'))
                evidence, observation_id = sha(json.dumps(body, sort_keys=True).encode()), uid()
                metadata_ids.add(observation_id)
                f.sql("INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$5)", [i['organisation'], observation_id, entry['intent'], uid(), evidence, json.dumps(body)])

        def observe(key):
            return api('fleet.observe', {'binding': bindings[key], 'after': None, 'limit': 100}, key)

        own, other, primary = observe('manager'), observe('manager2'), observe('leader')
        rows = {row['provider_intent_id']: row for row in own['provider_intents']}
        row = rows[unknown['intent']]
        assert row['provider_outcome'] == 'UNKNOWN' and row['provider_acceptance'] == 'UNKNOWN', row
        assert row['create_observation_id'] == unknown['create_id'] and row['latest_observation_id'] == unknown['list_id'], row
        assert row['latest_observation_kind'] == 'list' and row['latest_recorded_outcome'] == 'SUCCEEDED' and row['latest_recorded_acceptance'] == 'CONFIRMED_ACCEPTED', row
        assert row['native_sandbox_id'] is None and row['native_identity_known'] is False and row['native_ownership_confirmed'] is False, row
        assert row['destroy_eligible'] is False and row['destroy_eligibility_reason'] == 'NATIVE_IDENTITY_UNPROVEN', row
        assert row['state'] == 'REJECTED' and row['failure_code'] == 'OPERATOR_RELEASED' and row['sandbox_state'] == 'DESTROYED', row
        assert row['administrative_disposition']['resolution'] == 'RELEASE' and row['administrative_disposition']['reservations_marked_release_pending'] == 4 and 'released_reservations' not in row['administrative_disposition'], row
        held = row['reservation_disposition']
        assert {item['reservation_id'] for item in held} == set(unknown['reservations']), held
        assert all(item['state'] == 'RELEASE_PENDING' and item['quantity'] == '1' and item['account_reserved'] == '1' and item['account_allocated'] == '0' for item in held), held
        assert unknown['sandbox'] not in {item['id'] for item in own['sandbox_candidates']}, own['sandbox_candidates']
        positive = rows[known['intent']]
        assert positive['provider_outcome'] == 'SUCCEEDED' and positive['provider_acceptance'] == 'CONFIRMED_ACCEPTED' and positive['native_identity_known'] is True and positive['native_ownership_confirmed'] is True, positive
        assert positive['ownership_observation_id'] == known['create_id'] and positive['latest_observation_kind'] == 'list', positive
        assert known['sandbox'] in {item['id'] for item in own['sandbox_candidates']}, own['sandbox_candidates']
        destroy_row = rows[destroyed['intent']]
        assert destroy_row['kind'] == 'DESTROY' and destroy_row['provider_outcome'] == 'SUCCEEDED' and destroy_row['provider_acceptance'] == 'CONFIRMED_ACCEPTED', destroy_row
        assert destroy_row['intent_operation_observation_kind'] == 'destroy' and destroy_row['intent_operation_observation_id'] == destroyed['create_id'] and destroy_row['intent_operation_observation_digest'] == destroyed['operation_digest'], destroy_row
        assert destroy_row['create_observation_id'] is None and destroy_row['create_observation_digest'] is None, destroy_row
        assert destroy_row['latest_observation_kind'] == 'list' and destroy_row['latest_observation_id'] == destroyed['list_id'], destroy_row
        reconciled = rows[matched_get['intent']]
        assert reconciled['provider_outcome'] == 'SUCCEEDED' and reconciled['provider_acceptance'] == 'CONFIRMED_ACCEPTED', reconciled
        assert reconciled['provider_outcome_observation_kind'] == 'observe' and reconciled['provider_outcome_observation_id'] == matched_get['get_id'] and reconciled['provider_outcome_observation_digest'] == matched_get['get_digest'], reconciled
        assert reconciled['create_observation_id'] == matched_get['create_id'] and reconciled['create_observation_digest'] == matched_get['operation_digest'], reconciled
        assert reconciled['latest_observation_kind'] == 'list' and reconciled['latest_observation_id'] == matched_get['list_id'], reconciled
        for rejected_get in [wrong_native_get, wrong_boot_get]:
            refused = rows[rejected_get['intent']]
            assert refused['provider_outcome'] == 'UNKNOWN' and refused['provider_acceptance'] == 'UNKNOWN', refused
            assert refused['provider_outcome_observation_id'] == rejected_get['create_id'] and refused['provider_outcome_observation_kind'] == 'create', refused
            assert refused['latest_observation_kind'] == 'list' and refused['latest_observation_id'] == rejected_get['list_id'], refused
        assert all(rows[entry['intent']]['latest_observation_id'] not in metadata_ids for entry in [known, matched_get]), rows
        assert not {unknown['intent'], known['intent'], destroyed['intent']} & {item['provider_intent_id'] for item in other['provider_intents']}, other['provider_intents']
        assert {unknown['intent'], known['intent'], destroyed['intent']} <= {item['provider_intent_id'] for item in primary['provider_intents']}, primary['provider_intents']
        print(json.dumps({'status': 'PASS', 'scope': 'isolated PostgreSQL prerequisites and production signed HTTPS fleet.observe projection', 'provider_calls': 0, 'model_inference': 'NOT_CLAIMED', 'native_auth_qualification': 'NOT_CLAIMED', 'observed_unknown': row, 'observed_known': positive, 'observed_destroy': destroy_row, 'checks': ['CREATE uncertainty survives newer accepted empty LIST', 'administrative release preserves actual held capacity', 'unknown native excluded from sandbox candidates', 'manager scope excludes other package while Primary sees both', 'known native CREATE evidence remains ownership positive', 'DESTROY outcome retains original operation provenance beneath newer LIST', 'matched accepted healthy GET reconciles original CREATE uncertainty with exact effective provenance', 'wrong-native and wrong-boot GET cannot replace original CREATE uncertainty', 'newer inventory and daemon metadata cannot mask latest lifecycle provenance']}))
    finally:
        f.close()


if __name__ == '__main__':
    main()
