#!/usr/bin/env python3
"""Measure actual native CLI capability observations for an issued public snapshot."""
import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[4]


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()


def protected_json(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_mode & 0o077:
        raise RuntimeError('PRIVATE_INPUT_REQUIRED')
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--artifact', type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.relative_to((ROOT / 'build/fleet').resolve())
    if output.exists():
        raise RuntimeError('FRESH_OBSERVATION_DIRECTORY_REQUIRED')
    if not args.snapshot.is_file():
        raise RuntimeError('NATIVE_AUTH_SNAPSHOT_REQUIRED')
    snapshot = protected_json(args.snapshot.resolve())
    if snapshot.get('connector') != 'claude' or snapshot.get('auth_mode') != 'api_credential':
        raise RuntimeError('PINNED_CLAUDE_API_PROFILE_REQUIRED')
    binary = args.artifact.resolve() if args.artifact else Path(snapshot['binary']['path'])
    if not binary.is_file() or digest(binary.read_bytes()) != snapshot['binary']['digest']:
        raise RuntimeError('NATIVE_BINARY_DRIFT')
    gateway = snapshot.get('gateway', {})
    if not gateway.get('messages_endpoint', '').endswith('/v1/messages'):
        raise RuntimeError('PINNED_MESSAGES_GATEWAY_REQUIRED')
    selected = subprocess.check_output(['node', '--env-file=' + str(ROOT / '.env'), '-e', "process.stdout.write(JSON.stringify(Object.fromEntries(['MESSAGES_URL','MODEL','CLUSTER_1_GATEWAY_API_KEY'].map(k=>[k,process.env[k]]))))"], cwd=ROOT, text=True, timeout=10)
    values = json.loads(selected)
    if values.get('MESSAGES_URL') != gateway['messages_endpoint'] or values.get('MODEL') != snapshot['requested_model_id'] or not values.get('CLUSTER_1_GATEWAY_API_KEY'):
        raise RuntimeError('GATEWAY_PROFILE_ENVIRONMENT_DRIFT')
    token = values['CLUSTER_1_GATEWAY_API_KEY']
    output.mkdir(parents=True, mode=0o700)
    home, workspace, temporary = [output / name for name in ['home', 'workspace', 'temporary']]
    for directory in [home, workspace, temporary, home / '.claude']:
        directory.mkdir(mode=0o700, exist_ok=True)
    settings = {'env': {'ANTHROPIC_BASE_URL': gateway['messages_endpoint'][:-12], 'ANTHROPIC_MODEL': snapshot['requested_model_id']}}
    (home / '.claude/settings.json').write_bytes(canonical(settings))
    (home / '.claude/settings.json').chmod(0o600)
    measurement = dict(snapshot)
    measurement['binary'] = {**snapshot['binary'], 'path': str(binary)}
    measurement_file = output / 'local-measurement-snapshot.json'
    measurement_file.write_bytes(canonical(measurement))
    measurement_file.chmod(0o600)
    environment = {'PATH': '/usr/bin:/bin', 'HOME': str(home), 'TMPDIR': str(temporary), 'LANG': 'C.UTF-8', 'HF_NATIVE_AUTH_SNAPSHOT_FILE': str(measurement_file)}
    cli_environment = {key: value for key, value in environment.items() if key != 'HF_NATIVE_AUTH_SNAPSHOT_FILE'}
    cli_environment.update(ANTHROPIC_BASE_URL=gateway['messages_endpoint'][:-12], ANTHROPIC_MODEL=snapshot['requested_model_id'], ANTHROPIC_AUTH_TOKEN=token, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1', DISABLE_AUTOUPDATER='1')
    native = ROOT / 'build/hyperfide-native'

    def keep(name, value):
        data = value if isinstance(value, bytes) else canonical(value)
        data = data.replace(token.encode(), b'[REDACTED]')
        path = output / name
        path.write_bytes(data)
        path.chmod(0o600)
        return digest(data)

    def invoke(action, value, accepted=True):
        result = subprocess.run([str(native), '--component', '13.1', '--action', action], input=canonical(value), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, cwd=workspace, timeout=30)
        response = json.loads(result.stdout)
        if accepted and (result.returncode != 0 or response.get('ok') is not True):
            raise RuntimeError('NATIVE_COMPONENT_REFUSED_' + action)
        return result, response

    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('ACTUAL_PROCESS_OWNERSHIP_UNAVAILABLE')

    def children():
        return [int(pid) for pid in Path('/proc/self/task/' + str(os.getpid()) + '/children').read_text().split()]

    def reap():
        end = time.monotonic() + 8
        while time.monotonic() < end:
            current = children()
            if not current:
                return True
            for pid in current:
                try:
                    reaped, _ = os.waitpid(pid, os.WNOHANG)
                    if reaped:
                        continue
                    stat = Path('/proc/' + str(pid) + '/stat').read_text()
                    parts = stat[stat.rfind(')') + 2:].split()
                    if int(parts[1]) == os.getpid():
                        os.kill(pid, signal.SIGKILL)
                except (ChildProcessError, ProcessLookupError, FileNotFoundError):
                    pass
            time.sleep(.05)
        return not children()

    version = subprocess.run([str(binary), '--version'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=cli_environment, timeout=30, check=True)
    version_text = version.stdout.decode().strip()
    if version_text != snapshot['binary']['version'] + ' (Claude Code)':
        raise RuntimeError('NATIVE_VERSION_DRIFT')
    _, resolution = invoke('connector.resolve', {'connector': 'claude', 'alias': snapshot['configured_model_alias'], 'home': str(home)})
    _, intended = invoke('connector.launch', {'connector': 'claude', 'expected_version': snapshot['binary']['version'], 'alias': snapshot['configured_model_alias'], 'auth_profile': snapshot['profile_id'], 'workspace': str(workspace), 'home': str(home), 'temp': str(temporary), 'permission_mode': 'workspace-write'})
    argv = intended['result']['argv']
    if argv[0] != str(binary):
        raise RuntimeError('NATIVE_ARGUMENT_BINARY_DRIFT')
    nonce = uuid.uuid4().hex
    frame = {'type': 'user', 'session_id': '', 'parent_tool_use_id': None, 'message': {'role': 'user', 'content': 'Use no tools. Reply with exactly this nonce and nothing else: ' + nonce}}
    first_process = subprocess.Popen(argv, cwd=workspace, env=cli_environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        first_stdout, first_stderr = first_process.communicate(canonical(frame) + b'\n', timeout=150)
    except subprocess.TimeoutExpired:
        os.killpg(first_process.pid, signal.SIGKILL)
        first_process.communicate(timeout=8)
        reap()
        raise RuntimeError('NATIVE_INPUT_OUTPUT_TIMEOUT')
    finally:
        if first_process.poll() is None:
            os.killpg(first_process.pid, signal.SIGKILL)
            first_process.wait(timeout=8)
    first = subprocess.CompletedProcess(argv, first_process.returncode, first_stdout, first_stderr)
    first_evidence = keep('turn.stdout.jsonl', first.stdout)
    keep('turn.stderr', first.stderr)
    events = [json.loads(line) for line in first.stdout.splitlines() if line.strip()]
    initial = next((event for event in events if event.get('type') == 'system' and event.get('subtype') == 'init'), None)
    final = next((event for event in reversed(events) if event.get('type') == 'result'), None)
    if first.returncode != 0 or initial is None or final is None or final.get('is_error') or nonce not in str(final.get('result', '')):
        raise RuntimeError('ACTUAL_NATIVE_INPUT_OUTPUT_FAILED')
    if not reap():
        raise RuntimeError('NATIVE_TURN_DESCENDANTS_REMAIN')
    _, observation = invoke('connector.observe', {'connector': 'claude', 'alias': snapshot['configured_model_alias'], 'home': str(home), 'frame': canonical(initial).decode()})
    observed = observation['result']
    if not observed.get('matches_configuration') or observed.get('child_registration') != 'REFUSED':
        raise RuntimeError('NATIVE_MODEL_OR_CHILD_BOUNDARY_MISMATCH')
    steer, steer_response = invoke('connector.encode', {'connector': 'claude', 'operation': 'steer', 'native_session_id': observed['native_session_id'], 'turn_id': 'probe-turn', 'text': 'probe', 'request_id': str(uuid.uuid4())}, accepted=False)
    if steer.returncode == 0 or steer_response.get('ok') is not False:
        raise RuntimeError('CLAUDE_STEER_UNEXPECTEDLY_OFFERED')
    cancel = subprocess.Popen(argv, cwd=workspace, env=cli_environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    try:
        cancel.stdin.write(canonical({'type': 'user', 'session_id': '', 'parent_tool_use_id': None, 'message': {'role': 'user', 'content': 'Use no tools. Produce a detailed technical explanation of numerical integration methods.'}}) + b'\n')
        cancel.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(cancel.stdout, selectors.EVENT_READ)
        buffer = b''
        initialized = False
        deadline = time.monotonic() + 45
        while cancel.poll() is None and time.monotonic() < deadline and not initialized:
            if not selector.select(.1):
                continue
            chunk = os.read(cancel.stdout.fileno(), 65536)
            if not chunk:
                break
            buffer += chunk
            for line in buffer.splitlines():
                try:
                    value = json.loads(line)
                    if value.get('type') == 'system' and value.get('subtype') == 'init':
                        initialized = True
                except json.JSONDecodeError:
                    pass
        selector.close()
        if not initialized or cancel.poll() is not None:
            raise RuntimeError('NATIVE_CANCEL_INFLIGHT_NOT_OBSERVED')
        process_stat = Path('/proc/' + str(cancel.pid) + '/stat').read_text()
        start_time = process_stat[process_stat.rfind(')') + 2:].split()[19]
        os.killpg(cancel.pid, signal.SIGTERM)
        try:
            tail, stderr = cancel.communicate(timeout=8)
        except subprocess.TimeoutExpired:
            os.killpg(cancel.pid, signal.SIGKILL)
            tail, stderr = cancel.communicate(timeout=8)
        absent = reap() and not Path('/proc/' + str(cancel.pid)).exists()
        cancellation = {'pid': cancel.pid, 'start_time': start_time, 'signal_requested': 'SIGTERM', 'exit_code': cancel.returncode, 'process_absent': absent, 'initialized_before_cancel': initialized, 'stdout_digest': keep('cancel.stdout.jsonl', buffer + tail), 'stderr_digest': keep('cancel.stderr', stderr)}
        if not absent:
            raise RuntimeError('NATIVE_CANCEL_PROCESS_REMAINS')
    finally:
        if cancel.poll() is None:
            os.killpg(cancel.pid, signal.SIGKILL)
            cancel.wait(timeout=8)
        reap()
    resume, resume_response = invoke('connector.initialize', {'connector': 'claude', 'request_id': str(uuid.uuid4()), 'workspace': str(workspace), 'native_session_id': observed['native_session_id']}, accepted=False)
    if resume.returncode == 0:
        raise RuntimeError('UNQUALIFIED_RESUME_UNEXPECTEDLY_OFFERED')
    probes = {}
    for name, result, evidence in [('launch', 'ACCEPTED', intended), ('input', 'ACCEPTED', {'frame_digest': digest(canonical(frame) + b'\n'), 'output': first_evidence}), ('output', 'ACCEPTED', observation), ('cancel', 'ACCEPTED', cancellation), ('child_registration', 'REFUSED', {'native_init': initial, 'observation': observation}), ('steer', 'NOT_OFFERED', steer_response), ('resume', 'NOT_OFFERED', resume_response)]:
        probes[name] = {'result': result, 'evidence_digest': digest(canonical(evidence)), 'context_restored': False}
    r = resolution['result']['resolution']
    producer_input = {'profile_id': snapshot['profile_id'], 'cli_version_output': version_text, 'binary_digest': snapshot['binary']['digest'], 'resolution': {'configured_model_alias': snapshot['configured_model_alias'], 'resolved_model_id': r['resolved_model_id'], 'resolved_provider_id': r['resolved_provider_id'], 'source': r['source'], 'config_digest': r['config_digest'], 'provider_provenance': r['provider_provenance'], 'gateway_endpoint_digest': r['gateway_endpoint_digest']}, 'observation': {key: observed[key] for key in ['native_session_id', 'observed_model_id', 'observed_provider_id', 'observation_digest']}, 'probes': probes}
    keep('connector-qualification-input.json', producer_input)
    keep('receipt.json', {'status': 'OBSERVED', 'profile_id': snapshot['profile_id'], 'snapshot_digest': digest(args.snapshot.read_bytes()), 'artifact_mapping': {'issued_path': snapshot['binary']['path'], 'measured_path': str(binary), 'byte_identity_verified': True}, 'binary_digest': snapshot['binary']['digest'], 'capabilities_observed': list(probes), 'cancellation': cancellation, 'qualification_issued': False, 'authentication_callback': 'CONTROL_AUTHORITY_REQUIRED', 'resume_context_restoration_claimed': False})
    print(json.dumps({'status': 'OBSERVED', 'capabilities': len(probes), 'qualification_issued': False}))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'BLOCKED', 'code': str(error) if isinstance(error, RuntimeError) else type(error).__name__}))
        sys.exit(2)
