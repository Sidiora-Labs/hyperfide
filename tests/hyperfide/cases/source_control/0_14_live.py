#!/usr/bin/env python3
"""Explicit real-provider prerequisite journey; no fixture grants or readiness rows.

All remote mutations use the production signed API. Input bundles are protected,
real artifacts. Missing native allocations/producers stop the journey with a
concrete capability error. Database migrations remain a separate reviewed job.
"""
from pathlib import Path
import argparse
import base64
import datetime
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]
AREA = ROOT / 'build/fleet/integration/private'
NODE = Path('/root/.nvm/versions/node/v24.22.0/bin/node')
BRIDGE = AREA / '0_14-api.mjs'
CHUNK = 240 * 1024


# Inventory only: these require the actual provider journey and remain UNRUN.
FUTURE_PROVIDER_ASSERTIONS = [
    {'id':'credential-bearing-start','status':'UNRUN',
     'migration':'core/control-plane/migrations/0718-fleet-worker-launches.sql',
     'oracle':'A committed native_launch_plans START binds the actual runner, command, launch, native profile lookup and approved credential env_refs; no secret values enter evidence.'},
    {'id':'one-pinned-input-digest','status':'UNRUN',
     'oracle':'The committed START, immutable fleet_worker_launches request and actual native lookup bind one identical pinned input digest.'},
    {'id':'actual-terminal-native-evidence','status':'UNRUN',
     'oracle':'Actual terminal native execution evidence binds the same command/launch/runner, result digest and signature; no asserted completion substitutes for execution.'},
    {'id':'no-second-uncertain-execution','status':'UNRUN',
     'oracle':'Replaying a CLAIMED or UNKNOWN command performs no second native execution; only positive reconciliation of the original execution may advance it.'},
]

class Blocked(RuntimeError):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()

def digest(value):
    return 'sha256:' + hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()

def read(path):
    p = Path(path)
    st = p.lstat()
    if not p.is_file() or p.is_symlink() or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise Blocked('PRIVATE_INPUT_REQUIRED:' + p.name)
    return json.loads(p.read_text())

def write(path, value):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = p.with_name(p.name + '.' + uuid.uuid4().hex)
    with temporary.open('x') as f:
        temporary.chmod(0o600)
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    temporary.replace(p)

def environment(config):
    # Dotenv parsing stays in Node. Captured values never enter command arguments/logs.
    script = "console.log(JSON.stringify(process.env))"
    result = subprocess.run([str(NODE), '--env-file=' + str(ROOT / '.env'), '--import',
        str(ROOT / 'deploy/hyperfide/fleet-env.mjs'), '-e', script],
        capture_output=True, text=True, check=True)
    env = json.loads(result.stdout)
    env.update({k:str(v) for k,v in config.get('environment', {}).items()})
    env['PATH'] = str(NODE.parent) + ':' + env.get('PATH', '/usr/bin:/bin')
    return env

def component_for(action):
    found = []
    for p in (ROOT / 'core/control-plane/components').glob('*.json'):
        if p.name == 'schema.json':
            continue
        document = json.loads(p.read_text())
        if action in document.get('actions', []):
            found.append(document['id'])
    if len(found) != 1:
        raise Blocked('OFFICIAL_ACTION_UNAVAILABLE:' + action)
    return found[0]

class Journey:
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve()
        self.config = read(self.config_path)
        self.bindings = read(AREA / '0_14-bindings.json')
        self.env = environment(self.config)
        self.journal_path = AREA / '0_14-live-journal.json'
        self.journal = read(self.journal_path) if self.journal_path.exists() else {'schema_version':1,'steps':{},'processes':{}}
        self.credential = self.config.get('operator_credential_file', str(AREA / 'operator.json'))
        self.results = {}

    def invoke(self, name, action, payload, credential=None):
        credential = credential or self.credential
        principal = read(credential)
        if principal['run_id'] != self.bindings['run_id'] or principal['organisation_id'] != self.bindings['organisation_id']:
            raise Blocked('CREDENTIAL_SCOPE_MISMATCH')
        component = component_for(action)
        request_digest = digest({'component':component,'action':action,'input':payload,
            'credential_id':principal['credential_id']})
        old = self.journal['steps'].get(name)
        if old and old['request_digest'] != request_digest:
            raise Blocked('EXACT_OPERATION_INPUT_CHANGED:' + name)
        record = old or {'operation_id':str(uuid.uuid4()),'request_digest':request_digest,'action':action,'state':'PREPARED'}
        if record['state'] == 'SUCCEEDED':
            return read(AREA / record['result_file'])['body']['result']
        self.journal['steps'][name] = record
        write(self.journal_path, self.journal)
        packet = {'origin':self.config['origin'],'ca_file':self.config.get('ca_file'),
            'credential_file':credential,'component':component,'action':action,'input':payload,
            'operation_id':record['operation_id']}
        try:
            response = subprocess.run([str(NODE),str(BRIDGE)], input=json.dumps(packet), cwd=AREA,
                env=self.env, capture_output=True, text=True, timeout=135)
        except subprocess.TimeoutExpired:
            record['state']='UNKNOWN'
            write(self.journal_path,self.journal)
            raise Blocked('EXACT_OPERATION_RECONCILIATION_REQUIRED:' + name)
        try:
            result = json.loads(response.stdout)
        except Exception:
            result = {'transport':'UNKNOWN','code':'RPC_RESPONSE_UNCONFIRMED'}
        output = 'responses/' + hashlib.sha256(name.encode()).hexdigest() + '.json'
        write(AREA / output, result)
        record['result_file'] = output
        body = result.get('body', {})
        if response.returncode or result.get('transport') == 'UNKNOWN':
            record['state'] = 'UNKNOWN'
            write(self.journal_path, self.journal)
            raise Blocked('EXACT_OPERATION_RECONCILIATION_REQUIRED:' + name)
        if body.get('operation_id') != record['operation_id'] or body.get('protocol_version') != 1:
            record['state'] = 'UNKNOWN'
            write(self.journal_path, self.journal)
            raise Blocked('RPC_BINDING_MISMATCH:' + name)
        if body.get('ok') is not True:
            record['state'] = 'REFUSED'
            record['error_code'] = body.get('error', {}).get('code', 'RPC_REFUSED')
            write(self.journal_path, self.journal)
            raise Blocked(record['error_code'] + ':' + name)
        record['state'] = 'SUCCEEDED'
        write(self.journal_path, self.journal)
        return body['result']

    def upload(self, role, filename):
        data = Path(filename).read_bytes()
        content = digest(data)
        scope = {k:self.bindings[k] for k in ['organisation_id','run_id']}
        retention = {'retention_class':'RUN','retention_until':None,'retention_hold':False}
        chunks = []
        pieces = [data[i:i+CHUNK] for i in range(0,len(data),CHUNK)] or [b'']
        if len(pieces) > 4096:
            raise Blocked('ARTIFACT_CHUNK_BOUND_EXCEEDED:' + role)
        offset = 0
        for index, piece in enumerate(pieces):
            result = self.invoke('artifact:' + role + ':' + content + ':' + str(index), 'artifact.object.put',
                {**scope,**retention,'digest':digest(piece),'size_bytes':str(len(piece)),
                 'data_base64':base64.b64encode(piece).decode()})
            if result.get('outcome') != 'SUCCEEDED' or result.get('availability') != 'VERIFIED' or result.get('artifact',{}).get('status') != 'COMPLETE':
                raise Blocked('ACTUAL_ARTIFACT_NOT_VERIFIED:' + role)
            artifact = result['artifact']
            chunks.append({'sequence':index,'artifact_id':artifact['artifact_id'],'digest':digest(piece),
                'size_bytes':str(len(piece)),'offset_bytes':str(offset)})
            offset += len(piece)
        if len(pieces) == 1:
            reference = {'role':role,'artifact_id':chunks[0]['artifact_id'],'storage_kind':'object',
                'digest':content,'size_bytes':str(len(data))}
        else:
            result = self.invoke('manifest:' + role + ':' + content,'artifact.manifest.commit',
                {**scope,**retention,'expected_chunks':len(chunks),'total_size_bytes':str(len(data)),
                 'content_digest':content,'complete':True,'truncated':False,'missing_ranges':[],'chunks':chunks})
            if result.get('outcome') != 'SUCCEEDED' or result.get('availability') != 'VERIFIED':
                raise Blocked('ACTUAL_MANIFEST_NOT_VERIFIED:' + role)
            reference = {'role':role,'artifact_id':result['artifact']['artifact_id'],'storage_kind':'manifest',
                'manifest_digest':result['manifest_digest'],'digest':content,'size_bytes':str(len(data))}
        return reference

    def readiness_artifact(self):
        filename=AREA/'readiness-context-input.json'
        declaration=read(filename)
        if declaration.get('authority')!='RELEASE_PINS_ONLY' or declaration.get('runtime_ready') is not False:
            raise Blocked('RELEASE_PINS_ONLY_INPUT_REQUIRED')
        reference=self.upload('readiness-context',filename)
        if reference['storage_kind']!='object':
            raise Blocked('COMPACT_READINESS_CONTEXT_REQUIRED')
        inspected=self.invoke('readiness-context-inspect','artifact.object.inspect',{
            'organisation_id':self.bindings['organisation_id'],'run_id':self.bindings['run_id'],
            'artifact_id':reference['artifact_id']})
        artifact=inspected.get('artifact',{})
        if inspected.get('availability')!='VERIFIED' or artifact.get('status')!='COMPLETE' or artifact.get('digest')!=reference['digest']:
            raise Blocked('ACTUAL_READINESS_INPUT_ARTIFACT_NOT_VERIFIED')
        result={key:artifact[key] for key in ['artifact_id','digest','size_bytes','status']}
        result['availability']=inspected['availability']
        write(AREA/'readiness-context-artifact.json',result)
        return {'status':'ARTIFACT_VERIFIED','runtime_ready':False,'artifact_file':str(AREA/'readiness-context-artifact.json')}

    def artifacts(self):
        inputs = self.config.get('artifacts')
        if not isinstance(inputs, dict) or not inputs:
            raise Blocked('ACTUAL_ARTIFACT_INPUTS_REQUIRED')
        refs = [self.upload(role, filename) for role, filename in sorted(inputs.items())]
        write(AREA / '0_14-staging-references.json',refs)
        return {'status':'UPLOADED_VERIFIED','count':len(refs)}

    def environment_register(self):
        payload = read(self.config['registration_input_file'])
        registered = self.invoke('environment-register','fleet.install.register',payload)
        write(AREA / '0_14-environment-registration.json',registered)
        return {'status':'ACTUAL_ENVIRONMENT_INPUT_REGISTERED','result':registered,
                'runtime_ready':False}

    def registration(self):
        payload = read(self.config['registration_input_file'])
        registered = self.invoke('environment-register','fleet.install.register',payload)
        write(AREA / '0_14-environment-registration.json',registered)
        delivery = read(self.config['delivery_input_file'])
        delivery['input_digest'] = registered['input_digest']
        delivery['staging'] = read(AREA / '0_14-staging-references.json')
        result = self.invoke('delivery-register','fleet.install.delivery.register',delivery)
        write(AREA / '0_14-delivery-registration.json',result)
        return {'status':'REGISTERED','readiness':'NOT_CLAIMED'}

    def trust(self):
        script = r"""
const tls=require('node:tls'),crypto=require('node:crypto');
const origin=new URL(process.argv[1]);if(origin.protocol!=='https:')throw Error('HTTPS_REQUIRED');
const socket=tls.connect({host:origin.hostname,port:Number(origin.port||443),servername:origin.hostname,rejectUnauthorized:true,minVersion:'TLSv1.3'},()=>{
 if(!socket.authorized)throw Error('PUBLIC_TLS_NOT_VERIFIED');let c=socket.getPeerCertificate(true),seen=new Set(),pem='';
 while(c&&c.raw){const id=crypto.createHash('sha256').update(c.raw).digest('hex');if(seen.has(id))break;seen.add(id);pem+=new crypto.X509Certificate(c.raw).toString()+'\n';c=c.issuerCertificate;if(seen.size>16)throw Error('TLS_CHAIN_LIMIT');}
 if(!pem||Buffer.byteLength(pem)>65536)throw Error('TLS_CHAIN_LIMIT');console.log(JSON.stringify({pem,certificates:seen.size,verified:true}));socket.end();
});socket.setTimeout(10000,()=>socket.destroy(Error('TLS_TIMEOUT')));socket.on('error',()=>{console.error('PUBLIC_TLS_UNAVAILABLE');process.exitCode=2;});
"""
        result=subprocess.run([str(NODE),'-e',script,self.config['origin']],capture_output=True,text=True,timeout=15)
        if result.returncode:
            raise Blocked('PUBLIC_CONTROL_TLS_UNAVAILABLE')
        data=json.loads(result.stdout)
        filename=AREA/'control-public-ca.pem'
        filename.write_text(data['pem']);filename.chmod(0o600)
        self.config['supervisor_ca_file']=str(filename)
        write(self.config_path,self.config)
        return {'status':'PUBLIC_TLS_CHAIN_VERIFIED','certificates':data['certificates'],'ca_file':str(filename)}

    def activate_run(self):
        run = self.bindings['run_id']
        pins = self.invoke('accepted-spec-inspect','spec.inspect',{'run_id':run})
        request = {'run_id':run,'spec_revision_id':pins['spec_revision_id'],
            'spec_generation':pins['spec_generation'],'state_version':pins['state_version']}
        checked = self.invoke('dependencies-check','spec.dependencies.check',request)
        if checked.get('status') != 'STRUCTURALLY_VALID':
            raise Blocked('ACTUAL_DEPENDENCY_ADMISSION_NOT_VALID')
        admitted = self.invoke('dependencies-admit','spec.dependencies.admit',request)
        if admitted.get('admitted') is not True:
            raise Blocked('ACTUAL_DEPENDENCY_ADMISSION_REQUIRED')
        principal=read(self.credential)
        result=self.invoke('initial-run-start','recovery.control.start',{
            'scope':{'organisation_id':self.bindings['organisation_id'],'run_id':run,
                     'authority_epoch':principal['authority_epoch']},
            'operation_id':str(uuid.uuid5(uuid.UUID(self.bindings['activation_operation_id']),'initial-start')),
            'spec_revision_id':pins['spec_revision_id'],'spec_generation':pins['spec_generation'],
            'expected_state_version':admitted['state_version'],'reason':'Execute the accepted isolated fleet prerequisite'})
        write(AREA/'0_14-run-start.json',result)
        return {'status':'ACTUAL_START_ADMITTED','result':result}

    def sessions(self):
        import base64
        ids=read(AREA/'0_14-principals.json');scope=self.bindings
        def public(name):
            raw=subprocess.check_output(['openssl','pkey','-in',str(AREA/(name+'.pem')),
                '-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
            return base64.urlsafe_b64encode(raw[-32:]).decode().rstrip('=')
        profile=self.config.get('gateway_profile_id','configured-primary')
        self.invoke('register-primary','hierarchy.supervisor.register',{
            'idempotency_key':'014-register-primary','expected_leader_generation':'0',
            'session_id':ids['primary_session_id'],'role':'LEADER','connector':'gateway','account_key':profile})
        coordinator=self.invoke('issue-coordinator','identity.service.issue',{
            'credential_id':ids['coordinator_credential_id'],'actor_id':ids['coordinator_actor_id'],
            'role':'COORDINATOR','public_key_b64':public('coordinator'),
            'allowed_actions':['hierarchy.supervisor.register'],'ttl_seconds':3600})
        operator=read(self.credential)
        coordinator_file=AREA/'coordinator.json'
        write(coordinator_file,{'schema_version':1,'credential_id':coordinator['credential_id'],
            'actor_id':ids['coordinator_actor_id'],'organisation_id':scope['organisation_id'],
            'run_id':scope['run_id'],'role':'COORDINATOR','authority_epoch':operator['authority_epoch'],
            'key_file':str(AREA/'coordinator.pem')})
        host=self.env['HYPERFIDE_FLEET_HOST_ID']
        actions=['hierarchy.leader.acquire','hierarchy.package.configure','fleet.cohort.bind',
            'fleet.session.bind','fleet.observe','fleet.session.reason','fleet.decision.inspect',
            'fleet.decision.apply','spec.amendment.admit']
        granted=self.invoke('bootstrap-primary-running','fleet.identity.bootstrap',{
            'session_id':ids['primary_session_id'],'public_key_b64':public('primary'),
            'allowed_actions':actions,'ttl_seconds':900,'authority_epoch':operator['authority_epoch'],
            'leader_generation':'0','delegation_id':None,'manager_generation':None,
            'host_id':host,'cohort_id':ids['cohort_id'],'cohort_generation':'0'})
        primary_file=AREA/'primary.json'
        write(primary_file,{'schema_version':1,'credential_id':granted['credential_id'],
            'actor_id':ids['primary_session_id'],'organisation_id':scope['organisation_id'],
            'run_id':scope['run_id'],'role':'LEADER','authority_epoch':operator['authority_epoch'],
            'key_file':str(AREA/'primary.pem'),'expires_at':granted['expires_at'],'cohort_generation':'0'})
        acquired=self.invoke('primary-acquire','hierarchy.leader.acquire',{
            'idempotency_key':'014-primary-acquire','expected_generation':'0',
            'reason':'Acquire actual configured gateway Primary'},str(primary_file))
        if acquired.get('leader_generation') != '1':
            raise Blocked('ACTUAL_INITIAL_LEADER_GENERATION_REQUIRED')
        for name,session in [('manager-one',ids['manager_one_session_id']),('manager-two',ids['manager_two_session_id'])]:
            self.invoke('register-'+name,'hierarchy.supervisor.register',{
                'idempotency_key':'014-'+name,'expected_leader_generation':'1','session_id':session,
                'role':'FEATURE_MANAGER','connector':'gateway','account_key':profile},str(coordinator_file))
        supervisor={'schema_version':1,'origin':self.config['origin'],'ca_file':self.config.get('supervisor_ca_file','/etc/ssl/certs/ca-certificates.crt'),
            'organisation_id':scope['organisation_id'],'run_id':scope['run_id'],'cohort_id':ids['cohort_id'],
            'host_id':host,'leader_generation':'1','expected_cohort_generation':'0',
            'primary':{'session_id':ids['primary_session_id'],'credential_file':str(primary_file),'key_file':str(AREA/'primary.pem')},
            'managers':[{'session_id':session,'credential_file':str(AREA/(name+'.json')),'key_file':str(AREA/(name+'.pem'))}
                for name,session in [('manager-one',ids['manager_one_session_id']),('manager-two',ids['manager_two_session_id'])]],
            'bootstrap':{'operator_credential_file':self.credential,'ttl_seconds':900},
            'state_directory':str(AREA/'supervisor-state'),'poll_interval_ms':1000,'request_timeout_ms':120000}
        write(AREA/'supervisor.json',supervisor)
        self.config['supervisor_config_file']=str(AREA/'supervisor.json')
        write(self.config_path,self.config)
        return {'status':'ACTUAL_LOGICAL_SESSIONS_REGISTERED','model_observed':False,
                'configuration':'MODEL_CONFIGURE_WAVE_AND_DELEGATE_REQUIRED'}

    def profile(self):
        manifest=read(self.config['preparation_manifest_file'])
        ids=read(AREA/'0_14-pool-identities.json')
        payload={'profile_id':ids['profile_id'],'runtime_platform':'linux-amd64','manifest':manifest}
        result=self.invoke('profile-declare','provider.profiles.register',payload)
        if result.get('state')!='DECLARED' or result.get('qualified') is not False or result.get('ready') is not False:
            raise Blocked('DECLARATION_CANNOT_ASSERT_PHYSICAL_READINESS')
        repeated=self.invoke('profile-declare-repeat','provider.profiles.register',payload)
        write(AREA/'0_14-profile-declaration.json',{'first':result,'repeat':repeated})
        return {'status':'DECLARED','qualified':False,'ready':False}

    def steps(self, phase):
        filename = self.config.get(phase + '_requests_file')
        if not filename:
            raise Blocked('ACTUAL_' + phase.upper() + '_REQUEST_PRODUCER_REQUIRED')
        document = read(filename)
        if document.get('schema_version') != 1 or not isinstance(document.get('requests'),list) or not document['requests']:
            raise Blocked('VERSIONED_ACTUAL_REQUESTS_REQUIRED:' + phase)
        outputs = {}
        for index, request in enumerate(document['requests']):
            # Requests contain real identifiers produced by the production enrollment/allocation APIs.
            polling=request.get('poll',False)
            deadline=time.monotonic()+min(int(request.get('timeout_seconds',300)),1200)
            while True:
                observation=':observation:'+uuid.uuid4().hex if polling else ''
                result=self.invoke(phase+':'+str(index)+observation,request['action'],request['input'],request.get('credential_file'))
                if not request.get('require_field'):
                    break
                value=result
                for key in request['require_field'].split('.'):
                    value=value[key]
                if value==request['require_value']:
                    break
                if not polling or time.monotonic()>=deadline:
                    raise Blocked('ACTUAL_POSTCONDITION_FAILED:'+request['action'])
                time.sleep(2)
            outputs[str(index)] = result
        write(AREA / ('0_14-' + phase + '-results.json'),outputs)
        return {'status':'ACTUAL_REQUESTS_COMPLETED','count':len(outputs)}

    def start_process(self, name, args, extra_env=None):
        old = self.journal['processes'].get(name)
        if old:
            try:
                actual = Path('/proc/' + str(old['pid']) + '/stat').read_text().split(') ',1)[1].split()[19]
                if actual == old['start_time']:
                    return old
            except FileNotFoundError:
                pass
            raise Blocked('RETAINED_PROCESS_RECONCILIATION_REQUIRED:' + name)
        log = AREA / (name + '.log')
        child_env={**self.env,**(extra_env or {})}
        child_env.pop('HYPERFIDE_MIGRATION_DATABASE_URL',None)
        with log.open('ab') as stream:
            log.chmod(0o600)
            child = subprocess.Popen(args,cwd=AREA,env=child_env,
                stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,start_new_session=True)
        identity = {'pid':child.pid,'start_time':Path('/proc/' + str(child.pid) + '/stat').read_text().split(') ',1)[1].split()[19],
                    'args_digest':digest(args),'log_file':str(log)}
        self.journal['processes'][name] = identity
        write(self.journal_path,self.journal)
        return identity

    def renew_operator(self):
        described = self.invoke('operator-renew-describe:' + uuid.uuid4().hex,
            'identity.describe', {})
        principal = described['principal']
        credential = read(self.credential)
        if principal['credential_id'] != credential['credential_id'] or principal['role'] != 'OPERATOR':
            raise Blocked('ACTUAL_OPERATOR_IDENTITY_REQUIRED')
        version = str(principal['credential_version'])
        result = self.invoke('operator-renew:' + credential['credential_id'] + ':' + version,
            'identity.principal.renew', {'ttl_seconds':3600})
        write(AREA / '0_14-operator-renewal.json', {'before':described,'renewed':result})
        return {'status':'ACTUAL_OPERATOR_RENEWED','credential_version':result['credential_version'],
                'expires_at':result['expires_at'],'source_allowance_extended':False}

    def capacity_renew(self):
        described = self.invoke('capacity-renew-identity:' + uuid.uuid4().hex, 'identity.describe', {})
        principal = described['principal']
        if principal['role'] != 'OPERATOR':
            raise Blocked('ACTUAL_OPERATOR_IDENTITY_REQUIRED')
        version = str(principal['credential_version'])
        previous = read(AREA / 'capacity-attestations.json')
        previous_bytes = canonical(previous)
        provenance = {'schema_version':1,'kind':'hyperfide.operator-capacity-allowance-renewal',
            'basis':'OPERATOR_DECLARED_CAPACITY','previous_declaration_digest':digest(previous_bytes),
            'pool_configuration':read(self.config['pool_config_file']),
            'operator_identity':described,'vendor_quota_claimed':False,
            'physical_availability_claimed':False}
        provenance_file = AREA / ('capacity-renewal-provenance-' + version + '.json')
        write(provenance_file,provenance)
        retained = self.upload('operator-capacity-renewal:' + version,provenance_file)
        if retained['storage_kind'] != 'object':
            raise Blocked('BOUNDED_CAPACITY_PROVENANCE_OBJECT_REQUIRED')
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        updated = json.loads(json.dumps(previous))
        for declaration in updated['attestations']:
            declaration['id'] = str(uuid.uuid5(uuid.UUID(self.bindings['run_id']),
                'capacity-renew:' + principal['credential_id'] + ':' + version + ':' +
                declaration['configuration_digest'] + ':' + declaration['scope_kind'] + ':' + declaration['dimension']))
            declaration.update(declared_at=now,expires_at=principal['expires_at'],
                provenance={'run_id':self.bindings['run_id'],'artifact_id':retained['artifact_id'],
                            'digest':retained['digest']})
        saved = AREA / ('capacity-attestations-before-renewal-' + digest(previous_bytes)[7:23] + '.json')
        if not saved.exists():
            write(saved,previous)
        write(AREA / 'capacity-attestations.json',updated)
        local = Journey(AREA / '0_14-live-local-operator-config.json')
        result = local.invoke('operator-capacity-renew:' + version,'provider.pools.attest-capacity',{})
        configured = local.invoke('operator-capacity-renew-configure:' + version,'provider.pools.configure',{})
        observed = local.invoke('operator-capacity-renew-inspect:' + version,
            'provider.pools.capacity',{'pool_id':updated['attestations'][0]['pool_id']})
        write(AREA / ('0_14-capacity-renewal-' + version + '.json'),
            {'operator':described,'retained_provenance':retained,'result':result,
             'configured':configured,'capacity':observed})
        return {'status':'ACTUAL_OPERATOR_CAPACITY_RENEWED','expires_at':principal['expires_at'],
                'limits_changed':False,'vendor_quota_claimed':False}

    def capacity_prepare(self):
        pool_config = read(self.config['pool_config_file'])
        pool = pool_config['pools'][0]
        local_config = read(AREA / '0_14-live-provisioner-config.json')
        local = Journey(AREA / '0_14-live-provisioner-config.json')
        observed = local.invoke('capacity-declaration-scope:' + uuid.uuid4().hex,
            'provider.pools.capacity', {'pool_id':pool['id']})
        scope = observed['scope']
        provenance = {'schema_version':1,'kind':'hyperfide.operator-capacity-allowance',
            'basis':'OPERATOR_DECLARED_CAPACITY','pool_configuration':pool_config,
            'configuration_digest':scope['configuration_digest'],
            'physical_availability_claimed':False,'vendor_quota_claimed':False}
        filename = AREA / 'capacity-allowance-provenance.json'
        write(filename,provenance)
        retained = self.upload('operator-capacity-allowance',filename)
        if retained['storage_kind'] != 'object':
            raise Blocked('BOUNDED_CAPACITY_PROVENANCE_OBJECT_REQUIRED')
        now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z')
        expires = self.config['native_credential_source']['expires_at']
        attestations = []
        account = next(a for a in pool_config['accounts']
            if a['provider']==pool['provider'] and a['account_key']==pool['account_key'])
        for kind,key,limits in [('ACCOUNT',scope['provider_account_id'],account['approved_limits']),
                                ('POOL',scope['pool_id'],pool['approved_limits'])]:
            for dimension,limit in sorted(limits.items()):
                identity = scope['configuration_digest'] + ':' + kind + ':' + dimension
                attestations.append({'id':str(uuid.uuid5(uuid.UUID(self.bindings['run_id']),identity)),
                    'pool_id':scope['pool_id'],'configuration_digest':scope['configuration_digest'],
                    'scope_kind':kind,'scope_key':key,'dimension':dimension,'limit':limit,
                    'declared_at':now,'expires_at':expires,
                    'provenance':{'run_id':self.bindings['run_id'],
                        'artifact_id':retained['artifact_id'],'digest':retained['digest']}})
        declaration = AREA / 'capacity-attestations.json'
        if declaration.exists():
            raise Blocked('RETAINED_CAPACITY_DECLARATION_RECONCILIATION_REQUIRED')
        write(declaration,{'schema_version':1,'organisation_id':self.bindings['organisation_id'],
            'attestations':attestations})
        write(AREA / '0_14-capacity-provenance-artifact.json',retained)
        write(AREA / '0_14-live-local-operator-config.json',
            {**self.config,'origin':local_config['origin'],'ca_file':local_config['ca_file']})
        return {'status':'RETAINED_OPERATOR_ALLOWANCE_PREPARED','declarations':len(attestations),
                'protected_declaration_file':str(declaration),'vendor_quota_claimed':False}

    def capacity_attest(self):
        local = Journey(AREA / '0_14-live-local-operator-config.json')
        result = local.invoke('operator-capacity-attest','provider.pools.attest-capacity',{})
        configured = local.invoke('operator-capacity-configure','provider.pools.configure',{})
        pool = read(self.config['pool_config_file'])['pools'][0]['id']
        observed = local.invoke('operator-capacity-inspect:' + uuid.uuid4().hex,
            'provider.pools.capacity',{'pool_id':pool})
        write(AREA / '0_14-operator-capacity-observation.json',{'result':result,'configured':configured,'capacity':observed})
        return {'status':'OPERATOR_DECLARED_CAPACITY_RECORDED','vendor_quota_claimed':False}

    def provider_progress(self):
        config = read(self.config['supervisor_config_file'])
        state = read(Path(config['state_directory']) / 'state.json')
        actor = config['primary']['session_id']
        binding = state['actors'][actor]['binding']
        observation = self.invoke('provider-progress-observe:' + uuid.uuid4().hex,
            'fleet.observe', {'binding':binding,'after':None,'limit':100},
            config['primary']['credential_file'])
        write(AREA / '0_14-fleet-current-observation.json',observation)
        local = Journey(AREA / '0_14-live-provisioner-config.json')
        results = []
        for receipt in observation.get('effect_receipts', []):
            effect = receipt.get('result', {})
            if effect.get('kind') != 'PROVISION_SANDBOX':
                continue
            intent = effect.get('provider_intent_id')
            if not intent:
                raise Blocked('ACTUAL_MODEL_PROVISION_INTENT_REQUIRED')
            executed = local.invoke('provider-create-execute:' + intent,
                'provider.intents.execute', {'intent_id':intent})
            inspected = local.invoke('provider-create-inspect:' + intent + ':' + uuid.uuid4().hex,
                'provider.intents.get', {'intent_id':intent})
            results.append({'effect':effect,'executed':executed,'inspected':inspected})
        write(AREA / '0_14-provider-executions.json',results)
        if not results:
            raise Blocked('ACTUAL_MANAGER_PROVISION_DECISION_REQUIRED')
        if any(item['inspected'].get('state') not in ['ACKNOWLEDGED','TERMINAL'] or not item['inspected'].get('native_sandbox_id') for item in results):
            raise Blocked('ACTUAL_PROVIDER_OUTCOME_RECONCILIATION_REQUIRED')
        return {'status':'ACTUAL_SELECTED_PROVIDER_INTENTS_EXECUTED','count':len(results),
                'runner_boot_readiness':'REQUIRES_ACTUAL_OBSERVATION'}

    def provisioner_setup(self):
        ids = read(AREA / '0_14-principals.json')
        process = read(AREA / 'local-provisioner/process.json')
        raw = subprocess.check_output(['openssl','pkey','-in',str(AREA / 'provisioner.pem'),
            '-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
        actions = ['identity.describe','identity.principal.renew','credentials.inspect',
            'provider.pools.configure','provider.pools.observe','provider.pools.attest-capacity',
            'provider.pools.list','provider.pools.capacity','provider.pools.readiness',
            'provider.intents.get','provider.intents.execute','provider.intents.reconcile',
            'provider.inventory.observe-known','provider.remote.execute-bound',
            'provider.worker.start','provider.worker.status','provider.worker.stop',
            'artifact.object.put','artifact.object.read','artifact.object.inspect',
            'artifact.object.locate','artifact.object.reconcile',
            'artifact.manifest.commit','artifact.manifest.read']
        issued = self.invoke('issue-provisioner','identity.service.issue', {
            'credential_id':ids['provisioner_credential_id'],'actor_id':ids['provisioner_actor_id'],
            'role':'PROVISIONER','public_key_b64':base64.urlsafe_b64encode(raw[-32:]).decode().rstrip('='),
            'allowed_actions':actions,'ttl_seconds':1800})
        operator = read(self.credential)
        credential_file = AREA / 'provisioner.json'
        write(credential_file, {'schema_version':1,'credential_id':issued['credential_id'],
            'actor_id':ids['provisioner_actor_id'],'organisation_id':self.bindings['organisation_id'],
            'run_id':self.bindings['run_id'],'role':'PROVISIONER',
            'authority_epoch':operator['authority_epoch'],'key_file':str(AREA / 'provisioner.pem')})
        local_config = {**self.config,'origin':process['origin'],
            'ca_file':str(AREA / 'local-provisioner-tls/tls-ca.crt'),
            'operator_credential_file':str(credential_file)}
        local_path = AREA / '0_14-live-provisioner-config.json'
        write(local_path,local_config)
        local = Journey(local_path)
        configured = local.invoke('provisioner-pool-configure','provider.pools.configure',{})
        pool = read(self.config['pool_config_file'])['pools'][0]['id']
        observed = local.invoke('provisioner-pool-observe','provider.pools.observe',{'pool_id':pool})
        attested = local.invoke('provisioner-pool-attest','provider.pools.attest-capacity',{})
        write(AREA / '0_14-provisioner-pool-observation.json',
            {'configured':configured,'observed':observed,'attested':attested})
        return {'status':'ACTUAL_PROVISIONER_POOL_CONFIGURED','credential_file':str(credential_file)}

    def model_cycle(self):
        config = self.config.get('supervisor_config_file')
        if not config:
            raise Blocked('ACTUAL_SUPERVISOR_CONFIG_REQUIRED')
        log = AREA / '0_14-model-cycle.log'
        with log.open('ab') as stream:
            log.chmod(0o600)
            try:
                result = subprocess.run([str(NODE),str(ROOT / 'core/control-plane/dist/fleet-supervisor.js'),
                    '--config',config,'--once'],cwd=AREA,env=self.env,
                    stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,timeout=360)
            except subprocess.TimeoutExpired:
                raise Blocked('MODEL_CYCLE_OUTCOME_RECONCILIATION_REQUIRED')
        if result.returncode:
            raise Blocked('ACTUAL_MODEL_CYCLE_FAILED:' + str(result.returncode))
        return {'status':'ACTUAL_SUPERVISOR_CYCLE_COMPLETED',
                'decisions':'REQUIRE_PERSISTED_SERVER_RECEIPTS','log_file':str(log)}

    def run(self):
        # Role processes consume production durable work; no test handlers or synthetic receipts.
        supervisor=self.config.get('supervisor_config_file')
        if not supervisor:raise Blocked('ACTUAL_SUPERVISOR_CONFIG_REQUIRED')
        for role in ['provisioner']:
            cfg = self.config.get(role)
            if not cfg:
                raise Blocked('ACTUAL_' + role.upper() + '_CONFIG_REQUIRED')
            args = [str(NODE),str(ROOT / 'core/control-plane/dist' / (role + '.js')),
                '--policy',cfg['policy_file'],'--spec-revision',cfg['spec_revision'],
                '--components',cfg['components_directory'],'--module-root',str(ROOT / 'core/control-plane/dist'),
                '--mode','https','--host',cfg.get('host','127.0.0.1'),'--port',str(cfg['port']),
                '--tls-cert',cfg['tls_cert_file'],'--tls-key',cfg['tls_key_file']]
            env_file=Path(cfg['runtime_environment_file'])
            if env_file.stat().st_mode & 0o077:
                raise Blocked('PRIVATE_RUNTIME_ENVIRONMENT_REQUIRED')
            parse="const fs=require('node:fs'),util=require('node:util');console.log(JSON.stringify(util.parseEnv(fs.readFileSync(process.argv[1],'utf8'))))"
            runtime_env=json.loads(subprocess.check_output([str(NODE),'-e',parse,str(env_file)],text=True))
            if not runtime_env.get('DATABASE_URL'):
                raise Blocked('RUNTIME_DATABASE_ROLE_REQUIRED')
            role_env={**runtime_env,**cfg.get('environment',{})}
            if role_env.get('HYPERFIDE_MIGRATION_DATABASE_URL'):
                raise Blocked('MIGRATION_CREDENTIAL_EXPOSED')
            self.start_process(role,args,role_env)
        supervisor = self.config.get('supervisor_config_file')
        if not supervisor:
            raise Blocked('ACTUAL_SUPERVISOR_CONFIG_REQUIRED')
        self.start_process('supervisor',[str(NODE),str(ROOT / 'core/control-plane/dist/fleet-supervisor.js'),
            '--config',supervisor])
        return {'status':'STARTED','qualification':'PENDING_ACTUAL_RECEIPTS'}

    def cleanup(self):
        # Keep the provisioner alive while actual destruction/absence requests are reconciled.
        remote = self.steps('cleanup')
        stopped = []
        for name, identity in self.journal['processes'].items():
            try:
                current = Path('/proc/' + str(identity['pid']) + '/stat').read_text().split(') ',1)[1].split()[19]
                if current != identity['start_time']:
                    raise Blocked('CLEANUP_PROCESS_IDENTITY_CHANGED:' + name)
                os.killpg(identity['pid'],signal.SIGTERM)
                stopped.append(name)
            except FileNotFoundError:
                stopped.append(name)
        # Resource cleanup is an exact signed official request list for owned IDs only.
        return {'status':'CLEANUP_REQUESTED','local_processes':stopped,'remote':remote,
                'absence_proof':'REQUIRES_ACTUAL_PROVIDER_OBSERVATION'}

    def native_step(self, name):
        generation = self.config.get('native_authority_generation')
        if generation is None:
            return name
        try:
            generation = str(uuid.UUID(generation))
        except (ValueError, TypeError, AttributeError):
            raise Blocked('ACTUAL_NATIVE_AUTHORITY_GENERATION_REQUIRED')
        name = name + '-' + generation
        lease = self.config.get('native_credential_lease_digest')
        if lease and not name.startswith('native-qualification-'):
            if not isinstance(lease, str) or len(lease) != 71 or not lease.startswith('sha256:') or any(c not in '0123456789abcdef' for c in lease[7:]):
                raise Blocked('ACTUAL_CREDENTIAL_SOURCE_LEASE_DIGEST_REQUIRED')
            name += '-' + lease[7:23]
        deployment = self.config.get('native_qualification_deployment_id')
        if deployment and name.startswith('native-qualification-'):
            try:
                name += '-' + str(uuid.UUID(deployment))
            except (ValueError, TypeError, AttributeError):
                raise Blocked('ACTUAL_QUALIFICATION_DEPLOYMENT_REQUIRED')
        return name

    def native_qualification(self):
        filename = self.config.get('native_qualification_input_file')
        if not filename:
            raise Blocked('ACTUAL_NATIVE_CAPABILITY_OBSERVATIONS_REQUIRED')
        payload = read(filename)
        if payload.get('profile_id') != self.config.get('native_auth_profile_id'):
            raise Blocked('NATIVE_QUALIFICATION_PROFILE_MISMATCH')
        result = self.invoke(self.native_step('native-qualification-record'), 'connector.qualification.record', payload)
        observed = self.invoke(self.native_step('native-qualification-inspect'), 'connector.qualification.inspect',
            {'profile_id':payload['profile_id']})
        write(AREA / '0_14-native-qualification-observation.json', {'record':result,'inspect':observed})
        if result.get('state') != 'QUALIFIED':
            raise Blocked('NATIVE_CONNECTOR_QUALIFICATION_REFUSED:' + str(result.get('reasons')))
        return {'status':'OFFICIAL_QUALIFICATION_RECORDED','receipt_digest':result['receipt_digest'],
                'capabilities':result['capabilities']}

    def native_credential(self):
        source = self.config.get('native_credential_source')
        if not isinstance(source, dict):
            raise Blocked('DEPLOYED_NATIVE_CREDENTIAL_SOURCE_REQUIRED')
        profile_id = self.config.get('native_auth_profile_id')
        snapshot = self.invoke(self.native_step('native-auth-snapshot'), 'native.auth.snapshot', {'profile_id':profile_id})
        reference = snapshot['credential_reference']
        observed = self.invoke(self.native_step('native-credential-inspect'), 'credentials.inspect', {'reference_id':reference})
        principal = read(self.credential)
        return self.invoke(self.native_step('native-credential-register'), 'credentials.reference.rotate', {
            'reference_id':reference,'source_name':source['name'],
            'expected_version':observed.get('credential_version') or '0',
            'expires_at':source['expires_at'],'allowed_layers':['process'],
            'allowed_roles':self.config.get('native_credential_roles',['OPERATOR']),
            'refresh_owner':principal['actor_id'],
            'purposes':['WORKER_PROCESS']})

    def native_auth(self):
        profile_id = self.config.get('native_auth_profile_id')
        if not isinstance(profile_id, str) or not profile_id:
            raise Blocked('DEPLOYED_NATIVE_AUTH_PROFILE_REQUIRED')
        snapshot = self.invoke(self.native_step('native-auth-snapshot'), 'native.auth.snapshot', {'profile_id':profile_id})
        probe_name = 'native-auth-probe-after-registration' if self.journal['steps'].get(self.native_step('native-credential-register'), {}).get('state') == 'SUCCEEDED' else 'native-auth-probe'
        probe = self.invoke(self.native_step(probe_name), 'native.auth.probe', {'profile_id':profile_id})
        if probe.get('snapshot', {}).get('profile_id') != profile_id or probe.get('runtime_version_verified') is not True:
            raise Blocked('NATIVE_AUTH_PROFILE_OR_VERSION_UNCONFIRMED')
        if probe.get('native_authentication') != 'AUTHENTICATED':
            raise Blocked('NATIVE_AUTHENTICATION_BLOCKED')
        write(AREA / '0_14-native-auth-observation.json', {'snapshot':snapshot,'probe':probe})
        return {'status':'AUTH_STATUS_OBSERVED','inference_qualified':False,
                'connector_capabilities_qualified':False}

    def inspect(self):
        return {'status':'OBSERVATION_ONLY','steps':{k:v['state'] for k,v in self.journal['steps'].items()},
                'production_success_claimed':False,'future_provider_assertions':FUTURE_PROVIDER_ASSERTIONS}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase',choices=['capacity-renew','renew-operator','environment-register','capacity-prepare','capacity-attest','provider-progress','provisioner-setup','model-cycle','native-qualification','native-credential','native-auth','trust','readiness-artifact','activate-run','sessions','artifacts','registration','profile','enrollment','qualification','run','cleanup','inspect'])
    parser.add_argument('--config',default=str(AREA / '0_14-live-config.json'))
    args = parser.parse_args()
    receipt = {'schema_version':1,'phase':args.phase,'status':'BLOCKED','proof_scope':'actual production APIs only',
               'future_provider_assertions':FUTURE_PROVIDER_ASSERTIONS}
    try:
        journey = Journey(args.config)
        method = {'capacity-renew':journey.capacity_renew,'renew-operator':journey.renew_operator,'environment-register':journey.environment_register,'capacity-prepare':journey.capacity_prepare,'capacity-attest':journey.capacity_attest,'provider-progress':journey.provider_progress,'provisioner-setup':journey.provisioner_setup,'model-cycle':journey.model_cycle,'native-qualification':journey.native_qualification,'native-credential':journey.native_credential,'native-auth':journey.native_auth,'trust':journey.trust,'readiness-artifact':journey.readiness_artifact,'activate-run':journey.activate_run,'sessions':journey.sessions,'profile':journey.profile,
                  'artifacts':journey.artifacts,'registration':journey.registration,'run':journey.run,
                  'cleanup':journey.cleanup,'inspect':journey.inspect}.get(args.phase)
        result = method() if method else journey.steps(args.phase)
        receipt.update(status='PHASE_COMPLETED',result=result)
        code = 0
    except (Blocked,KeyError,FileNotFoundError,subprocess.SubprocessError) as error:
        receipt['blocker'] = str(error)[:1200]
        code = 2
    write(AREA / ('0_14-' + args.phase + '-receipt.json'),receipt)
    print(json.dumps({'phase':args.phase,'status':receipt['status'],'blocker':receipt.get('blocker')}))
    return code

if __name__ == '__main__':
    raise SystemExit(main())
