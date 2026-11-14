#!/usr/bin/env python3
"""Real signed API/PG boundary: cohort fencing and unavailable model idempotency.

Logical fixture identities establish authentication only; native model execution
and live three actor/provider qualification require the private 0.12 campaign.
"""
from pathlib import Path
import json
import socket
import shutil
import hashlib
import os
import sys
import uuid
import subprocess
import select
import time
import platform
ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure, hierarchy_type
from fleet_live_qualification import unavailable_model_response, private_json, require, Refused


def native_profile(environment):
    filename = environment.get('HF_NATIVE_AUTH_PROFILES_FILE')
    require(filename, 'NATIVE_PROFILE_REQUIRED: set HF_NATIVE_AUTH_PROFILES_FILE to the private native inventory')
    try:
        return private_json(filename)
    except FileNotFoundError:
        raise Refused('NATIVE_PROFILE_MISSING: HF_NATIVE_AUTH_PROFILES_FILE must name an existing private native inventory')


def component_native_profile(f):
    """Declare the actual installed CLI for transitive factories, without model credentials."""
    command = shutil.which('codex')
    require(command, 'COMPONENT_NATIVE_BINARY_REQUIRED')
    installed = Path(command).resolve()
    if installed.read_bytes()[:4] != b'\x7fELF':
        architecture = {'x86_64':'x86_64', 'aarch64':'aarch64'}.get(platform.machine())
        candidates = list(installed.parents[1].glob('node_modules/@openai/codex-*/vendor/' + str(architecture) + '-*/bin/codex'))
        require(len(candidates) == 1, 'COMPONENT_NATIVE_BINARY_REQUIRED')
        installed = candidates[0].resolve()
    require(installed.read_bytes()[:4] == b'\x7fELF', 'COMPONENT_NATIVE_ELF_REQUIRED')
    version = subprocess.check_output([str(installed), '--version'], text=True, timeout=10).strip()
    require(version.startswith('codex-cli '), 'COMPONENT_NATIVE_VERSION_REQUIRED')
    home = f.path / 'component-native-home'
    home.mkdir(mode=0o700)
    target_uid = 65534
    os.chown(home, target_uid, target_uid)
    profile = {'schema_version':1, 'profile_id':'component-codex', 'profile_revision':'1',
        'connector':'codex', 'auth_mode':'account_session',
        'binary':{'path':str(installed), 'digest':'sha256:' + hashlib.sha256(installed.read_bytes()).hexdigest(),
                  'version':version.removeprefix('codex-cli ')},
        'credential_reference':'component-unavailable', 'configured_provider_id':'openai',
        'configured_model_alias':'component-unqualified', 'requested_model_id':'component-unqualified',
        'permission_profile_id':'read-only', 'configured_account_key':'component-unavailable',
        'capabilities':{'unattended':False, 'refresh':False, 'concurrent_account':False,
                        'portable_session':False, 'explicit_resume':False},
        'runtime_home':str(home), 'target_uid':target_uid}
    inventory = f.path / 'component-native-profiles.json'
    inventory.write_text(json.dumps({'schema_version':1, 'profiles':[profile]}))
    inventory.chmod(0o600)
    f.env['HF_NATIVE_AUTH_PROFILES_FILE'] = str(inventory)


def credential_store(f):
    secrets=f.path/'credential-secrets';attachments=f.path/'credential-attachments'
    secrets.mkdir(mode=0o700);attachments.mkdir(mode=0o700)
    config=f.path/'credential-store.json'
    config.write_text(json.dumps({'schema_version':1,'secret_root':str(secrets),'attachment_root':str(attachments),'sources':[],'targets':[]}))
    config.chmod(0o600);f.env['HF_CREDENTIAL_CONFIG_FILE']=str(config)
    if 'HF_NATIVE_AUTH_PROFILES_FILE' not in f.env:
        component_native_profile(f)
    native=native_profile(f.env)
    for number, profile in enumerate(native['profiles']):
        binary=f.path/('declared-native-' + str(number))
        try:
            shutil.copyfile(profile['binary']['path'],binary)
        except FileNotFoundError:
            raise Refused('NATIVE_PROFILE_BINARY_MISSING')
        binary.chmod(0o555)
        assert 'sha256:'+hashlib.sha256(binary.read_bytes()).hexdigest()==profile['binary']['digest']
        home=f.path/('declared-native-home-' + str(number));home.mkdir(mode=0o700)
        os.chown(home,int(profile['target_uid']),int(profile['target_uid']))
        profile['binary']['path']=str(binary);profile['runtime_home']=str(home)
    inventory=f.path/'declared-native-profiles.json';inventory.write_text(json.dumps(native));inventory.chmod(0o600)
    f.env['HF_NATIVE_AUTH_PROFILES_FILE']=str(inventory)
    # This component deliberately exercises unavailable reasoning, regardless of ambient model authorization.
    for name in list(f.env):
        if name.startswith('HYPERFIDE_FLEET_CODEX_') or name in ('CHAT_COMPLETIONS_URL','HYPERFIDE_FLEET_GATEWAY_ENDPOINT'):
            f.env.pop(name)
    f.env['HYPERFIDE_FLEET_MODEL_BACKEND']='codex'


def supervisor_process_restoration(f, cohort, out):
    actors={}
    for name, role in [('leader','LEADER'),('manager','FEATURE_MANAGER'),('manager2','FEATURE_MANAGER')]:
        filename=f.path/(name+'.supervisor.json')
        filename.write_text(json.dumps({'schema_version':1,'credential_id':f.ids[name],
            'actor_id':f.ids[name],'organisation_id':f.ids['organisation'],'run_id':f.ids['run'],
            'role':role,'authority_epoch':f.ids['epoch'],'key_file':str(f.keys[name]['path'])}))
        filename.chmod(0o600)
        actors[name]={'session_id':f.ids[name],'credential_file':str(filename)}
    config=f.path/'component-supervisor.json'
    state=f.path/'component-supervisor-state'
    config.write_text(json.dumps({'schema_version':1,'origin':f.origin,'ca_file':str(f.ca),
        'organisation_id':f.ids['organisation'],'run_id':f.ids['run'],
        'cohort_id':cohort['cohort_id'],'host_id':cohort['host_id'],'leader_generation':'1',
        'expected_cohort_generation':'2','primary':actors['leader'],
        'managers':[actors['manager'],actors['manager2']],'state_directory':str(state),
        'poll_interval_ms':1000,'request_timeout_ms':10000}))
    config.chmod(0o600)
    command=['node',str(ROOT/'core/control-plane/dist/fleet-supervisor.js'),'--config',str(config)]
    stdout=f.path/'supervisor.stdout';stderr=f.path/'supervisor.stderr'
    child=None
    try:
        with stdout.open('w') as output, stderr.open('w') as errors:
            child=subprocess.Popen(command,cwd=ROOT,env=f.env,stdout=output,stderr=errors)
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            events=[json.loads(line) for line in stdout.read_text().splitlines()]
            if any(e['event']=='reasoned' for e in events):break
            assert child.poll() is None, 'Supervisor exited: '+stderr.read_text()
            time.sleep(0.05)
        else:raise AssertionError('Supervisor did not finish its real unavailable-model round')
        child.kill();child.wait(timeout=10)
        before=f.sql('SELECT id::text,request_digest,state,result,reason FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 ORDER BY id',[f.ids['organisation'],f.ids['run']])
        assert (state/'state.json').is_file()
        restored=subprocess.run(command+['--restore-only'],cwd=ROOT,env=f.env,capture_output=True,text=True,timeout=30)
        (out/'supervisor-restoration.log').write_text(stdout.read_text()+stderr.read_text()+restored.stdout+restored.stderr)
        assert restored.returncode==0, restored.stderr
        restored_events=[json.loads(line) for line in restored.stdout.splitlines()]
        assert any(e['event']=='restored' and e['model_calls']==0 for e in restored_events)
        after=f.sql('SELECT id::text,request_digest,state,result,reason FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 ORDER BY id',[f.ids['organisation'],f.ids['run']])
        assert after==before, 'Process restoration made a new model request or rewrote a retained result'
        assert not f.sql('SELECT id FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',[f.ids['organisation'],f.ids['run']])
    finally:
        if child and child.poll() is None:child.kill();child.wait(timeout=10)


def run():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),'--component'],cwd=ROOT).returncode
    out = ROOT / 'build/fleet/0.12'
    out.mkdir(parents=True, exist_ok=True)
    f = None
    source_backend = None
    report = {'task':'0.12', 'status':'FAIL', 'live_model_qualified':False, 'assertions':[]}
    try:
        for environment, code in [({},'NATIVE_PROFILE_REQUIRED'),({'HF_NATIVE_AUTH_PROFILES_FILE':str(out/'absent-native-profile.json')},'NATIVE_PROFILE_MISSING')]:
            try:native_profile(environment)
            except Refused as error:assert str(error).startswith(code)
            else:raise AssertionError('Absent private native profile accepted')
        source_backend=subprocess.Popen(['node','--input-type=module','-e',"import{createSourceS3Fixture}from'./tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],cwd=ROOT,stdout=subprocess.PIPE,text=True)
        assert select.select([source_backend.stdout],[],[],15)[0], 'Owned source backend readiness failed'
        storage=json.loads(source_backend.stdout.readline())
        source_environment={'HF_SOURCE_S3_ENDPOINT':storage['endpoint'],'HF_SOURCE_S3_REGION':storage['region'],
            'HF_SOURCE_S3_BUCKET':storage['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':storage['accessKey'],
            'HF_SOURCE_S3_SECRET_ACCESS_KEY':storage['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1',
            'HF_SOURCE_CURSOR_KEY':'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk',
            'HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608',
            'HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
        components=component_closure(['fleet-orchestration'])
        grants={'programme.activate','programme.provision','programme.dispatch'}
        for name in set(components+['1.4','4.1','4.2','4.4','14.1']):
            grants.update(action for action in json.loads((ROOT/'core/control-plane/components'/(name+'.json')).read_text())['actions'] if not action.startswith('source.'))
        f = hierarchy_type()(extra_components=components,credential_actions=sorted(grants), bootstrap=False, seed_historical_runtime=False,extra_setup=credential_store,extra_env=source_environment)
        report['stage']='leader-acquire'
        f.ok('hierarchy.leader.acquire', {'idempotency_key':'012-leader', 'expected_generation':'0', 'reason':'Owned signed cohort qualification'})
        binding = {'actor_id':f.ids['leader'], 'actor_role':'PRIMARY', 'authority_epoch':f.ids['epoch'], 'leader_generation':'1', 'delegation_id':None, 'manager_generation':None}
        cohort = {'cohort_id':str(uuid.uuid4()), 'host_id':socket.gethostname(), 'leader_generation':'1', 'expected_generation':'0'}
        f.reject('fleet.cohort.bind', dict(cohort,host_id='wrong-host.invalid'), 'FLEET_HOST_MISMATCH', component='fleet-orchestration')
        report['stage']='cohort-bind'
        ready = f.ok('fleet.cohort.bind', cohort, component='fleet-orchestration')
        assert ready['model_session_observed'] is False
        report['stage']='observe'
        observed = f.ok('fleet.observe', {'binding':binding,'after':None,'limit':100}, component='fleet-orchestration')
        request = {'binding':binding,'operation_id':str(uuid.uuid4()),'observation_id':observed['observation_id']}
        report['stage']='reconcile-without-admission'
        missing=dict(request,operation_id=str(uuid.uuid4()),reconcile_only=True)
        f.reject('fleet.session.reason',missing,'FLEET_REASONING_MISSING',component='fleet-orchestration')
        assert not f.sql('SELECT id FROM hyperfide.fleet_reasoning WHERE id=$1',[missing['operation_id']])
        report['stage']='reason-unavailable'
        status,body=f.invoke('fleet.session.reason',request,component='fleet-orchestration',key='leader')
        assert status==200 and body.get('ok') is True
        waiting=body['result']
        records=f.sql('SELECT id::text,state,reason FROM hyperfide.fleet_reasoning WHERE organisation_id=$1 AND run_id=$2 AND id=$3',[f.ids['organisation'],f.ids['run'],request['operation_id']])
        assert len(records)==1
        unavailable_model_response(body,records[0],[waiting['reason']])
        for field,value in [('deterministic_fallback',True),('reason','UNRELATED_FAILURE'),('operation_id',str(uuid.uuid4()))]:
            altered=json.loads(json.dumps(body));altered['result'][field]=value
            try: unavailable_model_response(altered,records[0],[waiting['reason']])
            except Refused: pass
            else: raise AssertionError('Unbound unavailable-model response accepted: '+field)
        assert waiting['state']=='WAITING_FOR_MANAGER' and waiting['deterministic_fallback'] is False
        report['stage']='reason-replay'
        replay = f.ok('fleet.session.reason', request, component='fleet-orchestration')
        assert replay['replayed'] is True and replay['model_replayed'] is False
        reconciled=f.ok('fleet.session.reason',dict(request,reconcile_only=True),component='fleet-orchestration')
        assert reconciled==replay
        f.reject('fleet.session.reason',dict(request,observation_id=str(uuid.uuid4()),reconcile_only=True),'FLEET_OPERATION_CONFLICT',component='fleet-orchestration')
        assert not f.sql('SELECT id FROM hyperfide.fleet_decisions WHERE organisation_id=$1 AND run_id=$2',[f.ids['organisation'],f.ids['run']])
        report['assertions'].append('Missing model persists waiting without invented decision or repeated model attempt')
        report['stage']='cohort-replace'
        f.ok('fleet.cohort.bind', dict(cohort,expected_generation='1'), component='fleet-orchestration')
        f.reject('fleet.session.reason', dict(request,operation_id=str(uuid.uuid4())), 'FLEET_OBSERVATION_STALE', component='fleet-orchestration')
        report['assertions'].append('Replaced cohort fences old observations even with unchanged leader generation')
        report['stage']='supervisor-process-restoration'
        supervisor_process_restoration(f,cohort,out)
        report['assertions'].append('SIGKILL restoration preserves reasoning rows and cannot call an unavailable model')
        report['assertions'].append('Explicit private profile configuration gives typed missing-file refusals')
        report['status']='PASS'
    except Exception as error:
        report['error']=str(error)[:2400]
    finally:
        if f: f.close()
        if source_backend:
            source_backend.terminate()
            source_backend.wait(timeout=15)
        (out/'receipt.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
    return 0 if report['status']=='PASS' else 1

if __name__=='__main__':
    sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
    from fleet_live_qualification import main as qualify_live
    raise SystemExit(qualify_live('0.12', run, ROOT / 'build/fleet/0.12'))
