#!/usr/bin/env python3
"""Actual signed keeper admission and SDK/Unix process boundary; original READY inputs are controlled prerequisites."""
import argparse
import signal
import select
import tempfile
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from fleet_prerequisite_fixture import component_closure
from source_archive_http_fixture import BlaxelHttpFixture
from fleet_archive_worker_fixture import NativeArchiveWorkerHandlers


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


objects_module = load('pre_ready_object_fixture', 'tests/hyperfide/cases/tasks/15_2.py')
provider = load('daemon_provider_fixture', 'tests/hyperfide/cases/tasks/8_3.py')


def uid():
    return str(uuid.uuid4())


def sha(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def write(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    file.write_bytes(canonical(value))
    file.chmod(0o600)


def stable(seed):
    raw = bytearray(hashlib.sha256(seed.encode()).digest()[:16])
    raw[6] = (raw[6] & 15) | 64
    raw[8] = (raw[8] & 63) | 128
    return str(uuid.UUID(bytes=bytes(raw)))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--dead-only',action='store_true');parser.add_argument('--recover-authority',action='store_true');parser.add_argument('--original-native',type=Path);parser.add_argument('--recovery-helper',type=Path);args=parser.parse_args()
    objects=objects_module.ObjectFixture()
    holder = {'wake':False}
    entered, release_reply = threading.Event(), threading.Event()
    submissions = []

    def remote(value):
        path = Path(value)
        if not path.is_absolute() or '..' in path.parts:
            raise PermissionError('Absolute owned guest path required')
        if holder.get('guest') and (path == holder['guest'] or holder['guest'] in path.parents):
            return path
        return holder['guest'] / str(path).lstrip('/')

    def processes(method, ident, body):
        if method=='GET' and ident==holder.get('original_process',{}).get('name'):
            return 200,holder['original_process']
        if holder.get('wake') and holder.get('daemon') and holder['daemon'].poll() is None:
            os.kill(holder['daemon'].pid,signal.SIGCONT)
        result=holder['handlers'].process_handler(method,ident,body)
        if method=='POST' and ident is None:submissions.append({'name':body['name'],'command':body['command'],'keepAlive':body.get('keepAlive'),'timeout':body.get('timeout')})
        return result

    backend = BlaxelHttpFixture({'metadata': {'name': 'not-configured'}}, remote, processes)
    original_route = backend.server.RequestHandlerClass.route

    def route(handler):
        path = unquote(urlsplit(handler.path).path)
        if handler.command == 'PUT' and '/filesystem/' in path:
            value = json.loads(handler.rfile.read(int(handler.headers.get('content-length', '0'))))
            if value.get('isDirectory') is not True:
                return handler.send(405, {'message': 'Only owned directory creation admitted'})
            destination = remote('/' + path.split('/filesystem/', 1)[1].lstrip('/'))
            destination.mkdir(parents=True, exist_ok=True, mode=int(value.get('permissions', '0700'), 8))
            return handler.send(200, {'path': str(destination), 'isDirectory': True})
        return original_route(handler)

    backend.server.RequestHandlerClass.route = route
    sleeper = None
    guest_root=Path(tempfile.mkdtemp(prefix='hf-pre-ready-',dir='/var/lib/hyperfide'));guest_root.chmod(0o700)
    node_source = Path(shutil.which('node')).resolve()
    node_bytes = node_source.read_bytes()
    node_pin = sha(node_bytes)

    def setup(f):
        holder['guest'] = guest_root
        f.native_path=guest_root/'hyperfide-native';shutil.copyfile(args.original_native or ROOT/'build/hyperfide-native',f.native_path);f.native_path.chmod(0o500)
        f.node_path = holder['guest'] / 'node'
        f.node_path.write_bytes(node_bytes)
        f.node_path.chmod(0o500)
        holder['handlers'] = NativeArchiveWorkerHandlers([holder['guest']], [f.node_path], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, f.path / 'helper-output', path_resolver=remote)
        secrets, attachments = f.path / 'secrets', f.path / 'attachments'
        secrets.mkdir(mode=0o700)
        attachments.mkdir(mode=0o700)
        credential_file = f.path / 'credentials.json'
        write(credential_file, {'schema_version': 1, 'secret_root': str(secrets), 'attachment_root': str(attachments), 'sources': [], 'targets': []})
        f.profile, f.pool, f.intent, f.sandbox, f.boot = uid(), uid(), uid(), uid(), uid()
        manifest = provider.prepared.Fixture(f.path / 'declared-profile').create()
        manifest['profile']['image']['provider'] = 'blaxel'
        manifest.pop('digest')
        manifest['digest'] = sha(canonical(manifest))
        f.preparation = manifest['digest']
        f.sql("INSERT INTO hyperfide.environment_profiles(organisation_id,id,content_digest,provider,runtime_platform,manifest) VALUES($1,$2,$3,'blaxel','linux-amd64',$4)", [f.ids['organisation'], f.profile, f.preparation, manifest])
        limits = {'SANDBOX': '10', 'PROVISIONING': '10', 'CPU_MILLIS': '100000', 'MEMORY_BYTES': '107374182400', 'DISK_BYTES': '1073741824000'}
        f.config = {'schema_version': 1, 'organisation_id': f.ids['organisation'], 'revision': 'DECLARED_OBSERVER_RECOVERY_COMPONENT', 'accounts': [{'provider': 'blaxel', 'account_key': 'daemon-component-account', 'approved_limits': limits, 'planning_limits': limits}], 'pools': [{'id': f.pool, 'provider': 'blaxel', 'account_key': 'daemon-component-account', 'environment_key': 'daemon-component-workspace', 'region': 'us-pdx-1', 'profile_id': f.profile, 'preparation_digest': f.preparation, 'approved_limits': limits, 'planning_limits': limits, 'create_policy': {'seed_reference': 'DECLARED_NOT_PROVISIONED', 'network': 'ISOLATED', 'stdin_required': False}}], 'maximum_operation_ms': 60000}
        adapter_policy = {'schema_version': 1, 'lifecycle': {'schema_version': 1, 'run_seconds': 3600, 'checkpoint_lead_seconds': 60, 'termination_grace_seconds': 10, 'api_wait_seconds': 5, 'process': {'keep_alive': True, 'timeout_seconds': 0}, 'expiration_policies': [], 'runtime_ttl': None, 'runtime_expires_at': None}, 'network_mode': 'ISOLATED', 'network': {}, 'volumes': [], 'runtime_extra_args': {}, 'runtime_env_refs': {}, 'preparation_seed_reference': 'DECLARED_NOT_PROVISIONED'}
        adapter_file = f.path / 'blaxel-adapter.json'
        write(adapter_file, {'schema_version': 1, 'profiles': [{'routing': {'organisation_id': f.ids['organisation'], 'pool_id': f.pool, 'provider_account_id': 'daemon-component-account', 'environment_id': 'daemon-component-workspace', 'region': 'us-pdx-1'}, 'body': adapter_policy}]})
        f.env['HF_BLAXEL_ADAPTER_CONFIG'] = str(adapter_file)
        f.config['pools'][0]['create_policy']['adapter_policy_digest'] = sha(canonical(adapter_policy))
        pools_file = f.path / 'pools.json'
        write(pools_file, f.config)
        f.recovery_file=f.path/'daemon-recovery.json';write(f.recovery_file,{'schema_version':1,'pools':[]})
        f.bootstrap_file = f.path / 'bootstrap.json'
        write(f.bootstrap_file, {})
        f.bootstrap_state = f.path / 'bootstrap-private'
        f.bootstrap_state.mkdir(mode=0o700)
        f.env.update(HF_PROVIDER_DAEMON_RECOVERY_CONFIG_FILE=str(f.recovery_file),HF_RUNNER_EXECUTOR_CONFIG_FILE=f.env['HF_PROVISIONER_EXECUTOR_CONFIG_FILE'],HF_ARTIFACT_S3_ENDPOINT=objects.endpoint,HF_ARTIFACT_ALLOW_LOOPBACK_HTTP='1',HF_ARTIFACT_S3_REGION=objects_module.REGION,HF_ARTIFACT_S3_BUCKET=objects_module.BUCKET,HF_ARTIFACT_S3_ACCESS_KEY_ID=objects_module.KEY,HF_ARTIFACT_S3_SECRET_ACCESS_KEY=objects_module.SECRET,HF_ARTIFACT_S3_SESSION_TOKEN=objects_module.TOKEN,HF_ARTIFACT_ORGANISATION_ID=f.ids['organisation'],HF_ARTIFACT_ALLOWED_RUN_IDS=json.dumps([f.ids['run']]),HYPERFIDE_PROVISIONER_POLL_MS='100',HYPERFIDE_PROVISIONER_RETRY_MS='200',HYPERFIDE_PROVISIONER_LEASE_MS='3000',HYPERFIDE_POOL_CONFIG=str(pools_file), HF_CREDENTIAL_CONFIG_FILE=str(credential_file), HF_PROVIDER_BOOTSTRAP_CONFIG_FILE=str(f.bootstrap_file), NODE_OPTIONS=(f.env.get('NODE_OPTIONS', '') + ' --import ' + str(ROOT / 'tests/hyperfide/support/source_archive_sdk_transport.mjs')).strip(), HF_SOURCE_ARCHIVE_HTTP_FIXTURE=backend.endpoint, BL_DISABLE_H2='true', BL_DISABLE_CONTROL_PLANE_H2='true', HF_BLAXEL_LIVE_ENABLED='true', HF_BLAXEL_API_KEY='isolated-daemon-transport-no-live-authority', HF_BLAXEL_WORKSPACE='daemon-component-workspace', HF_BLAXEL_ACCOUNT_ID='daemon-component-account')

    f = None
    try:
        f = provider.pools.ProvisionerFixture(extra_components=component_closure(['8.3','10.3','12.4-executor']), extra_setup=setup)
        i = f.ids
        common = [i['organisation'], i['run']]
        stopped = f.invoke('provider.worker.stop', {}, component='8.3', key='provisioner')[1]
        assert stopped.get('ok'), stopped
        pool, account = f.config['pools'][0], f.config['accounts'][0]
        configuration = sha(canonical({'revision': f.config['revision'], 'pool': pool, 'account': account}))
        scope = {'organisation_id': i['organisation'], 'pool_id': f.pool, 'provider': 'blaxel', 'provider_account_id': pool['account_key'], 'environment_id': pool['environment_key'], 'region': pool['region'], 'configuration_digest': configuration}
        operation = {'schema_version': 1, 'kind': 'create', 'scope': scope, 'deadline_at': '2099-01-01T00:00:00.000Z', 'identity': {'operation_id': f.intent, 'idempotency_key': f.intent, 'correlation_id': f.intent, 'causation_id': f.intent, 'payload_digest': sha(b'pending')}, 'resource': None, 'preparation_digest': f.preparation, 'parameters': {'preparation_reference': 'DECLARED_NOT_PROVISIONED', 'resources': {'cpu_millis': 2000, 'memory_bytes': '4294967296', 'disk_bytes': '4294967296', 'persistent_volume_bytes': '0'}, 'network': 'ISOLATED', 'stdin_required': False}}
        normalize = "import fs from'node:fs';import{operationPayloadDigest}from'./core/control-plane/dist/providers/contract.js';const op=JSON.parse(fs.readFileSync(0,'utf8'));op.identity.payload_digest=operationPayloadDigest(op);console.log(JSON.stringify(op));"
        result = subprocess.run(['node', '--input-type=module', '-e', normalize], cwd=ROOT, env=f.env, text=True, input=json.dumps(operation), capture_output=True, timeout=15)
        assert result.returncode == 0, result.stderr
        operation = json.loads(result.stdout)
        native = 'hf-' + sha(canonical({'scope': scope, 'operation_id': f.intent, 'generation': '1'}))[7:47]
        f.sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region,profile_id) VALUES($1,$2,'blaxel',$3,$4,$5,$6)", [i['organisation'], f.pool, pool['account_key'], pool['environment_key'], pool['region'], f.profile])
        f.sql('INSERT INTO hyperfide.provider_pool_configurations(organisation_id,pool_id,configuration_digest,document) VALUES($1,$2,$3,$4)', [i['organisation'], f.pool, configuration, json.dumps({'scope': scope, 'pool': pool, 'account': account})])
        f.sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,$4,'RUNNING',$5)", [i['organisation'], f.sandbox, f.pool, native, f.preparation])
        f.boot = f.sql('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2', [i['organisation'], f.sandbox])[0]['boot_id']
        f.sql("INSERT INTO hyperfide.provisioning_intents(organisation_id,run_id,id,pool_id,sandbox_id,configuration_digest,kind,preparation_purpose,profile_id,request_key,request_digest,payload_digest,operation,state,native_sandbox_id,boot_generation) VALUES($1,$2,$3,$4,$5,$6,'CREATE','PREPARATION',$7,$8,$9,$10,$11,'ACKNOWLEDGED',$12,1)", common + [f.intent, f.pool, f.sandbox, configuration, f.profile, f.intent, sha(b'controlled prior create'), operation['identity']['payload_digest'], json.dumps(operation), native])
        binding = {'organisation_id':i['organisation'],'run_id':i['run'],'provisioning_intent_id':f.intent,'sandbox_id':f.sandbox,'native_sandbox_id':native,'boot_id':f.boot,'boot_generation':'1','configuration_digest':configuration,'profile_id':f.profile,'preparation_digest':f.preparation}
        remote_manifest=str(guest_root/'manifest.json');state_root=str(guest_root/'state');boot_root=state_root+'/'+f.sandbox+'/'+f.boot
        native_data=f.native_path.read_bytes();native_pin=sha(native_data)
        def upload_native(data):
            chunks=[]
            for offset in range(0,len(data),196608):
                part=data[offset:offset+196608]
                value={'organisation_id':i['organisation'],'run_id':i['run'],'digest':sha(part),'size_bytes':str(len(part)),'data_base64':base64.b64encode(part).decode(),'retention_class':'RUN','retention_until':None,'retention_hold':False}
                operation=f.operation('15.2','artifact.object.put',value)
                stored=f.request(operation,key='operator')[1];assert stored.get('ok'),{'operation':operation,'response':stored}
                chunks.append({'sequence':len(chunks),'artifact_id':stored['result']['artifact']['artifact_id'],'digest':sha(part),'size_bytes':str(len(part)),'offset_bytes':str(offset)})
            committed=f.invoke('artifact.manifest.commit',{'organisation_id':i['organisation'],'run_id':i['run'],'expected_chunks':len(chunks),'total_size_bytes':str(len(data)),'content_digest':sha(data),'complete':True,'truncated':False,'missing_ranges':[],'chunks':chunks,'retention_class':'RUN','retention_until':None,'retention_hold':False},component='15.2',key='operator')[1]
            assert committed.get('ok'),committed
            return committed['result']['artifact']
        artifact=upload_native(native_data)
        slots=[{'name':name,'kind':kind,'uid':owner,'gid':owner,'credential_sensitive':False,'isolation_profile':'distinct_uid'} for name,kind,owner in [('preparer','PREPARATION',64021),('worker','AGENT',64022)]]
        template={'origin':f.origin,'ca_file':str(f.ca),'state_root':state_root,'runner_binary':str(f.native_path),'runner_binary_digest':native_pin,'controller':{'node_path':str(f.node_path),'node_digest':node_pin},'files':[{'path':str(f.node_path),'digest':node_pin},{'path':str(f.native_path),'digest':native_pin}],'slots':slots}
        grant=stable('grant:'+f.intent);enrollment=uid();token=os.urandom(32);verifier=sha(token)
        recipe={'pool_id':f.pool,'configuration_digest':configuration,'profile_id':f.profile,'preparation_digest':f.preparation,'native_path':str(f.native_path),'native_digest':native_pin,'manifest_path':remote_manifest,'secret_path':state_root+'/{sandbox_id}/{boot_id}/enrollment-grant.json','files':[{'artifact_id':artifact['artifact_id'],'storage_kind':'manifest','manifest_digest':artifact['digest'],'digest':native_pin,'size_bytes':str(len(native_data)),'target':str(f.native_path),'mode':'0500'}],'allowed_actions':['identity.describe','identity.runner.register','identity.runner.heartbeat'],'grant_ttl_seconds':300,'native_template':template,'install_template':{}}
        write(f.bootstrap_file,{'schema_version':1,'origin':f.origin,'ca_file':str(f.ca),'state_root':str(f.bootstrap_state),'pools':[recipe]})
        descriptor={**recipe,'origin':f.origin,'ca_file':str(f.ca)}
        resolved=copy.deepcopy(template)
        for slot in resolved['slots']:
            slot['slot_id']=stable('slot:'+f.intent+':'+slot['name']);slot['session_id']=stable('session:'+f.intent+':'+slot['name'])
        manifest={'schema_version':1,'kind':'FLEET_NATIVE_BOOTSTRAP_V1','bootstrap_id':f.intent,'binding':binding,'enrollment':{'grant_id':grant,'secret_file':recipe['secret_path'].replace('{sandbox_id}',f.sandbox).replace('{boot_id}',f.boot),'operation_id':enrollment,'idempotency_key':enrollment,'allowed_actions':recipe['allowed_actions']},'template':resolved}
        write(remote(remote_manifest),manifest);manifest_pin=sha(remote(remote_manifest).read_bytes())
        secret_ref=f.bootstrap_state/(f.intent+'.enrollment.json');write(secret_ref,{'grant_id':grant,'secret_b64':base64.urlsafe_b64encode(token).rstrip(b'=').decode()})
        i.update(intent=f.intent,sandbox=f.sandbox,boot=f.boot,pool=f.pool)
        def ok(action,value,component='14.1',key='provisioner',**kwargs):
            result=f.invoke(action,value,component=component,key=key,**kwargs)[1];assert result.get('ok'),result;return result['result']
        version=f.sql('SELECT state_version::text FROM hyperfide.sandboxes WHERE id=$1',[f.sandbox])[0]['state_version']
        ok('identity.binding.observe',{'provisioning_intent_id':f.intent,'sandbox_id':f.sandbox,'boot_generation':'1','boot_id':f.boot,'native_sandbox_id':native,'observation_digest':sha(b'CONTROLLED_PRIOR_PROVIDER_BINDING'),'expected_version':version})
        ok('identity.grant.issue',{'grant_id':grant,'provisioning_intent_id':f.intent,'verifier':verifier,'allowed_actions':recipe['allowed_actions'],'ttl_seconds':300})
        f.secret=token;f.grant=grant
        enrolled=f.request(f.enrollment(),key='runner',endpoint='/v1/enroll',credential=grant)[1];assert enrolled.get('ok'),enrolled
        credential=enrolled['result']['credential_id'];i['runner']=credential
        daemon_root=Path(boot_root)/'daemon';daemon_root.mkdir(parents=True,mode=0o700)
        registration=Path(boot_root)/'registration.json';write(registration,{'preparation_digest':f.preparation,'inventory':[]})
        transport=Path(boot_root)/'transport.json';write(transport,{'origin':f.origin,'ca_file':str(f.ca),'key_path':str(f.keys['runner']['path']),'credential_id':credential,'timeout_ms':2000})
        daemon_config=Path(boot_root)/'daemon.json';write(daemon_config,{'transport_config':str(transport),'state_dir':str(daemon_root),'organisation_id':i['organisation'],'run_id':i['run'],'sandbox_id':f.sandbox,'boot_id':f.boot,'boot_generation':'1','runner_registration_path':str(registration),'preparation_digest':f.preparation,'heartbeat_interval_ms':1000})
        sleeper=subprocess.Popen([str(f.native_path),'--component','12.1','--action','supervisor.serve'],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,start_new_session=True)
        sleeper.stdin.write(json.dumps({'config_path':str(daemon_config)}).encode());sleeper.stdin.close();holder['daemon']=sleeper
        until=time.monotonic()+15
        while time.monotonic()<until:
            if (daemon_root/'daemon-state.json').exists() and json.loads((daemon_root/'daemon-state.json').read_text()).get('registered'):break
            if sleeper.poll() is not None:raise AssertionError(sleeper.stderr.read().decode())
            time.sleep(.05)
        else:raise AssertionError('Actualnative signed registration didnotcomplete')
        os.kill(sleeper.pid,signal.SIGSTOP);time.sleep(.3)
        stat=Path('/proc/'+str(sleeper.pid)+'/stat').read_text().rsplit(')',1)[1].split();previous={'pid':sleeper.pid,'pgid':int(stat[2]),'start_time':stat[19],'os_boot_id':Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
        for slot in resolved['slots']:
            f.sql("INSERT INTO hyperfide.worker_slots(organisation_id,id,sandbox_id,slot_key,boot_generation,capacity_kind,state) VALUES($1,$2,$3,$4,1,$5,'READY')",[i['organisation'],slot['slot_id'],f.sandbox,slot['name'],slot['kind']])
            root=guest_root/slot['name'];root.mkdir(mode=0o700)
            f.sql("INSERT INTO hyperfide.runner_registry(organisation_id,run_id,session_id,credential_id,sandbox_id,boot_generation,boot_id,slot_id,state_dir,runner_binary,workspace_path,home_path,tmp_path,runner_binary_digest,boot_preparation_digest,preparation_digest,slot_generation,uid,gid,observation_digest,state) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,1,$15,$16,$13,'PREPARING')",common+[slot['session_id'],credential,f.sandbox,f.boot,slot['slot_id'],str(root/'state'),str(f.native_path),str(root/'source'),str(root/'home'),str(root/'tmp'),native_pin,f.preparation,slot['uid'],slot['gid']])
        # Controlled historical completion/slot metadata is INPUT; never native bootstrap qualification.
        receipt={'schema_version':1,'kind':'FLEET_NATIVE_BOOTSTRAP_RECEIPT_V1','state':'REGISTERED','bootstrap_id':f.intent,'manifest_digest':manifest_pin,'credential_id':credential,'binding':binding,'daemon':previous,'slots':[{**slot,'slot_generation':'1'} for slot in resolved['slots']],'component_prerequisite_only':True}
        receipt_file=Path(boot_root)/'bootstrap-receipt.json';write(receipt_file,receipt)
        encoded=base64.urlsafe_b64encode(json.dumps({'manifest_path':remote_manifest,'manifest_digest':manifest_pin},separators=(',',':')).encode()).decode().rstrip('=')
        process_id='hf-bootstrap-'+f.intent
        holder['original_process']={'name':process_id,'command':"'"+str(f.native_path)+"' --component 12.1 --action supervisor.bootstrap --request-base64 '"+encoded+"'",'status':'completed','exitCode':0,'provenance':'CONTROLLED_HISTORICAL_COMPLETION_INPUT'}
        f.sql("INSERT INTO hyperfide.provider_native_bootstraps(organisation_id,run_id,intent_id,id,pool_id,sandbox_id,boot_id,boot_generation,native_sandbox_id,configuration_digest,profile_id,preparation_digest,descriptor_digest,descriptor,grant_id,binding_operation_id,grant_operation_id,enrollment_operation_id,secret_ref,verifier,process_id,state,manifest,manifest_digest) VALUES($1,$2,$3,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'OBSERVING',$20,$21)",common+[f.intent,f.pool,f.sandbox,f.boot,native,configuration,f.profile,f.preparation,sha(canonical(descriptor)),descriptor,grant,uid(),uid(),enrollment,str(secret_ref),verifier,process_id,manifest,manifest_pin])
        # Negative staleness fault only; fresh positive evidence must be a real signed native heartbeat.
        f.sql("UPDATE hyperfide.identity_runner_status SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE credential_id=$1",[credential])
        stale=f.sql('SELECT state_version::text,heartbeat_at::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[credential])[0]
        backend.metadata = {'metadata': {'name': native, 'workspace': scope['environment_id'], 'labels': {'hyperfide-operation': f.intent, 'hyperfide-payload': operation['identity']['payload_digest'], 'hyperfide-scope': sha(canonical(scope)), 'hyperfide-boot': '1', 'hyperfide-preparation': f.preparation}}, 'spec': {'region': scope['region'], 'runtime': {'expires': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(time.time()+300))}}, 'status': 'DEPLOYED'}
        prior_actor = uid()
        f.sql("INSERT INTO hyperfide.agent_sessions(organisation_id,run_id,id,role,connector,account_key,native_session_id) VALUES($1,$2,$3,'LEADER','fixture','fixture','controlled-prior-manager')", common + [prior_actor])
        observation, reasoning, decision, selection = [uid() for _ in range(4)]
        controlled = {'controlled_component_prerequisite': True}
        f.sql('INSERT INTO hyperfide.fleet_observations(organisation_id,run_id,id,actor_id,cohort_generation,context_digest,body) VALUES($1,$2,$3,$4,1,$5,$6)', common + [observation, prior_actor, sha(b'controlled prior selection'), controlled])
        f.sql("INSERT INTO hyperfide.fleet_reasoning(organisation_id,run_id,id,actor_id,request_digest,observation_id,state,result) VALUES($1,$2,$3,$4,$5,$6,'COMPLETED',$7)", common + [reasoning, prior_actor, sha(b'controlled prior selection'), observation, controlled])
        f.sql("INSERT INTO hyperfide.fleet_decisions(organisation_id,run_id,id,operation_id,actor_id,action,context_digest,payload_digest,reasoning_id,body) VALUES($1,$2,$3,$4,$5,'PROVISION_SANDBOX',$6,$6,$7,$8)", common + [decision, selection, prior_actor, sha(b'controlled prior selection'), reasoning, controlled])
        f.sql('INSERT INTO hyperfide.fleet_effect_receipts(organisation_id,run_id,operation_id,decision_id,payload_digest,result) VALUES($1,$2,$3,$4,$5,$6)', common + [selection, decision, sha(b'controlled prior selection'), {'kind': 'PROVISION_SANDBOX', 'provider_intent_id': f.intent, 'sandbox_id': f.sandbox, **controlled}])

        def api(operation=None):
            if operation:
                return f.request(operation, key='provisioner', timeout_seconds=45)[1]
            return f.invoke('provider.intents.reconcile', {'intent_id': f.intent}, component='8.3', key='provisioner', timeout_seconds=45)[1]

        def journals():
            return f.sql("SELECT id::text,state,state_version::text,result,request_digest FROM hyperfide.command_inbox WHERE organisation_id=$1 AND run_id=$2 AND operation='provider.bootstrap.keepalive' ORDER BY id", common)

        def row():return f.sql('SELECT state,last_error,receipt,receipt_digest FROM hyperfide.provider_native_bootstraps WHERE intent_id=$1',[f.intent])[0]
        def run_until(predicate,seconds=15):
            ok('provider.worker.start',{},component='8.3');until=time.monotonic()+seconds
            try:
                while time.monotonic()<until:
                    if predicate():return
                    time.sleep(.1)
                raise AssertionError({'row':row(),'journals':journals(),'worker':ok('provider.worker.status',{},component='8.3'),'sdk':backend.requests[-12:]})
            finally:ok('provider.worker.stop',{},component='8.3')
        if args.recover_authority:
            assert args.original_native and args.recovery_helper,'Explicit original native and distinct recovery helper are required'
            from pre_ready_recovery_case import run_recovery_case
            run_recovery_case({**locals(),'recovery_helper':args.recovery_helper});return
        errors=[]
        for kind,code in [('credential','PROVIDER_BOOTSTRAP_ENROLLMENT'),('slot','PROVIDER_BOOTSTRAP_SLOT')]:
            bad=copy.deepcopy(receipt)
            if kind=='credential':bad['credential_id']=uid()
            else:bad['slots'][0]['uid']+=1
            write(receipt_file,bad)
            run_until(lambda:row()['last_error']==code)
            assert row()['state']=='OBSERVING' and row()['receipt'] is None and journals()==[] and submissions==[],row()
            errors.append(code)
        write(receipt_file,receipt)
        if args.dead_only:
            os.kill(sleeper.pid,signal.SIGKILL);sleeper.wait(timeout=5)
            run_until(lambda:len(journals())>0)
            assert row()['state']=='OBSERVING' and row()['receipt'] is None and f.sql('SELECT state_version::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[credential])[0]['state_version']==stale['state_version']
            print(json.dumps({'status':'PASS','scope':'preREADY dead existing daemon refuses readiness; actualSDK/PG, historical completion input only','row':row(),'journals':journals(),'errors':errors,'daemon_restart_count':0}));return
        run_until(lambda:len(journals())==1 and row()['last_error']=='PROVIDER_BOOTSTRAP_ENROLLMENT')
        assert row()['state']=='OBSERVING' and row()['receipt'] is None and len(submissions)==1,row()
        no_heartbeat={'row':row(),'journal':journals(),'version':stale['state_version']}
        holder['wake']=True
        run_until(lambda:row()['state']=='READY',seconds=20)
        current=f.sql('SELECT state_version::text,heartbeat_at::text FROM hyperfide.identity_runner_status WHERE credential_id=$1',[credential])[0]
        assert int(current['state_version'])>int(stale['state_version']) and len(submissions)==1 and sleeper.poll() is None,(current,submissions)
        stat=Path('/proc/'+str(sleeper.pid)+'/stat').read_text().rsplit(')',1)[1].split()
        assert stat[19]==previous['start_time'] and int(stat[2])==previous['pgid']
        assert receipt_file.read_bytes()==canonical(receipt) and row()['receipt_digest']==sha(canonical(receipt))
        print(json.dumps({'status':'PASS','scope':'actualSDK keeper wake and existing native signedheartbeat settle productionpreREADY coordinator; historical completion and slotinventory are prerequisiteinputs, no fullnativebootstrap/cloud qualification','no_heartbeat':no_heartbeat,'fresh_native_heartbeat':current,'row':row(),'journals':journals(),'submissions':submissions,'negative_errors':errors,'daemon_restart_count':0,'original_daemon':previous}))
    finally:
        release_reply.set()
        if sleeper and sleeper.poll() is None:
            os.kill(sleeper.pid,signal.SIGCONT);sleeper.terminate();sleeper.wait(timeout=5)
        if f:
            try:holder['handlers'].close()
            finally:f.close()
        objects.stop();backend.close()
        if guest_root.exists():shutil.rmtree(guest_root)


if __name__=='__main__':main()
