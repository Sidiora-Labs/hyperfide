#!/usr/bin/env python3
"""Collect task 0.11 against an owner's explicitly isolated provider campaign.

Usage: install_live_collect.py --plan /private/install-plan.json --output /private/install

The mode-0600 plan contains schema_version=1, target (the trusted database/run
and source pins consumed by fleet_live_qualification), provider_environment
{provider, account, environment}, role_binaries {install, coding, test} (absolute
local paths to the deployed native artifacts), toolchains [{name, version,
executable, version_argv}], and cases keyed by every INSTALL_CASES name. Each
case specifies argv and timeout_seconds (1..600). No shell is invoked.

Each owner's authenticated provider driver receives HF_INSTALL_CASE,
HF_INSTALL_TARGET and HF_INSTALL_EVIDENCE_ROOT, plus HF_INSTALL_OPERATION_ID
after interrupted recovery establishes the shared final execution. It writes raw captures beneath
the private evidence root and emits one JSON object: scope (provider_environment
plus organisation_id/run_id), install_operation_id (the final READY execution),
case (the verifier's case descriptor, including capture/native_receipts refs),
and target_updates (scenario authority pins only). Drivers must execute the
actual case; archived/component evidence is rejected by the live verifier.
Interrupted recovery runs first so subsequent observations can name its final
READY execution; concurrent_isolation additionally needs a peer sandbox in the
same isolated provider campaign, as required by the independent verifier.

Collection is not qualification. Run 0_11.py with the generated index and target
to authenticate all eleven scenarios against the current authoritative database.
Credentials stay in the owner's environment and never enter the published tree.
"""
from pathlib import Path
import argparse
import json
import os
import re
import stat
import subprocess
import sys

import fleet_live_qualification as live

ROOT = Path(__file__).resolve().parents[3]
CONTRACT_FILES = ('contracts/fleet/index.mjs', 'spec/hyperfide-source-control/spec.kvx')
UPDATE_KEYS = frozenset(('fault_drivers', 'repeat_driver', 'case_error_codes',
                         'auth_clock_skew_seconds', 'origin', 'fault_operator_credential_id'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def write_private(filename, value):
    data = value if isinstance(value, bytes) else live.canonical(value) + b'\n'
    descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def pinned_file(filename):
    file = Path(filename)
    require(file.is_absolute() and file.resolve() == file and file.is_file(), 'Canonical ordinary artifact path required')
    require(file.stat().st_mode & 0o022 == 0, 'Artifact cannot permit untrusted writes')
    return live.digest(file.read_bytes())


def capture_reference(reference, output):
    require(isinstance(reference, dict), 'Case capture reference required')
    relative = Path(reference['path'])
    require(not relative.is_absolute() and '..' not in relative.parts and str(relative) == reference['path'], 'Capture path must remain below the evidence root')
    filename = output / relative
    live.private_json(filename)
    actual = live.digest(filename.read_bytes())
    require(actual == reference['digest'], 'Produced capture digest differs from its reference')
    return actual


def collect(plan, output):
    require(plan.get('schema_version') == 1, 'Install collection plan v1 required')
    scope = plan['provider_environment']
    require(isinstance(scope, dict) and set(scope) == {'provider', 'account', 'environment'} and
            scope['provider'] in ('railway', 'blaxel') and all(isinstance(value, str) and value for value in scope.values()),
            'Explicit isolated provider/account/environment required')
    target = dict(plan['target'])
    require(target.get('schema_version') == 1, 'Live target v1 required')
    database_env = target['database_url_env']
    require(re.fullmatch(r'[A-Z][A-Z0-9_]*', database_env) and os.environ.get(database_env), 'Owner database capability required')
    require(set(plan['cases']) == set(live.INSTALL_CASES), 'Exactly the eleven live install drivers are required')
    require(set(plan['role_binaries']) == {'install', 'coding', 'test'}, 'All three native role artifacts must be pinned')
    target['provider_environment'] = scope
    target['contract_files'] = [{'path': name, 'digest': live.digest((ROOT / name).read_bytes())} for name in CONTRACT_FILES]
    target['native_binary_pins'] = {role: pinned_file(filename) for role, filename in plan['role_binaries'].items()}
    target['toolchains'] = []
    require(isinstance(plan['toolchains'], list) and plan['toolchains'], 'Real toolchain artifacts required')
    for tool in plan['toolchains']:
        filename = Path(tool['executable'])
        pin = pinned_file(filename)
        argv = tool['version_argv']
        require(isinstance(argv, list) and argv and argv[0] == str(filename) and all(isinstance(arg, str) for arg in argv), 'Version command must execute the pinned toolchain')
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=30, check=False)
        write_private(output / ('toolchain-' + str(len(target['toolchains'])) + '.log'), result.stdout + result.stderr)
        require(result.returncode == 0 and result.stdout.decode().strip().removeprefix('v') == tool['version'], 'Actual toolchain version differs from plan')
        require(pinned_file(filename) == pin, 'Toolchain changed while measured')
        require(not any(previous['name'] == tool['name'] for previous in target['toolchains']), 'Duplicate toolchain name')
        target['toolchains'].append({'name': tool['name'], 'version': tool['version'], 'digest': pin})

    target_input = output / 'target-input.json'
    write_private(target_input, target)
    expected_scope = {**scope, **{key: target[key] for key in ('organisation_id', 'run_id')}}
    cases = {}
    operation = None
    target['case_capture_digests'] = {}
    order = ('interrupted_install',) + tuple(name for name in live.INSTALL_CASES if name != 'interrupted_install')
    for name in order:
        driver = plan['cases'][name]
        argv = driver['argv']
        timeout = driver['timeout_seconds']
        require(isinstance(argv, list) and argv and all(isinstance(arg, str) and arg and '\0' not in arg for arg in argv), 'Explicit provider driver argv required')
        require(type(timeout) is int and 1 <= timeout <= 600, 'Bounded provider driver timeout required')
        environment = {**os.environ, 'HF_INSTALL_CASE': name, 'HF_INSTALL_TARGET': str(target_input),
                       'HF_INSTALL_EVIDENCE_ROOT': str(output)}
        if operation is not None:
            environment['HF_INSTALL_OPERATION_ID'] = operation
        result = subprocess.run(argv, cwd=ROOT, env=environment, capture_output=True, timeout=timeout, check=False)
        write_private(output / (name + '.stdout.log'), result.stdout)
        write_private(output / (name + '.stderr.log'), result.stderr)
        write_private(output / (name + '.command.json'), {'argv': argv, 'exit': result.returncode})
        require(result.returncode == 0, name + ' driver failed; inspect private command and logs')
        record = json.loads(result.stdout)
        require(record['scope'] == expected_scope, name + ' crossed the isolated provider campaign')
        current = record['install_operation_id']
        require(re.fullmatch(r'[0-9a-f-]{36}', current) and (operation is None or operation == current), 'All cases must reference the same final READY execution')
        operation = current
        case = record['case']
        require(isinstance(case, dict), 'Actual case descriptor required')
        target['case_capture_digests'][name] = capture_reference(case['capture'], output)
        for reference in case.get('native_receipts', []):
            capture_reference(reference, output)
        updates = record.get('target_updates', {})
        require(isinstance(updates, dict) and set(updates) <= UPDATE_KEYS, 'Driver cannot replace trusted target identity or artifact pins')
        for key, value in updates.items():
            if key in ('fault_drivers', 'case_error_codes'):
                require(isinstance(value, dict) and set(value) == {name}, 'Scenario pins must name only the current case')
                previous = target.setdefault(key, {})
                require(name not in previous or previous[name] == value[name], 'Scenario authority pin changed')
                previous.update(value)
            else:
                require(key not in target or target[key] == value, 'Shared authority pin changed')
                target[key] = value
        cases[name] = case

    # Read the authoritative immutable receipt and its signed native producer;
    # driver summaries never supply either a READY result or transfer counters.
    observed = live.snapshot(target)
    rows = observed['rows']
    install = live.one(rows['fleet_environment_installs'], 'operation_id', operation)
    require(install['state'] == 'READY' and install['input_digest'] == target['input_digest'] and
            install['authority_epoch'] == target['authority_epoch'], 'Current pinned READY installation required')
    job = live.signed_install(rows, install)
    live.native_role(rows, job, 'install', target)
    receipt = install['receipt']
    require(receipt['receipt_digest'] == install['receipt_digest'] == live.digest({key: value for key, value in receipt.items() if key != 'receipt_digest'}), 'Immutable READY receipt digest mismatch')
    transfer = live.verified_install_transfer(rows, install, cases['fetch_volume'], target, output)
    write_private(output / 'ready-receipt.json', receipt)
    write_private(output / 'fetch-volume.json', {'native_stage': transfer, 'dependency_io': receipt['transfer']['dependency_io']})
    index = {'schema_version': 1, 'kind': 'hyperfide.fleet-live-evidence',
             'target_digest': live.digest(target), 'install_operation_id': operation, 'cases': cases}
    write_private(output / 'target.json', target)
    write_private(output / 'index.json', index)
    command = [sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/0_11.py'),
               '--live-evidence', str(output / 'index.json'), '--target', str(output / 'target.json'),
               '--receipt', str(output / 'live-receipt.json')]
    write_private(output / 'collection.json', {'status': 'COLLECTED', 'qualified': False,
                  'ready_receipt_digest': install['receipt_digest'], 'verify_argv': command})
    print(json.dumps({'status': 'COLLECTED', 'qualified': False, 'cases': len(cases), 'verify_argv': command}))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = Path(args.output)
    require(output.is_absolute() and output.resolve() == output, 'Canonical private output directory required')
    plan = live.private_json(args.plan)
    output.mkdir(mode=0o700, parents=False, exist_ok=False)
    details = output.lstat()
    require(stat.S_ISDIR(details.st_mode) and details.st_uid == os.getuid() and details.st_mode & 0o077 == 0, 'Owned private evidence directory required')
    collect(plan, output)
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError, live.Refused, subprocess.SubprocessError) as error:
        print('INSTALL_LIVE_COLLECTION_REFUSED: ' + str(error), file=sys.stderr)
        raise SystemExit(77)
