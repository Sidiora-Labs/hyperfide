#!/usr/bin/env python3
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
NODE = os.environ.get('HYPERFIDE_TEST_NODE') or shutil.which('node')
ENTRY = ROOT / 'core/control-plane/dist/fleet-supervisor.js'


def write(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


def command(config, expected=None):
    result = subprocess.run([NODE, str(ENTRY), '--config', str(config), '--check-config'], capture_output=True, text=True)
    if expected is None:
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout)['actors'] == 3
    else:
        assert result.returncode == 78, result.stdout
        assert json.loads(result.stderr)['error']['code'] == expected, result.stderr


def main():
    assert NODE and ENTRY.is_file()
    with tempfile.TemporaryDirectory(prefix='fleet-supervisor-cli-') as temporary:
        directory = Path(temporary)
        ca, key = directory / 'ca.pem', directory / 'identity.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', str(key), '-out', str(ca), '-days', '1', '-subj', '/CN=localhost'], check=True, capture_output=True)
        key.chmod(0o600)
        org, run, epoch = [f'00000000-0000-4000-8000-{i:012d}' for i in range(1, 4)]
        references = []
        for index, role in enumerate(['LEADER', 'FEATURE_MANAGER', 'FEATURE_MANAGER'], 4):
            actor = f'00000000-0000-4000-8000-{index:012d}'
            actor_key = directory / f'actor-{index}.pem'
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(actor_key)], check=True, capture_output=True)
            actor_key.chmod(0o600)
            credential = directory / f'actor-{index}.json'
            write(credential, {'schema_version': 1, 'credential_id': f'00000000-0000-4000-8001-{index:012d}', 'actor_id': actor, 'organisation_id': org, 'run_id': run, 'role': role, 'authority_epoch': epoch, 'key_file': str(actor_key)})
            references.append({'session_id': actor, 'credential_file': str(credential)})
        config = {'schema_version': 1, 'origin': 'https://localhost:9443', 'ca_file': str(ca), 'organisation_id': org, 'run_id': run, 'cohort_id': '00000000-0000-4000-8000-000000000010', 'host_id': 'supervisory-box', 'leader_generation': '1', 'expected_cohort_generation': '0', 'primary': references[0], 'managers': references[1:], 'state_directory': str(directory / 'state'), 'poll_interval_ms': 1000, 'request_timeout_ms': 120000}
        filename = directory / 'config.json'
        write(filename, config)
        command(filename)
        config['managers'][1] = references[0]
        write(filename, config)
        command(filename, 'FLEET_SUPERVISOR_CONFIG')
        config['managers'] = references[1:]
        write(filename, config)
        manager = Path(references[1]['credential_file'])
        record = json.loads(manager.read_text())
        record['role'] = 'LEADER'
        write(manager, record)
        command(filename, 'FLEET_SUPERVISOR_IDENTITY')
        record['role'] = 'FEATURE_MANAGER'
        write(manager, record)
        manager.chmod(0o666)
        command(filename, 'FLEET_BOOTSTRAP_PERMISSIONS')
        manager.chmod(0o600)
        filename.chmod(0o644)
        command(filename, 'FLEET_BOOTSTRAP_PERMISSIONS')
        filename.chmod(0o600)
        operator_key = directory / 'operator.pem'
        subprocess.run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(operator_key)], check=True, capture_output=True)
        operator_key.chmod(0o600)
        operator = directory / 'operator.json'
        write(operator, {'schema_version': 1, 'credential_id': '00000000-0000-4000-8001-000000000011', 'actor_id': '00000000-0000-4000-8000-000000000011', 'organisation_id': org, 'run_id': run, 'role': 'OPERATOR', 'authority_epoch': epoch, 'key_file': str(operator_key)})
        fresh = [{'session_id': reference['session_id'], 'credential_file': str(directory / f'fresh-{index}.json'), 'key_file': json.loads(Path(reference['credential_file']).read_text())['key_file']} for index, reference in enumerate(references)]
        config.update({'bootstrap': {'operator_credential_file': str(operator), 'ttl_seconds': 900}, 'leader_generation': '0', 'primary': fresh[0], 'managers': fresh[1:]})
        write(filename, config)
        command(filename)
        config['managers'][0]['key_file'] = config['primary']['key_file']
        write(filename, config)
        command(filename, 'FLEET_SUPERVISOR_IDENTITY')
    print(json.dumps({'status': 'PASS', 'checks': 7, 'scope': 'supervisor-cli-protected-configuration'}))


if __name__ == '__main__':
    main()
