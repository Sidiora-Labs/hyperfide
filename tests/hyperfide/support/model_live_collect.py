#!/usr/bin/env python3
"""Collect seven model cases on an owner's isolated supervisory host.

Run with --plan /private/model-plan.json --output /private/model-capture.
Run the collector outside the disposable supervisory host. Configuration, CA and
credential references must be available on the shared private volume used by
the launcher and collector; owner provider drivers retain that volume on loss.
The private v1 plan supplies target (fleet_live_qualification's trusted database
and source pins), provider_environment {provider, account, environment},
supervisor_config (absolute protected production configuration with one Primary
and exactly two managers), supervisor_argv (the real local or remote launcher,
including --config and the configuration path), and drivers for model_replan,
supervisor_box_loss, stale_generation_replay and model_unavailability. Each
owner driver has argv and timeout_seconds (1..600), executes actual authenticated
state/provider operations, and emits {scope, case, target_updates}. Scope binds
provider_environment, organisation_id, run_id and host_id. Case and updates use
the live verifier's existing signed fault-journal/provider-proof schemas.

Drivers receive HF_MODEL_CASE, HF_MODEL_TARGET, HF_MODEL_EVIDENCE_ROOT,
HF_MODEL_SUPERVISOR_CONFIG and HF_MODEL_SUPERVISOR_LAUNCHER_PID. Replan must
change accepted observed state between two actual model rounds. Box loss must
SIGKILL the actual supervisor, terminate its isolated provider host, restart from
the same protected config/state volume with --restore-only, and retain signed
provider absence, both state files and the restoration events. The collector
also kills its owned launcher before that driver. Other drivers replay an actual
unapplied stale model decision and induce a real gateway transport failure.
No driver summary, missing credential, local process exit, or restart ACK can
stand in for provider loss or actual model execution.

The collector starts the production supervisor, captures its reasoning requests
and responses, selects real model-produced decisions from PostgreSQL, submits a
signed over-budget delegation through the real API, and validates every case.
Collection emits no live PASS: run 0_12.py with the generated index and target.
"""
from pathlib import Path
import argparse
import json
import os
import signal
import stat
import subprocess
import sys
import time
import uuid

import fleet_live_qualification as live
from install_live_collect import write_private, pinned_file, capture_reference

ROOT = Path(__file__).resolve().parents[3]
DRIVER_CASES = ('model_replan', 'supervisor_box_loss', 'stale_generation_replay', 'model_unavailability')
UPDATE_KEYS = frozenset(('fault_drivers', 'case_error_codes', 'auth_clock_skew_seconds',
                         'origin', 'fault_operator_credential_id'))
CONTRACT_FILES = ('contracts/fleet/index.mjs', 'spec/hyperfide-source-control/spec.kvx',
                  'core/control-plane/src/fleet-supervisor.ts',
                  'core/control-plane/src/agents/fleet_orchestration.ts',
                  'tests/hyperfide/support/fleet_live_qualification.py',
                  'tests/hyperfide/support/model_live_collect.py')
NODE_INVOKE = r"""
import fs from 'node:fs/promises';import https from 'node:https';
import {createPrivateKey,randomUUID,sign} from 'node:crypto';
import {hash,signingBytes,strictJSON} from './core/control-plane/dist/transport/protocol.js';
import {readProtectedFile} from './core/control-plane/dist/preparation/fleet_client.js';
const a=JSON.parse(await fs.readFile('/dev/stdin','utf8'));
const credential=strictJSON(await readProtectedFile(a.credential_file,65536,true));
if(credential.actor_id!==a.actor_id||credential.organisation_id!==a.organisation_id||credential.run_id!==a.run_id||credential.role!=='LEADER'||credential.authority_epoch!==a.authority_epoch)throw Error('MODEL_COLLECTOR_IDENTITY_MISMATCH');
const secret=await readProtectedFile(credential.key_file,16384,true);let key;try{key=createPrivateKey(secret);}finally{secret.fill(0);}
if(key.asymmetricKeyType!=='ed25519')throw Error('MODEL_COLLECTOR_KEY_REQUIRED');
const operation_id=randomUUID(),payload=Buffer.from(JSON.stringify({run_id:a.run_id,component:'fleet-orchestration',action:a.action,input:a.input,expected_version:null,authority:null}));
const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id,idempotency_key:operation_id,payload_digest:hash(payload),correlation_id:operation_id,causation_id:null,payload_b64:payload.toString('base64url')}));
const proof={id:credential.credential_id,time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
const headers={'Content-Type':'application/json','Content-Length':String(body.length),'HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':sign(null,signingBytes(a.origin,'/v1/invoke',proof,body),key).toString('base64url')};
const ca=await readProtectedFile(a.ca_file,65536,false);
const response=await new Promise((resolve,reject)=>{
 const req=https.request(new URL('/v1/invoke',a.origin),{method:'POST',headers,ca,rejectUnauthorized:true,minVersion:'TLSv1.3',agent:false,signal:AbortSignal.timeout(120000)},res=>{
  let size=0;const chunks=[];res.on('data',chunk=>{size+=chunk.length;if(size>1048576)res.destroy();else chunks.push(chunk);});
  res.once('aborted',()=>reject(Error('MODEL_COLLECTOR_RESPONSE_UNKNOWN')));res.once('error',reject);
  res.once('end',()=>{try{const bytes=Buffer.concat(chunks);resolve({http_status:res.statusCode,body_base64:bytes.toString('base64'),body_digest:hash(bytes),body:strictJSON(bytes)});}catch(error){reject(error);}});
 });req.once('error',reject);req.end(body);
});
process.stdout.write(JSON.stringify({operation_id,credential_id:credential.credential_id,body_base64:body.toString('base64'),request_digest:hash(body),payload_digest:hash(payload),headers,response}));
"""


def require(condition, code):
    live.require(condition, code)


def command_spec(value):
    argv = value.get('argv')
    timeout = value.get('timeout_seconds')
    require(isinstance(argv, list) and argv and all(isinstance(arg, str) and arg and '\0' not in arg for arg in argv), 'MODEL_DRIVER_ARGV_REQUIRED')
    require(type(timeout) is int and 1 <= timeout <= 600, 'MODEL_DRIVER_DEADLINE_REQUIRED')
    return argv, timeout, pinned_file(argv[0])


def capture(output, name, value):
    filename = output / (name + '.json')
    write_private(filename, value)
    return {'path': filename.name, 'digest': live.digest(filename.read_bytes())}


def actual_models(target, actors, child, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        require(child.poll() is None, 'MODEL_SUPERVISOR_EXITED: inspect private supervisor.stderr.log')
        rows = live.snapshot(target)['rows']
        accepted = [d for d in rows['fleet_decisions'] if any(e['decision_id'] == d['id'] for e in rows['fleet_effect_receipts'])]
        if ({d['actor_id'] for d in accepted} == {actors['primary'], *actors['managers']} and
                {'CONFIGURE_WAVE', 'DELEGATE_WAVE'} <= {d['action'] for d in accepted if d['actor_id'] == actors['primary']} and
                {d['body']['input']['manager_session_id'] for d in accepted if d['action'] == 'DELEGATE_WAVE'} == set(actors['managers'])):
            return rows, accepted
        time.sleep(1)
    raise live.Refused('ACTUAL_THREE_MODEL_CAMPAIGN_DEADLINE')


def apply_budget_refusal(config, target, original, output):
    decision = json.loads(json.dumps(original['body']))
    decision['decision_id'] = str(uuid.uuid4())
    decision['operation_id'] = str(uuid.uuid4())
    decision['input']['budget']['max_sandboxes'] = 10001
    decision['input_digest'] = live.digest(decision['input'])
    result = subprocess.run(['node', '--input-type=module', '-e', NODE_INVOKE], cwd=ROOT,
        input=json.dumps({'credential_file':config['primary']['credential_file'], 'actor_id':config['primary']['session_id'],
            'ca_file':config['ca_file'], 'origin':config['origin'], 'action':'fleet.decision.apply',
            'input':{'decision':decision}, **{k:target[k] for k in ('organisation_id','run_id','authority_epoch')}}),
        text=True, capture_output=True, timeout=130)
    write_private(output / 'constraint-refusal.stderr.log', result.stderr.encode())
    require(result.returncode == 0, 'MODEL_BUDGET_REFUSAL_TRANSPORT_FAILED')
    journal = json.loads(result.stdout)
    body = journal['response']['body']
    require(journal['response']['http_status'] == 400 and body.get('ok') is False and
            body.get('operation_id') == journal['operation_id'] and
            body.get('error', {}).get('code') == 'FLEET_BUDGET_INVALID', 'MODEL_BUDGET_TYPED_REFUSAL_REQUIRED')
    driver_digest = live.digest(NODE_INVOKE.encode())
    journal.update({'schema_version':1, 'kind':'hyperfide.authenticated-fault-step',
        'case':'constraint_refusal', 'origin':config['origin'], 'driver_digest':driver_digest,
        'organisation_id':target['organisation_id'], 'run_id':target['run_id'],
        'authority_epoch':target['authority_epoch'],
        'source_object_id':target.get('native_source_revision_id') if target.get('source_backend') == 'native' else target['accepted_source_object_id']})
    if target.get('source_backend') == 'native':
        journal.update(source_backend='native', source_scope={k:target[k] for k in ('organisation_id','repository_id','security_domain_id')})
    case = {'producer_mode':live.MODEL_CAMPAIGN, 'operation_id':journal['operation_id'],
            'decision_operation_id':decision['operation_id'], 'capture':capture(output, 'constraint_refusal', journal)}
    pin = {'producer_mode':live.MODEL_CAMPAIGN, 'driver_digest':driver_digest,
           'payload_digest':journal['payload_digest'], 'action':'fleet.decision.apply',
           'component':'fleet-orchestration', 'actor_id':original['actor_id'],
           'credential_id':journal['credential_id'], 'original_decision_id':original['id']}
    target.setdefault('fault_drivers', {})['constraint_refusal'] = pin
    target.setdefault('case_error_codes', {})['constraint_refusal'] = ['FLEET_BUDGET_INVALID']
    return case


def owner_driver(name, spec, target, config_file, output, child, scope):
    argv, timeout, executable_digest = command_spec(spec)
    target_input = output / (name + '.target-input.json')
    write_private(target_input, target)
    environment = {**os.environ, 'HF_MODEL_CASE':name, 'HF_MODEL_TARGET':str(target_input),
        'HF_MODEL_EVIDENCE_ROOT':str(output), 'HF_MODEL_SUPERVISOR_CONFIG':str(config_file),
        'HF_MODEL_SUPERVISOR_LAUNCHER_PID':str(child.pid)}
    result = subprocess.run(argv, cwd=ROOT, env=environment, capture_output=True, timeout=timeout)
    write_private(output / (name + '.stdout.log'), result.stdout)
    write_private(output / (name + '.stderr.log'), result.stderr)
    write_private(output / (name + '.command.json'), {'argv':argv, 'executable_digest':executable_digest, 'exit':result.returncode})
    require(result.returncode == 0 and pinned_file(argv[0]) == executable_digest, 'MODEL_LIVE_DRIVER_FAILED: ' + name)
    record = json.loads(result.stdout)
    require(record.get('scope') == scope, 'MODEL_PROVIDER_CAMPAIGN_SCOPE_MISMATCH')
    case = record.get('case')
    require(isinstance(case, dict), 'MODEL_CASE_DESCRIPTOR_REQUIRED')
    capture_reference(case.get('capture'), output)
    updates = record.get('target_updates', {})
    require(isinstance(updates, dict) and set(updates) <= UPDATE_KEYS, 'MODEL_DRIVER_CANNOT_REPLACE_TARGET')
    for key, value in updates.items():
        if key in ('fault_drivers', 'case_error_codes'):
            require(isinstance(value, dict) and set(value) == {name}, 'MODEL_DRIVER_CASE_SCOPE_MISMATCH')
            previous = target.setdefault(key, {})
            require(name not in previous or previous[name] == value[name], 'MODEL_AUTHORITY_PIN_CHANGED')
            previous.update(value)
        else:
            require(key not in target or target[key] == value, 'MODEL_SHARED_AUTHORITY_PIN_CHANGED')
            target[key] = value
    if name in ('model_replan', 'supervisor_box_loss'):
        require(case.get('producer_mode') == live.MODEL_CAMPAIGN, 'MODEL_CAMPAIGN_PRODUCER_REQUIRED')
    return case


def collect(plan, output):
    require(plan.get('schema_version') == 1, 'MODEL_COLLECTION_PLAN_REQUIRED')
    scope = plan['provider_environment']
    require(isinstance(scope, dict) and set(scope) == {'provider','account','environment'} and
            scope['provider'] in ('railway','blaxel') and all(isinstance(v, str) and v for v in scope.values()), 'ISOLATED_MODEL_PROVIDER_SCOPE_REQUIRED')
    config_file = Path(plan['supervisor_config'])
    config = live.private_json(config_file)
    target = dict(plan['target'])
    require(config.get('schema_version') == target.get('schema_version') == 1 and
            all(config.get(k) == target.get(k) for k in ('organisation_id','run_id')) and
            config.get('origin') == target.get('origin'), 'MODEL_SUPERVISOR_TARGET_MISMATCH')
    require(type(target.get('auth_clock_skew_seconds')) is int and 1 <= target['auth_clock_skew_seconds'] <= 300 and target.get('fault_operator_credential_id'), 'MODEL_AUTHORITY_PINS_REQUIRED')
    managers = config.get('managers')
    require(isinstance(managers, list) and len(managers) == 2, 'EXACTLY_TWO_WAVE_MANAGERS_REQUIRED')
    actors = {'primary':config['primary']['session_id'], 'managers':[m['session_id'] for m in managers]}
    require(len({actors['primary'], *actors['managers']}) == 3, 'DISTINCT_MODEL_IDENTITIES_REQUIRED')
    require(config.get('host_id') and os.environ.get(target['database_url_env']), 'MODEL_HOST_AND_DATABASE_CAPABILITY_REQUIRED')
    require(set(plan['drivers']) == set(DRIVER_CASES), 'ALL_MODEL_CAMPAIGN_DRIVERS_REQUIRED')
    target['provider_environment'] = scope
    target['contract_files'] = [{'path':name, 'digest':live.digest((ROOT / name).read_bytes())} for name in CONTRACT_FILES]
    target['case_capture_digests'] = {}
    argv, _, executable_digest = command_spec({'argv':plan['supervisor_argv'], 'timeout_seconds':600})
    require('--config' in argv and argv[argv.index('--config') + 1] == str(config_file) and '--restore-only' not in argv and '--once' not in argv, 'REAL_CONTINUOUS_SUPERVISOR_COMMAND_REQUIRED')
    write_private(output / 'supervisor.command.json', {'argv':argv, 'executable_digest':executable_digest,
        'config_digest':live.digest(config), 'host_id':config['host_id'], 'actors':actors})
    stdout = output / 'supervisor.stdout.log'
    stderr = output / 'supervisor.stderr.log'
    with os.fdopen(os.open(stdout, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out, \
         os.fdopen(os.open(stderr, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as err:
        child = subprocess.Popen(argv, cwd=ROOT, stdout=out, stderr=err, start_new_session=True)
    try:
        rows, accepted = actual_models(target, actors, child, 600)
        cases = {}
        for name, selected in [('co_located_models', accepted), ('model_delegation', [d for d in accepted if d['action'] == 'DELEGATE_WAVE'])]:
            cases[name] = {'decision_ids':[d['id'] for d in selected],
                           'capture':capture(output, name, [d['body'] for d in selected])}
        expected_scope = {**scope, **{k:target[k] for k in ('organisation_id','run_id')}, 'host_id':config['host_id']}
        cases['model_replan'] = owner_driver('model_replan', plan['drivers']['model_replan'], target, config_file, output, child, expected_scope)
        original = next(d for d in accepted if d['action'] == 'DELEGATE_WAVE')
        cases['constraint_refusal'] = apply_budget_refusal(config, target, original, output)
        for name in DRIVER_CASES[1:]:
            if name == 'supervisor_box_loss' and child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=10)
            cases[name] = owner_driver(name, plan['drivers'][name], target, config_file, output, child, expected_scope)
        require(pinned_file(argv[0]) == executable_digest, 'MODEL_SUPERVISOR_EXECUTABLE_CHANGED')
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=10)
    events = [json.loads(line) for line in stdout.read_text().splitlines()]
    reason_events = [e for e in events if e.get('event') in ('reason_request','reason_response')]
    index = {'schema_version':1, 'kind':'hyperfide.fleet-live-evidence', 'producer_mode':live.MODEL_CAMPAIGN,
             'actors':actors, 'reason_transcript':capture(output, 'reason-transcript', reason_events), 'cases':cases}
    for name, case in cases.items():
        target['case_capture_digests'][name] = capture_reference(case['capture'], output)
    index['target_digest'] = live.digest(target)
    journals = []
    for name, case in cases.items():
        value = live.captured_case(name, case, target, output)
        if isinstance(value, dict) and value.get('kind') in ('hyperfide.authenticated-fault-step','hyperfide.authenticated-operator-step'):
            journals.append({'case':name, 'capture':value})
    rows = live.snapshot(target, journals=journals)['rows']
    live.verified_model_transcript(index, rows, output)
    for name in live.MODEL_CASES:
        live.case_oracle(name, cases[name], rows, target, output, index)
    write_private(output / 'target.json', target)
    write_private(output / 'index.json', index)
    command = [sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/0_12.py'),
        '--live-evidence', str(output / 'index.json'), '--target', str(output / 'target.json'),
        '--receipt', str(output / 'live-receipt.json')]
    write_private(output / 'collection.json', {'status':'COLLECTED', 'qualified':False,
        'cases':list(live.MODEL_CASES), 'verify_argv':command})
    print(json.dumps({'status':'COLLECTED', 'qualified':False, 'cases':len(cases), 'verify_argv':command}))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    require(output.is_absolute() and output.resolve() == output, 'CANONICAL_PRIVATE_MODEL_OUTPUT_REQUIRED')
    plan = live.private_json(args.plan)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    details = output.lstat()
    require(stat.S_ISDIR(details.st_mode) and details.st_uid == os.getuid() and details.st_mode & 0o077 == 0, 'PRIVATE_MODEL_OUTPUT_REQUIRED')
    collect(plan, output)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, StopIteration, live.Refused, subprocess.SubprocessError) as error:
        print('MODEL_LIVE_COLLECTION_REFUSED: ' + str(error), file=sys.stderr)
        raise SystemExit(77)
