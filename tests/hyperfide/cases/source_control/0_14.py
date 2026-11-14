#!/usr/bin/env python3
"""Real production supervisor -> signed HTTPS -> PostgreSQL -> configured model journey.

Protects distinct actual model actor identities and model-selected hierarchy effects.
Fixture credentials establish isolated enrollment only. No fake model responses,
provider readiness or install receipts may satisfy this gate. The full campaign
requires signed installation and real remote worker proof for live PASS.
The component campaign measures only owned API/database and local recovery boundaries.
"""
from pathlib import Path
import json
import hashlib
import shutil
import os
import subprocess
import sys
import tempfile
import select
import importlib.util
import socket
import uuid

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from identity_fixture import IdentityFixture, uid, b64, sha
from fleet_prerequisite_fixture import component_closure, model_environment, supervisor_config, register_owned_environment

OUT = ROOT / 'build/fleet/0.14'
NODE_COMMAND = os.environ.get('HYPERFIDE_FLEET_NODE') or shutil.which('node')
NODE = Path(NODE_COMMAND).resolve() if NODE_COMMAND else None
FAULT_CASES = ('supervisor_box_loss', 'stale_generation_replay',
               'ambiguous_provider_outcome', 'interrupted_install', 'failed_worker',
               'model_unavailability')


def require_node():
    if NODE is None or not NODE.is_file() or not os.access(NODE, os.X_OK):
        raise RuntimeError('NODE_BINARY_REQUIRED: set HYPERFIDE_FLEET_NODE or provide node on PATH')
    # Imported fixture helpers also use this selected executable through PATH.
    os.environ['PATH'] = str(NODE.parent) + os.pathsep + os.environ.get('PATH', '')
    return str(NODE)


def load_case(name):
    spec = importlib.util.spec_from_file_location('prerequisite_' + name,
                                                Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_receipt(filename, report):
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with filename.open('w') as stream:
        filename.chmod(0o600)
        stream.write(json.dumps(report, indent=2) + '\n')



def test_prerequisite_receipt_boundary(directory):
    """The real CLI keeps missing/invalid evidence BLOCKED with a private classified receipt."""
    from fleet_live_qualification import private_json
    environment = {key: value for key, value in os.environ.items()
                   if key not in ('HF_FLEET_QUALIFICATION_EVIDENCE', 'HF_FLEET_QUALIFICATION_TARGET')}
    target = directory / 'invalid-target.json'
    evidence = directory / 'invalid-index.json'
    write_receipt(target, {'schema_version': 1, 'contract_files': 'invalid', 'toolchains': [None]})
    write_receipt(evidence, {'schema_version': 1, 'kind': 'hyperfide.fleet-live-evidence',
                             'target_digest': 'sha256:' + '0' * 64})
    for name, options, code in [
        ('missing', [], 'LIVE_EVIDENCE_REQUIRED'),
        ('mismatched', ['--live-evidence', str(evidence), '--target', str(target)], 'EVIDENCE_TARGET_MISMATCH'),
    ]:
        receipt = directory / (name + '-live-receipt.json')
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), *options,
                                 '--receipt', str(receipt)], cwd=ROOT, env=environment,
                                capture_output=True, text=True, timeout=30)
        assert result.returncode == 2, (name, result.stdout, result.stderr)
        report = private_json(receipt)
        assert report['status'] == 'BLOCKED' and report['qualified'] is False
        assert report['refusal_code'] == code
        inventory = report['assertion_inventory']
        assert {'contract', 'source', 'toolchain', 'manifest', 'interface', 'provider'} == {row['category'] for row in inventory}
        assert inventory and all(row['status'] == 'UNRUN' and row['evidence'] == [] and row['missing_coverage'] == code for row in inventory)
        assert all(state == 'UNRUN' for state in report['live_cases'].values())
    return {'id': 'live-cli-requires-bound-evidence-and-private-classified-receipt', 'status': 'PASS'}


def component():
    """Exercise actual signed actors, PostgreSQL and deterministic recovery refusals."""
    from fleet_prerequisite_fixture import hierarchy_type
    from fleet_live_qualification import (Refused, TASK_CASES, assertion_inventory,
                                          fault_driver, unavailable_model_response)
    report = {'schema_version': 1, 'task': '0.14', 'mode': 'COMPONENT',
              'status': 'FAIL', 'component_status': 'FAIL', 'qualified': False,
              'assertions': [], 'fault_cases': {}, 'refusals': [],
              'signed_installation': 'UNRUN', 'remote_provider_worker': 'UNRUN',
              'durability_and_failover': 'UNRUN',
              'live_cases': {name: 'UNRUN' for name in TASK_CASES['0.14']},
              'scope': 'owned signed HTTPS/PostgreSQL, actual supervisor process restoration; no live provider or model qualification'}
    f = None
    source_backend = None
    try:
        node = require_node()
        if not os.environ.get('DATABASE_URL'):
            raise RuntimeError('OWNED_DATABASE_REQUIRED: run through support/withpg.py')
        actors = load_case('0_12')
        managers = load_case('0_13')
        with tempfile.TemporaryDirectory(prefix='hyperfide-014-component-') as directory:
            owned = Path(directory)
            report['assertions'].append(test_prerequisite_receipt_boundary(owned))
            source = owned / 'source'
            source.mkdir()
            (source / 'worker.mjs').write_text("console.log('fleet prerequisite worker');\n")
            for args in [['init', '-q'], ['add', 'worker.mjs'],
                         ['-c', 'user.name=Fleet Qualification', '-c', 'user.email=qualification@example.invalid',
                          'commit', '-qm', 'Pinned component source']]:
                subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
                                '-C', str(source), *args], check=True, capture_output=True)
            revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            source_backend = subprocess.Popen([node, '--input-type=module', '-e',
                "import{createSourceS3Fixture}from'./tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],
                cwd=ROOT, stdout=subprocess.PIPE, text=True)
            if not select.select([source_backend.stdout], [], [], 15)[0]:
                raise AssertionError('Owned source backend readiness failed')
            storage = json.loads(source_backend.stdout.readline())
            source_environment = {'HF_SOURCE_S3_ENDPOINT': storage['endpoint'], 'HF_SOURCE_S3_REGION': storage['region'],
                'HF_SOURCE_S3_BUCKET': storage['bucket'], 'HF_SOURCE_S3_ACCESS_KEY_ID': storage['accessKey'],
                'HF_SOURCE_S3_SECRET_ACCESS_KEY': storage['secretKey'], 'HF_SOURCE_ALLOW_LOOPBACK_HTTP': '1',
                'HF_SOURCE_CURSOR_KEY': 'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk',
                'HF_SOURCE_CACHE_BYTES': '16777216', 'HF_SOURCE_CACHE_ENTRIES': '1024',
                'HF_SOURCE_MAX_FILE_BYTES': '8388608', 'HF_SOURCE_MATERIALIZED_BYTES': '67108864',
                'HF_SOURCE_DIRTY_BYTES': '16777216'}
            components = component_closure(['fleet-orchestration', 'fleet-manager-effects', 'fleet-install-delivery'])
            grants = {'programme.activate', 'programme.provision', 'programme.dispatch'}
            for name in set(components + ['1.4', '4.1', '4.2', '4.4', '14.1']):
                grants.update(action for action in json.loads((ROOT / 'core/control-plane/components' / (name + '.json')).read_text())['actions']
                              if not action.startswith('source.'))
            f = hierarchy_type()(extra_components=components, credential_actions=sorted(grants),
                                 bootstrap=False, seed_historical_runtime=False, source_object_id=revision,
                                 extra_setup=actors.credential_store, extra_env=source_environment)
            report['assertions'].extend(register_owned_environment(f, source, revision))
            f.ok('hierarchy.leader.acquire', {'idempotency_key': '014-component-leader',
                 'expected_generation': '0', 'reason': 'Owned prerequisite component journey'})
            cohort = {'cohort_id': str(uuid.uuid4()), 'host_id': socket.gethostname(),
                      'leader_generation': '1', 'expected_generation': '0'}
            f.reject('fleet.cohort.bind', dict(cohort, host_id='wrong-host.invalid'),
                     'FLEET_HOST_MISMATCH', component='fleet-orchestration')
            f.ok('fleet.cohort.bind', cohort, component='fleet-orchestration')
            managers.test_manager_execute_scope_refusals(f, report)
            # Authentication fixture identities are not evidence of actual model sessions.
            bindings = []
            requests = []
            for key, package in [('leader', None), ('manager', 'package'), ('manager2', 'wave_package')]:
                binding = {'actor_id': f.ids[key], 'actor_role': 'WAVE_MANAGER' if package else 'PRIMARY',
                           'authority_epoch': f.ids['epoch'], 'leader_generation': '1',
                           'delegation_id': f.ids[package] if package else None,
                           'manager_generation': '2' if package else None}
                f.ok('fleet.session.bind', {'binding': binding}, key=key, component='fleet-orchestration')
                observed = f.ok('fleet.observe', {'binding': binding, 'after': None, 'limit': 100},
                                key=key, component='fleet-orchestration')
                request = {'binding': binding, 'operation_id': str(uuid.uuid4()),
                           'observation_id': observed['observation_id']}
                before = managers.effect_snapshot(f)
                missing = dict(request, operation_id=str(uuid.uuid4()), reconcile_only=True)
                f.reject('fleet.session.reason', missing, 'FLEET_REASONING_MISSING',
                         key=key, component='fleet-orchestration')
                assert managers.effect_snapshot(f) == before, 'Absent reconciliation admitted work'
                status, body = f.invoke('fleet.session.reason', request, key=key, component='fleet-orchestration')
                assert status == 200 and body.get('ok') is True, body
                waiting = body['result']
                rows = f.sql('SELECT id::text,state,reason FROM hyperfide.fleet_reasoning WHERE id=$1', [request['operation_id']])
                assert len(rows) == 1
                unavailable_model_response(body, rows[0], [waiting['reason']])
                assert waiting['state'] == 'WAITING_FOR_MANAGER' and waiting['deterministic_fallback'] is False
                retained = managers.effect_snapshot(f)
                replay = f.ok('fleet.session.reason', request, key=key, component='fleet-orchestration')
                assert replay['replayed'] is True and replay['model_replayed'] is False
                assert f.ok('fleet.session.reason', dict(request, reconcile_only=True), key=key,
                            component='fleet-orchestration') == replay
                assert managers.effect_snapshot(f) == retained, 'Reasoning replay changed durable effects'
                bindings.append(binding)
                requests.append((key, request))
            actor_rows = f.sql('SELECT session_id::text,actor_role,native_session_id,process_identity FROM hyperfide.fleet_actor_sessions ORDER BY session_id')
            assert {row['session_id'] for row in actor_rows} == {b['actor_id'] for b in bindings}
            assert all(row['native_session_id'] is None and row['process_identity'] is None for row in actor_rows)
            assert not f.sql('SELECT id FROM hyperfide.fleet_decisions')
            report['assertions'].append({'id': 'three-distinct-authenticated-actors-without-invented-models', 'status': 'PASS', 'actors': actor_rows})
            report['fault_cases']['model_unavailability'] = {'status': 'PASS', 'coverage': 'COMPONENT_ONLY',
                'operations': [request['operation_id'] for _, request in requests],
                'assertion': 'All three unavailable actors persist waiting, replay without inference and leave no decisions or effects'}
            f.ok('fleet.cohort.bind', dict(cohort, expected_generation='1'), component='fleet-orchestration')
            for key, request in requests:
                if key != 'leader':
                    before = managers.effect_snapshot(f)
                    f.reject('fleet.session.reason', dict(request, operation_id=str(uuid.uuid4())),
                             'FLEET_COHORT_STALE', key=key, component='fleet-orchestration')
                    assert managers.effect_snapshot(f) == before, 'Old manager cohort changed durable state'
                    f.ok('fleet.session.bind', {'binding': request['binding']},
                         key=key, component='fleet-orchestration')
                before = managers.effect_snapshot(f)
                f.reject('fleet.session.reason', dict(request, operation_id=str(uuid.uuid4())),
                         'FLEET_OBSERVATION_STALE', key=key, component='fleet-orchestration')
                assert managers.effect_snapshot(f) == before, 'Stale generation replay changed durable state'
            report['fault_cases']['stale_generation_replay'] = {'status': 'PASS', 'coverage': 'COMPONENT_ONLY',
                'assertion': 'Replacement cohort fences all three prior observations without effects'}
            OUT.mkdir(parents=True, exist_ok=True, mode=0o700)
            actors.supervisor_process_restoration(f, cohort, OUT)
            (OUT / 'supervisor-restoration.log').chmod(0o600)
            report['fault_cases']['supervisor_box_loss'] = {'status': 'PASS', 'coverage': 'LOCAL_PROCESS_RECOVERY_ONLY',
                'evidence': 'supervisor-restoration.log', 'live_provider_host_loss': 'UNRUN'}
            # Real empty execution tables cannot stand in for fault execution receipts.
            tables = ('runner_remote_jobs', 'provisioning_intents', 'fleet_worker_launches')
            execution_rows = {table: f.sql('SELECT to_jsonb(t) AS row FROM hyperfide.' + table + ' t ORDER BY to_jsonb(t)::text')
                              for table in tables}
            assert all(not rows for rows in execution_rows.values())
            target = {'run_id': f.ids['run'], 'authority_epoch': f.ids['epoch'],
                      'accepted_source_object_id': revision,
                      'fault_drivers': {name: {} for name in FAULT_CASES}}
            for name in FAULT_CASES:
                try:
                    fault_driver(name, {'driver_operation_id': str(uuid.uuid4())}, execution_rows, target, owned, {})
                except Refused as error:
                    assert str(error) == 'EXACT_RECORD_REQUIRED', (name, str(error))
                    report['refusals'].append({'case': name, 'code': str(error), 'boundary': 'signed fault execution evidence required'})
                else:
                    raise AssertionError('Missing authenticated fault execution accepted: ' + name)
            # The uncertain provider/install/worker cases have no owned execution proof.
            # Assert fail-closed admission; do not manufacture a provider outcome or failed native run.
            from fleet_live_qualification import one
            for name, table, key in [('ambiguous_provider_outcome', 'provisioning_intents', 'id'),
                                     ('interrupted_install', 'runner_remote_jobs', 'operation_id'),
                                     ('failed_worker', 'fleet_worker_launches', 'command_id')]:
                try:
                    one(execution_rows[table], key, str(uuid.uuid4()))
                except Refused as error:
                    assert str(error) == 'EXACT_RECORD_REQUIRED'
                else:
                    raise AssertionError('Missing fault outcome accepted: ' + name)
                report['fault_cases'][name] = {'status': 'PASS', 'coverage': 'MISSING_EXECUTION_REFUSAL_ONLY',
                    'code': 'EXACT_RECORD_REQUIRED', 'live_fault_execution': 'UNRUN'}
            assert set(report['fault_cases']) == set(FAULT_CASES)
            assert all(case['status'] == 'PASS' for case in report['fault_cases'].values())
            assert managers.effect_snapshot(f)['fleet_effect_receipts'] == []
            report['component_status'] = 'PASS'
            report['status'] = 'COMPONENT_PASS'
    except Exception as error:
        report['error'] = str(error)[:2400]
    finally:
        if f:
            f.close()
        if source_backend:
            source_backend.terminate()
            try:
                source_backend.wait(timeout=15)
            except subprocess.TimeoutExpired:
                source_backend.kill()
                source_backend.wait(timeout=15)
        report['assertion_inventory'] = assertion_inventory('0.14', component=report)
        write_receipt(OUT / 'component-receipt.json', report)
        write_receipt(OUT / 'receipt.json', report)
        write_receipt(OUT / 'live-receipt.json', {
            'schema_version': 1, 'task': '0.14', 'status': 'UNRUN', 'qualified': False,
            'reason': 'COMPONENT_MODE_ONLY', 'cases': report['live_cases'],
            'assertion_inventory': report['assertion_inventory']})
    print(json.dumps({'task': '0.14', 'status': report['status'], 'qualified': False,
                      'error': report.get('error'), 'live': 'UNRUN'}))
    return 0 if report['component_status'] == 'PASS' else 1


def run():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'task': '0.14', 'status': 'BLOCKED', 'assertions': [],
              'scope': 'owned PostgreSQL and actual configured-model production supervisor',
              'signed_installation': 'UNRUN', 'remote_provider_worker': 'UNRUN',
              'durability_and_failover': 'UNRUN'}
    fixture = None
    source_backend = None
    stamp_path = ROOT / 'core/control-plane/dist/.source-digest.json'
    if stamp_path.is_file():
        report['runtime_stamp_start'] = json.loads(stamp_path.read_text())
    try:
        require_node()
        if not os.environ.get('DATABASE_URL'):
            raise RuntimeError('CAPABILITY_MISSING: isolated PostgreSQL DATABASE_URL; run through support/withpg.py')
        driver = ROOT / 'core/control-plane/dist/fleet-supervisor.js'
        if not driver.is_file():
            raise RuntimeError('CAPABILITY_MISSING: built production fleet-supervisor.js')
        with tempfile.TemporaryDirectory(prefix='hyperfide-014-') as owned:
            owned = Path(owned)
            environment = model_environment(owned)
            # A genuine declared native profile satisfies the transitive runtime factory.
            # It is not exercised or qualified by this gateway actor campaign.
            native_document=json.loads((ROOT/'build/fleet/worker/private/native-profile.json').read_text())
            native_profile=native_document['profiles'][0]
            owned.chmod(0o711)
            native_home=owned/'native-home';native_home.mkdir(mode=0o700)
            os.chown(native_home,int(native_profile['target_uid']),int(native_profile['target_uid']))
            vendor=ROOT/'build/fleet/worker/private/claude-2.1.300'
            native_binary=owned/'claude'
            shutil.copyfile(vendor,native_binary);native_binary.chmod(0o555)
            measured='sha256:'+hashlib.sha256(native_binary.read_bytes()).hexdigest()
            if measured!=native_profile['binary']['digest']:
                raise RuntimeError('NATIVE_FIXTURE_BINARY_DRIFT')
            version=subprocess.check_output([str(native_binary),'--version'],text=True,timeout=15,
                env={'PATH':'/usr/bin:/bin','HOME':str(native_home),'LANG':'C.UTF-8'}).strip()
            if version!=native_profile['binary']['version']+' (Claude Code)':
                raise RuntimeError('NATIVE_FIXTURE_VERSION_DRIFT')
            native_profile['binary']['path']=str(native_binary)
            native_profile['runtime_home']=str(native_home)
            native_inventory=owned/'native-profiles.json'
            native_inventory.write_text(json.dumps(native_document));native_inventory.chmod(0o600)
            environment['HF_NATIVE_AUTH_PROFILES_FILE']=str(native_inventory)
            report['native_factory_input']={'state':'DECLARED_UNQUALIFIED','binary_digest':measured,
                'version_output':version,'target_uid':int(native_profile['target_uid']),
                'home_private':True,'credential_sources':0,'native_probes':'UNRUN'}
            source = owned / 'source'
            source.mkdir()
            (source / 'worker.mjs').write_text("console.log('fleet prerequisite worker');\n")
            for args in [['init', '-q'], ['add', 'worker.mjs'], ['-c', 'user.name=Fleet Qualification', '-c', 'user.email=qualification@example.invalid', 'commit', '-qm', 'Pinned qualification source']]:
                subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-C', str(source), *args], check=True, capture_output=True)
            revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
            def accepted_metadata(f):
                # Only accepted source/tasks are fixture metadata. All actors/configuration use public routes.
                # The actor-only store is real and empty: no worker credential is asserted or exercised.
                secrets=f.path/'credential-secrets';attachments=f.path/'credential-attachments'
                secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700)
                credentials=f.path/'credentials.json'
                credentials.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),
                    'attachment_root':str(attachments),'sources':[],'targets':[]}))
                credentials.chmod(0o600);f.env['HF_CREDENTIAL_CONFIG_FILE']=str(credentials)
                for name in ['repository','package','wave_package','task','task2','leader','manager','manager2','coordinator','coordinator_actor']:
                    f.ids[name]=uid()
                i=f.ids
                f.sql("INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES($1,$2,$3,'actor-source','https://example.invalid/actor-source.git')",[i['organisation'],i['repository'],i['project']])
                tree=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD^{tree}'],text=True).strip()
                for object_id,kind in [(revision,'commit'),(tree,'tree')]:
                    f.sql('INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id,object_type) VALUES($1,$2,$3,$4)',[i['organisation'],i['repository'],object_id,kind])
                f.sql("INSERT INTO hyperfide.run_repositories(organisation_id,run_id,repository_id,source_object_id,integration_ref) VALUES($1,$2,$3,$4,'refs/heads/main')",[i['organisation'],i['run'],i['repository'],revision])
                for package,task,feature in [('package','task','alpha'),('wave_package','task2','beta')]:
                    f.sql('INSERT INTO hyperfide.feature_packages(organisation_id,run_id,id,package_key,wave) VALUES($1,$2,$3,$4,1)',[i['organisation'],i['run'],i[package],'feature:'+feature+':wave:1'])
                    definition={'feature_key':feature,'purpose':'Plan independent verification of pinned worker.mjs through its own Wave Manager; report missing runtime capabilities without asserting execution.','touches':['worker.mjs']}
                    f.sql('INSERT INTO hyperfide.tasks(organisation_id,run_id,id,task_key,feature_package_id,spec_revision_id,criteria_digest,definition,wave) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)',[i['organisation'],i['run'],i[task],feature+'.1',i[package],i['spec'],sha((feature+' actual source verification').encode()),json.dumps(definition)])
                for name in ['leader','manager','manager2','coordinator']:
                    key=f.path/(name+'.pem')
                    subprocess.run(['openssl','genpkey','-algorithm','Ed25519','-out',str(key)],check=True,capture_output=True)
                    key.chmod(0o600)
                    public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
                    f.keys[name]={'path':key,'public_key_b64':b64(public[-32:])}
            components=component_closure(['fleet-orchestration', 'fleet-install-delivery','3.4'])
            source_backend=subprocess.Popen(['node','--input-type=module','-e',"import{createSourceS3Fixture}from'./tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],cwd=ROOT,stdout=subprocess.PIPE,text=True)
            if not select.select([source_backend.stdout],[],[],15)[0]:raise RuntimeError('Owned source backend did not start')
            storage=json.loads(source_backend.stdout.readline())
            source_environment={'HF_SOURCE_S3_ENDPOINT':storage['endpoint'],'HF_SOURCE_S3_REGION':storage['region'],'HF_SOURCE_S3_BUCKET':storage['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':storage['accessKey'],'HF_SOURCE_S3_SECRET_ACCESS_KEY':storage['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1','HF_SOURCE_CURSOR_KEY':'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk','HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608','HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
            grants={'programme.activate','programme.provision','programme.dispatch'}
            for name in set(components+['1.4','4.1','4.2','4.4','14.1']):
                grants.update(action for action in json.loads((ROOT/'core/control-plane/components'/(name+'.json')).read_text())['actions'] if not action.startswith('source.'))
            fixture = IdentityFixture(extra_components=components,credential_actions=sorted(grants),
                extra_setup=accepted_metadata,extra_env={**environment,**source_environment,'HF_SERVICE_REQUEST_DEADLINE_MS':'120000'})
            f = fixture
            report['assertions'].extend(register_owned_environment(f, source, revision))
            report['registration_scope'] = 'signed operator registration only; declared fixture image input; no image or installation readiness'
            backend=environment.get('HYPERFIDE_FLEET_MODEL_BACKEND','codex')
            connector='gateway' if backend=='gateway' else 'codex'
            def public_call(action,payload,key='operator',component='3.4'):
                status,response=f.invoke(action,payload,key=key,component=component)
                if status!=200 or response.get('ok') is not True:
                    raise AssertionError('Actual public actor registration refused: '+json.dumps(response))
                return response['result']
            public_call('hierarchy.supervisor.register',{'idempotency_key':'014-primary','expected_leader_generation':'0',
                'session_id':f.ids['leader'],'role':'LEADER','connector':connector,'account_key':'configured-primary'})
            config = supervisor_config(f, environment['HYPERFIDE_FLEET_HOST_ID'])
            managers_registered=False
            for cycle in range(5):
                result = subprocess.run(['node', str(driver), '--config', str(config), '--once'], cwd=ROOT,
                    env=f.env, capture_output=True, text=True, timeout=390)
                (OUT / ('supervisor-' + str(cycle) + '.log')).write_text(result.stdout + result.stderr)
                if result.returncode:
                    raise RuntimeError('SUPERVISOR_FAILED: cycle ' + str(cycle) + ', exit ' + str(result.returncode))
                if not managers_registered and (f.path/'leader.supervisor.json').is_file():
                    public_call('identity.service.issue',{'credential_id':f.ids['coordinator'],'actor_id':f.ids['coordinator_actor'],
                        'role':'COORDINATOR','public_key_b64':f.keys['coordinator']['public_key_b64'],
                        'allowed_actions':['hierarchy.supervisor.register'],'ttl_seconds':3600},component='14.1')
                    for name in ['manager','manager2']:
                        public_call('hierarchy.supervisor.register',{'idempotency_key':'014-'+name,'expected_leader_generation':'1',
                            'session_id':f.ids[name],'role':'FEATURE_MANAGER','connector':connector,'account_key':'configured-primary'},key='coordinator')
                    managers_registered=True
                rows = f.sql("SELECT a.session_id::text,a.actor_role,a.native_session_id,a.process_identity FROM hyperfide.fleet_actor_sessions a WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.native_session_id IS NOT NULL ORDER BY a.actor_role,a.session_id", [f.ids['organisation'],f.ids['run']])
                expected = {f.ids['leader'],f.ids['manager'],f.ids['manager2']}
                if expected.issubset({r['session_id'] for r in rows}):
                    break
            if not expected.issubset({r['session_id'] for r in rows}):
                states = f.sql("SELECT state,reason FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 ORDER BY created_at", [f.ids['organisation'], f.ids['run']])
                report['reasoning_states'] = states
                raise RuntimeError('THREE_ACTORS_INCOMPLETE: actual model actor sessions not observed for all configured actors')
            backend = environment.get('HYPERFIDE_FLEET_MODEL_BACKEND', 'codex')
            report['model_backend'] = backend
            sessions = [r['native_session_id'] for r in rows if r['session_id'] in expected]
            if len(set(sessions)) != 3 or any(not r['process_identity'] for r in rows):
                raise AssertionError('Native session or process identity is missing or shared')
            report['assertions'].append({'id':'three-real-local-actors', 'status':'PASS', 'session_kind':'LOGICAL_GATEWAY' if backend == 'gateway' else 'NATIVE_CLI', 'actors':rows})
            effects = f.sql("SELECT d.actor_id::text,d.action,d.body->'input' AS input,e.result FROM hyperfide.fleet_decisions d JOIN hyperfide.fleet_effect_receipts e ON e.organisation_id=d.organisation_id AND e.run_id=d.run_id AND e.decision_id=d.id WHERE d.organisation_id=$1 AND d.run_id=$2 ORDER BY e.created_at", [f.ids['organisation'],f.ids['run']])
            report['effects'] = effects
            accepted_packages={f.ids['package'],f.ids['wave_package']}
            configured={row['input'].get('package_id') for row in effects if row['action']=='CONFIGURE_WAVE'}
            delegated={row['input'].get('package_id') for row in effects if row['action']=='DELEGATE_WAVE'}
            if configured != accepted_packages or delegated != accepted_packages:
                raise AssertionError('Accepted independent packages were not model-configured and delegated')
            report['assertions'].append({'id':'model-configures-and-delegates-accepted-waves','status':'PASS'})
            model_receipts = f.sql("SELECT actor_id::text,result->'model_receipt' AS receipt FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND state='COMPLETED' ORDER BY created_at", [f.ids['organisation'], f.ids['run']])
            if backend == 'gateway' and any(not row['receipt'].get('upstream_response_id') or row['receipt'].get('session_kind') != 'LOGICAL_GATEWAY' for row in model_receipts):
                raise AssertionError('Gateway actor identity has no actual upstream completion receipt')
            report['model_receipts'] = model_receipts
            if not expected.issubset({r['actor_id'] for r in effects}):
                raise AssertionError('Real model decisions did not produce guarded effects for all actors')
            report['assertions'].append({'id':'three-actor-guarded-effects', 'status':'PASS'})
            report['status'] = 'ACTOR_PASS'
            report['qualified'] = False
    except Exception as error:
        report['blocker'] = str(error)[:1800]
        if isinstance(error, AssertionError):
            report['status'] = 'FAIL'
    finally:
        if fixture:
            try:
                report['reasoning_records'] = fixture.sql("SELECT actor_id::text,state,reason,(result->'decision') - 'rationale_summary' AS decision,result->'model_receipt' AS model_receipt,(result - 'decision') AS reasoning_result FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 ORDER BY created_at", [fixture.ids['organisation'],fixture.ids['run']])
            except Exception as error:
                report['reasoning_evidence_error'] = type(error).__name__
            fixture.close()
        if source_backend:
            source_backend.terminate()
            try:source_backend.wait(timeout=10)
            except subprocess.TimeoutExpired:source_backend.kill();source_backend.wait()
        if stamp_path.is_file():
            report['runtime_stamp_end'] = json.loads(stamp_path.read_text())
            report['runtime_stamp_changed'] = report.get('runtime_stamp_start') != report['runtime_stamp_end']
        write_receipt(OUT / 'actor-receipt.json', report)
    print(json.dumps({'status':report['status'], 'assertions':len(report['assertions']), 'blocker':report.get('blocker')}))
    return 0 if report['status'] == 'ACTOR_PASS' else 2

if __name__ == '__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.14', component, OUT, actors=run))
