"""Signed private pre-dispatch refusal controls over the caller's actual unresolved execution."""
import base64
import hashlib
import json
from pathlib import Path
import select
import subprocess
import time
import uuid

from fleet_prerequisite_fixture import component_closure

ROOT = Path(__file__).resolve().parents[3]
SUPPORT = ROOT / 'tests/hyperfide/support'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value if isinstance(value, bytes) else canonical(value)).hexdigest()


class Actor:
    def __init__(self, c):
        f = c['f']
        components = c['owned'] / 'prepost-refusal-components'
        components.mkdir(mode=0o700)
        for name in component_closure(['8.3', '10.3']):
            (components / (name + '.json')).write_bytes((ROOT / 'core/control-plane/components' / (name + '.json')).read_bytes())
        self.log = (c['owned'] / 'prepost-refusal-actor.stderr').open('w+')
        self.process = subprocess.Popen(['node', str(SUPPORT / 'runner_prepost_actor.mjs'), str(ROOT / 'core/control-plane/dist'), str(components), str(f.policy)], cwd=ROOT, env=f.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log, text=True)
        assert self.read() == {'ready': True}, 'Actual private capability actor did not start'

    def read(self):
        ready, _, _ = select.select([self.process.stdout], [], [], 25)
        assert ready, ('Private capability response timeout', self.process.poll())
        line = self.process.stdout.readline()
        assert line, ('Private capability actor exited', self.process.poll())
        return json.loads(line)

    def invoke(self, c, request, lease_id, key):
        f = c['f']
        body = canonical(f.operation('8.3', 'provider.remote.execute-bound', request))
        seconds, nonce, identifier = str(int(time.time())), str(uuid.uuid4()), f.ids[key]
        signature = f.sign(key, ('\n'.join(('HYPERFIDE-REQUEST-V1', 'POST', '/v1/invoke', f.origin, identifier, seconds, nonce, digest(body), ''))).encode())
        command = {'id': str(uuid.uuid4()), 'body': base64.b64encode(body).decode(), 'headers': ['hf-credential-id', identifier, 'hf-request-time', seconds, 'hf-request-nonce', nonce, 'hf-request-signature', signature], 'input': request, 'lease_id': lease_id}
        self.process.stdin.write(json.dumps(command) + '\n')
        self.process.stdin.flush()
        answer = self.read()
        assert answer.get('id') == command['id'], answer
        return answer

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.log.close()


def run_refusals(c, initial):
    f, operation = c['f'], c['logical']
    identifiers = c.get('i', f.ids)
    scope = [identifiers['organisation'], identifiers['run'], operation]
    checks, actor = [], None

    def job():
        return f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3', scope)[0]

    def remote():
        return f.sql('SELECT * FROM hyperfide.provider_remote_operations WHERE organisation_id=$1 AND run_id=$2 AND id=$3', scope)[0]

    def original_identity():
        return f.sql('SELECT state,credential_version::text FROM hyperfide.identity_principals WHERE credential_id=$1', [initial['executor_credential_id']])[0]

    def immutable_remote(row):
        return {key: row[key] for key in ['organisation_id', 'run_id', 'id', 'session_id', 'sandbox_id', 'boot_generation', 'request_digest', 'operation', 'process_claimed', 'process_record', 'native_process_ref']}

    assert initial['state'] == 'UNKNOWN' and initial['claim_id'] and initial['native_claimed_at'] is None and initial['result'] is None, initial
    assert initial['executor_credential_id'] == identifiers['provisioner'] and job() == initial
    original = remote()
    assert original['process_claimed'] is False and original['process_record'] is None and original['native_process_ref'] is None, original
    pins, identity = immutable_remote(original), original_identity()
    assert identity['state'] == 'ACTIVE', identity
    parameters, binding = original['operation']['parameters'], initial['plan']['binding']
    request = {'binding': {key: binding[key] for key in ['organisation_id', 'run_id', 'session_id', 'pool_id', 'sandbox_id', 'external_sandbox_id', 'boot_generation']}, 'operation_id': operation, 'argv': parameters['argv'], 'cwd': parameters['cwd'], 'env_refs': parameters['env_refs'], 'timeout_ms': parameters['process_timeout_ms']}
    request['binding']['boot_generation'] = str(request['binding']['boot_generation'])
    request['binding']['preparation_digest'] = binding['boot_preparation_digest']
    if 'env_ref_versions' in parameters:
        request['env_ref_versions'] = parameters['env_ref_versions']
    assert digest(request) == original['request_digest'], (request, original['request_digest'])

    def refused(label, lease_id, key, code):
        before = len(c['backend'].requests)
        answer = actor.invoke(c, request, lease_id, key)
        assert answer.get('ok') is False and answer.get('error', {}).get('code') == code, (label, answer)
        assert len(c['backend'].requests) == before, (label, 'refusal touched SDK', c['backend'].requests[before:])
        assert job() == initial and immutable_remote(remote()) == pins and original_identity() == identity, (label, 'original execution or authority changed')
        check = {'case': label, 'code': code, 'sdk_requests': 0}
        checks.append(check)
        print('PREPOST_REFUSAL ' + json.dumps(check), flush=True)

    try:
        deadline, lease = time.monotonic() + 90, None
        while time.monotonic() < deadline:
            c['heartbeat']()
            rows = f.sql('SELECT *,lease_until<=clock_timestamp() AS expired FROM hyperfide.runner_result_collections WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3', scope)
            if rows and rows[0]['expired']:
                lease = rows[0]
                break
            time.sleep(.15)
        assert lease and lease['claim_id'] == initial['claim_id'] and lease['executor_credential_id'] == initial['executor_credential_id'] and int(lease['attempts']) >= 1, lease
        assert job() == initial and immutable_remote(remote()) == pins
        actor = Actor(c)
        refused('naturally expired original pre-dispatch collection lease', lease['lease_id'], 'provisioner', 'REMOTE_PREDISPATCH_FENCED')
        key_name = 'prepost_helper_provisioner'
        assert key_name not in f.ids and key_name not in f.keys
        key_path = c['owned'] / 'prepost-helper-provisioner.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'Ed25519', '-out', str(key_path)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        key_path.chmod(0o600)
        public = subprocess.check_output(['openssl', 'pkey', '-in', str(key_path), '-pubout', '-outform', 'DER'], stderr=subprocess.DEVNULL)
        f.ids[key_name], f.keys[key_name] = str(uuid.uuid4()), {'path': key_path}
        issued = c['ok']('identity.service.issue', {'credential_id': f.ids[key_name], 'actor_id': str(uuid.uuid4()), 'role': 'PROVISIONER', 'public_key_b64': base64.urlsafe_b64encode(public[-32:]).decode().rstrip('='), 'allowed_actions': ['provider.remote.execute-bound'], 'ttl_seconds': 300}, component='14.1', key='operator')
        refused('different current provisioner cannot borrow original execution', lease['lease_id'], key_name, 'REMOTE_PREDISPATCH_FENCED')
        revoked = c['ok']('identity.principal.revoke', {'credential_id': f.ids[key_name], 'expected_version': issued['credential_version']}, component='14.1', key='operator')
        assert revoked['revoked'] is True and revoked['credential_id'] == f.ids[key_name], revoked
        refused('revoked helper credential authentication only', lease['lease_id'], key_name, 'AUTH_REVOKED')
        assert not any(row['method'] == 'POST' and row['path'].rstrip('/').endswith('/process') for row in c['backend'].requests), c['backend'].requests
        return checks
    finally:
        if actor:
            actor.close()
