#!/usr/bin/env python3
"""Signed provider configuration against real retained pool/absence/accounting prerequisites; no provider calls."""
import copy
import importlib.util
import json
import subprocess
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
spec = importlib.util.spec_from_file_location('rebind_provider_fixture', ROOT / 'tests/hyperfide/cases/tasks/8_3.py')
provider = importlib.util.module_from_spec(spec)
spec.loader.exec_module(provider)


def uid():
    return str(uuid.uuid4())


def digest(value):
    return provider.sha(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode())


def main():
    names = ['safe', 'held', 'nonterminal', 'unknown-native', 'wrong-digest', 'identity', 'deleted-orphan', 'historical-released', 'stale-config', 'unrelated-held']

    def setup(f):
        provider.prepare_provider_intent_fixture(f)
        manifest = copy.deepcopy(f.sql('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2', [f.ids['organisation'], f.profile])[0]['manifest'])
        manifest['profile']['profile_version'] = '2.0.0'
        manifest.pop('digest')
        manifest['digest'] = digest(manifest)
        f.new_profile, f.new_digest = uid(), manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,provider,runtime_platform,content_digest,manifest) VALUES($1,$2,'railway','linux-x86_64',$3,$4)", [f.ids['organisation'], f.new_profile, f.new_digest, manifest])
        original = f.config['pools'][0]
        f.pools = {}
        for index, name in enumerate(names):
            pool = copy.deepcopy(original)
            pool['id'] = original['id'] if index == 0 else uid()
            pool['environment_key'] = 'component-rebind-' + name
            f.pools[name] = pool
        f.config['pools'] = list(f.pools.values())
        f.configfile.write_text(json.dumps(f.config))

    f = provider.pools.ProvisionerFixture(extra_components=['8.2'], extra_setup=setup)
    try:
        i = f.ids
        common = [i['organisation'], i['run']]

        def configure(document):
            f.configfile.write_text(json.dumps(document))
            return f.invoke('provider.pools.configure', {}, component='8.2', key='operator')[1]

        initial = configure(f.config)
        assert initial.get('ok'), initial

        def row(pool):
            return f.sql('SELECT profile_id::text,state_version::text FROM hyperfide.provider_pools WHERE organisation_id=$1 AND id=$2', [i['organisation'], pool])[0]

        def configuration(pool):
            return f.sql('SELECT configuration_digest FROM hyperfide.provider_pool_configurations WHERE organisation_id=$1 AND pool_id=$2 AND active', [i['organisation'], pool])[0]['configuration_digest']

        def held_snapshot(pool):
            return f.sql('SELECT a.id::text,a.reserved::text,a.allocated::text,r.id::text AS reservation_id,r.state,r.quantity::text FROM hyperfide.capacity_accounts a LEFT JOIN hyperfide.reservations r ON r.organisation_id=a.organisation_id AND r.capacity_account_id=a.id WHERE a.organisation_id=$1 AND a.pool_id=$2 ORDER BY a.id,r.id', [i['organisation'], pool])

        def reservation(pool, released):
            account = f.sql("SELECT id FROM hyperfide.capacity_accounts WHERE organisation_id=$1 AND pool_id=$2 AND dimension='SANDBOX' AND capacity_class='PHYSICAL' AND resource_key=''", [i['organisation'], pool])[0]['id']
            if not released:
                f.sql('UPDATE hyperfide.capacity_accounts SET configured_limit=1,reserved=1,state_version=state_version+1 WHERE organisation_id=$1 AND id=$2', [i['organisation'], account])
            rid = uid()
            f.sql("INSERT INTO hyperfide.reservations(organisation_id,run_id,id,request_id,capacity_account_id,quantity,expires_at,state,released_at) VALUES($1,$2,$3,$4,$5,1,clock_timestamp()+interval '1 hour',$6,CASE WHEN $6='RELEASED' THEN clock_timestamp() ELSE NULL END)", common + [rid, uid(), account, 'RELEASED' if released else 'RELEASE_PENDING'])
            return rid

        def absence(pool, unknown=False, boot=1):
            sandbox, intent = uid(), uid()
            native = None if unknown else 'component-absent-' + sandbox
            f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,desired_state,observed_state,boot_generation) VALUES($1,$2,$3,$4,'DESTROYED','DESTROYED',$5)", [i['organisation'], sandbox, pool, native, boot])
            if unknown:
                return sandbox
            declared = next(item for item in f.pools.values() if item['id'] == pool)
            operation = {'kind': 'observe', 'scope': {'organisation_id': i['organisation'], 'pool_id': pool, 'provider': declared['provider'], 'provider_account_id': declared['account_key'], 'environment_id': declared['environment_key'], 'region': declared['region'], 'configuration_digest': configuration(pool)}}
            observation = {'operation': operation, 'outcome': {'status': 'SUCCEEDED', 'acceptance': 'CONFIRMED_ACCEPTED', 'resource': {'native_sandbox_id': native, 'sandbox_boot_generation': str(boot)}, 'result': {'provider_state': 'DESTROYED', 'health': 'ABSENT'}}}
            f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'DESTROY',$7,$8,$8,$9,'TERMINAL',$10,$11)", common + [intent, pool, sandbox, configuration(pool), 'component-' + intent, digest(operation), json.dumps(operation), native, boot])
            f.sql('INSERT INTO hyperfide.provider_observations(organisation_id,id,intent_id,operation_id,payload_digest,observation,observed_at,evidence_digest) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$5)', [i['organisation'], uid(), intent, uid(), digest(observation), json.dumps(observation)])
            return sandbox

        for name in names[:-1]:
            pool = f.pools[name]['id']
            sandbox = absence(pool, unknown=name == 'unknown-native', boot=2 if name == 'historical-released' else 1)
            reservation(pool, released=name != 'held')
            if name == 'nonterminal':
                intent = uid()
                f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$9,'{}','UNKNOWN',1)", common + [intent, pool, sandbox, configuration(pool), f.profile, 'component-' + intent, digest({'component': intent})])
            if name == 'deleted-orphan':
                f.sql("INSERT INTO hyperfide.provider_orphans(organisation_id,pool_id,native_sandbox_id,state,ownership_evidence_digest) VALUES($1,$2,$3,'DELETED',$4)", [i['organisation'], pool, 'component-orphan-without-provider-proof', provider.sha(b'controlled operator deleted attestation')])
            if name == 'historical-released':
                intent = uid()
                f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,failure_code,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$9,'{}','REJECTED','OPERATOR_RELEASED',1)", common + [intent, pool, sandbox, configuration(pool), f.profile, 'component-' + intent, digest({'component': intent})])
        unrelated = f.pools['unrelated-held']['id']
        reservation(unrelated, released=False)
        other_hold = held_snapshot(unrelated)
        checks = []

        def candidate(name):
            document = copy.deepcopy(f.config)
            selected = copy.deepcopy(f.pools[name])
            selected.update(profile_id=f.new_profile, preparation_digest=f.new_digest)
            document['pools'] = [selected, copy.deepcopy(f.pools['unrelated-held'])]
            return document

        for name, code in [('held', 'POOL_PROFILE_BUSY'), ('nonterminal', 'POOL_PROFILE_BUSY'), ('unknown-native', 'POOL_PROFILE_BUSY'), ('wrong-digest', 'POOL_PROFILE_TRANSITION_DENIED'), ('identity', 'POOL_IDENTITY_CONFLICT'), ('deleted-orphan', 'POOL_PROFILE_BUSY'), ('historical-released', 'POOL_PROFILE_BUSY')]:
            pool = f.pools[name]['id']
            before, before_config, before_holds = row(pool), configuration(pool), held_snapshot(pool)
            document = candidate(name)
            if name == 'wrong-digest':
                document['pools'][0]['preparation_digest'] = provider.sha(b'wrong immutable digest')
            if name == 'identity':
                document['pools'][0]['region'] = 'different-component-region'
            refused = configure(document)
            assert refused.get('error', {}).get('code') == code, (name, refused)
            assert row(pool) == before and configuration(pool) == before_config and held_snapshot(pool) == before_holds
            assert f.sql('SELECT id FROM hyperfide.provider_pool_profile_transitions WHERE organisation_id=$1 AND pool_id=$2', [i['organisation'], pool]) == []
            assert held_snapshot(unrelated) == other_hold
            checks.append(name + ' refuses ' + code + ' without changing retained state')

        stale = f.pools['stale-config']['id']
        f.configfile.write_text(json.dumps(candidate('stale-config')))
        scope_script = "import{readDeployment,configuredScope}from'./core/control-plane/dist/providers/pools.js';const c=await readDeployment(process.env),p=c.pools.find(p=>p.id===process.argv[1]);console.log(JSON.stringify({scope:configuredScope(c,p),pool:p,account:c.accounts.find(a=>a.provider===p.provider&&a.account_key===p.account_key)}));"
        scoped = subprocess.run(['node', '--input-type=module', '-e', scope_script, stale], cwd=ROOT, env=f.env, text=True, capture_output=True, timeout=15)
        assert scoped.returncode == 0, scoped.stderr
        document = json.loads(scoped.stdout)
        f.sql('UPDATE hyperfide.provider_pool_configurations SET active=false WHERE organisation_id=$1 AND pool_id=$2', [i['organisation'], stale])
        f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document,active) VALUES($1,$2,$3,$4,true)', [i['organisation'], stale, document['scope']['configuration_digest'], document])
        assert row(stale)['profile_id'] == f.profile
        transitions = []
        for positive_name in ['safe', 'stale-config']:
            pool = f.pools[positive_name]['id']
            before, old_config, released = row(pool), configuration(pool), held_snapshot(pool)
            accepted = configure(candidate(positive_name))
            assert accepted.get('ok'), accepted
            after = row(pool)
            assert after == {'profile_id': f.new_profile, 'state_version': str(int(before['state_version']) + 1)}, after
            audit = f.sql('SELECT previous_state_version::text,old_profile_id::text,old_profile_digest,new_profile_id::text,new_profile_digest,old_configuration_digest,new_configuration_digest,actor_credential_id::text,actor_role,operation_id::text,payload_digest FROM hyperfide.provider_pool_profile_transitions WHERE organisation_id=$1 AND pool_id=$2', [i['organisation'], pool])
            assert len(audit) == 1, audit
            entry = audit[0]
            assert entry['previous_state_version'] == before['state_version'] and entry['old_profile_id'] == f.profile and entry['old_profile_digest'] == f.preparation, entry
            assert entry['new_profile_id'] == f.new_profile and entry['new_profile_digest'] == f.new_digest and entry['old_configuration_digest'] == old_config and entry['new_configuration_digest'] == configuration(pool), entry
            assert entry['actor_credential_id'] == i['operator'] and entry['actor_role'] == 'OPERATOR' and entry['operation_id'] and entry['payload_digest'], entry
            assert held_snapshot(pool) == released and held_snapshot(unrelated) == other_hold
            replay = configure(candidate(positive_name))
            assert replay.get('ok') and row(pool) == after, replay
            assert f.sql('SELECT previous_state_version::text,old_profile_id::text,old_profile_digest,new_profile_id::text,new_profile_digest,old_configuration_digest,new_configuration_digest,actor_credential_id::text,actor_role,operation_id::text,payload_digest FROM hyperfide.provider_pool_profile_transitions WHERE organisation_id=$1 AND pool_id=$2', [i['organisation'], pool]) == audit
            assert held_snapshot(unrelated) == other_hold
            transitions.append(entry)
        checks.extend(['confirmed absence and released reservations permit audited same-identity profile rebind with version+1', 'stale DB profile rebinds even when active configuration already pins new profile', 'exact configuration replay preserves profile version and single durable transition', 'unrelated other-pool held reservation and counters preserved'])
        print(json.dumps({'status': 'PASS', 'scope': 'signed production provider.pools.configure and isolated PostgreSQL prerequisites', 'provider_calls': 0, 'physical_readiness': 'NOT_CLAIMED', 'checks': checks, 'transitions': transitions}))
    finally:
        f.close()


if __name__ == '__main__':
    main()
