#!/usr/bin/env python3
"""Real production supervisor -> signed HTTPS -> PostgreSQL -> configured model journey.

Protects distinct actual model actor identities and model-selected hierarchy effects.
Fixture credentials establish isolated enrollment only. No fake model responses,
provider readiness or install receipts may satisfy this gate. The full campaign
remains BLOCKED until signed installation and real remote worker proof complete.
"""
from pathlib import Path
import json
import hashlib
import shutil
import os
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from identity_fixture import IdentityFixture, uid, b64, sha
from fleet_prerequisite_fixture import component_closure, model_environment, supervisor_config, register_owned_environment

OUT = ROOT / 'build/fleet/0.14'

def run():
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'task': '0.14', 'status': 'BLOCKED', 'assertions': [],
              'scope': 'owned PostgreSQL and actual configured-model production supervisor',
              'signed_installation': 'UNRUN', 'remote_provider_worker': 'UNRUN',
              'durability_and_failover': 'UNRUN'}
    fixture = None
    stamp_path = ROOT / 'core/control-plane/dist/.source-digest.json'
    if stamp_path.is_file():
        report['runtime_stamp_start'] = json.loads(stamp_path.read_text())
    try:
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
            fixture = IdentityFixture(extra_components=component_closure(['fleet-orchestration', 'fleet-install-delivery','3.4']),
                extra_setup=accepted_metadata,extra_env={**environment,'HF_SERVICE_REQUEST_DEADLINE_MS':'120000'})
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
            report['blocker'] = 'Signed environment installation and real remote provider worker journey remain required'
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
        if stamp_path.is_file():
            report['runtime_stamp_end'] = json.loads(stamp_path.read_text())
            report['runtime_stamp_changed'] = report.get('runtime_stamp_start') != report['runtime_stamp_end']
        (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status':report['status'], 'assertions':len(report['assertions']), 'blocker':report.get('blocker')}))
    return 1 if report['status'] == 'FAIL' else 2

if __name__ == '__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.14', run, ROOT / 'build/fleet/0.14'))
