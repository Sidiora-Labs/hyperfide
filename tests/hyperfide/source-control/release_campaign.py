#!/usr/bin/env python3
"""Execute pinned full-case manifests, resume verified receipts, and close a release."""
import argparse
import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]


class CampaignError(Exception):
    pass


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


Q = load_module('campaign_qualifier', ROOT / 'tests/hyperfide/qualify.py')
CLOSURE = load_module('campaign_closure', ROOT / 'tests/hyperfide/source-control/closure.py')
CHECKER = load_module('campaign_checker', ROOT / 'tests/hyperfide/check-evidence.py')


def require(value, message):
    if not value:
        raise CampaignError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'Duplicate JSON key: ' + key)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=pairs)


def local(root, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute()
            and all(part not in ('', '.', '..') for part in name.split('/')),
            'Canonical relative path required')
    path = root / name
    require(path.resolve().is_relative_to(root.resolve())
            and not any(item.is_symlink() for item in [path, *path.parents]),
            'Symbolic or escaping campaign path')
    return path


def pin(root, value):
    require(isinstance(value, dict) and set(value) == {'path', 'sha256'}, 'Exact path/hash pin required')
    path = local(root, value['path'])
    require(path.is_file() and digest(path) == value['sha256'], 'Input pin differs: ' + value['path'])
    return path


def immutable(path, value):
    data = canonical(value) + b'\n'
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        require(path.read_bytes() == data, 'Immutable campaign input changed: ' + str(path))
        return
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def save(output, state):
    immutable(output / 'checkpoints' / (hashlib.sha256(canonical(state)).hexdigest() + '.json'), state)
    temporary = output / ('state-' + str(uuid.uuid4()) + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(canonical(state) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, output / 'state.json')


def checked(campaign, receipt_id, expected_hash=None):
    require(str(uuid.UUID(receipt_id)) == receipt_id, 'Canonical receipt identity required')
    path = campaign / 'receipts' / (receipt_id + '.json')
    require(path.is_file(), 'Recorded receipt is missing')
    require(expected_hash is None or digest(path) == expected_hash, 'Recorded receipt changed')
    result = subprocess.run([sys.executable, '-I', str(ROOT / 'tests/hyperfide/check-evidence.py'),
                             '--campaign', str(campaign), '--receipt', receipt_id],
                            capture_output=True, text=True, timeout=180)
    require(result.returncode == 0, 'Canonical checker refused receipt: ' + result.stdout[-500:])
    report = json.loads(result.stdout)
    require(report.get('checked') is True and not report.get('unverifiable_references'), 'Receipt integrity is not independently verified')
    require(report.get('observed_outcome') == 'PASS' and report.get('full_case_status') == 'PASS',
            'Receipt is not complete full-case evidence')
    return digest(path)


def failed_cleanup(campaign, receipt_id, expected_hash=None):
    """Integrity-check failed observations without promoting them to a case pass."""
    path=campaign/'receipts'/(str(uuid.UUID(receipt_id))+'.json')
    require(expected_hash is None or digest(path)==expected_hash,'Failed receipt changed')
    receipt=read(path);manifest=read(campaign/'manifest.json')
    try:
        events,_=CHECKER.verify_receipt_integrity(campaign,receipt,digest(campaign/'manifest.json'),digest(campaign/'registry.json'),digest(campaign/'registration.json'))
    except CHECKER.InvalidEvidence as error:
        raise CampaignError('Failed receipt integrity refused: '+str(error)) from error
    cleanups=[event for event in events if event.get('type')=='cleanup']
    require(manifest.get('resources')==[] and receipt.get('cleanup',{}).get('resources')==[]
            and len(cleanups)==1 and cleanups[0].get('complete') is True and cleanups[0].get('resources')==[]
            and receipt['cleanup'].get('complete') is True,'Failed attempt needs verified empty-resource cleanup before retry')
    commands=[receipt['command'],receipt['cleanup'].get('command')]
    require(all(not command or not command.get('timed_out') and not command.get('leaked_descendants') and not command.get('remaining_descendants') for command in commands),'Failed attempt still has unresolved processes')
    return digest(path)


def bind_full_manifest(root, value, shared, registry_path, claims_path, variants):
    """Bind reviewed, pinned inputs to a supplied genuine native capture."""
    fields = {'schema_version', 'kind', 'feature', 'case_id', 'variant', 'registered_variant',
              'registry', 'claims', 'registration', 'inputs', 'seed', 'policy', 'approval'}
    require(isinstance(value, dict) and set(value) == fields and value['schema_version'] == 1
            and value['kind'] == 'hyperfide.source-full-case-inputs'
            and value['feature'] == 'hyperfide-source-control', 'Unsupported pinned full-case manifest')
    require(pin(root, value['registry']) == registry_path and pin(root, value['claims']) == claims_path,
            'Pinned full-case registry or claims differs from campaign')
    require(value['registered_variant'] in variants, 'Pinned full-case registration is unknown')
    registration, registered_path = variants[value['registered_variant']]
    require(pin(root, value['registration']) == registered_path and registration.get('scope') == 'full-case'
            and registration.get('cases') == [value['case_id']] and registration.get('case_variant') == value['variant'],
            'Pinned full-case registration identity differs')
    require(isinstance(value['inputs'], list) and [item.get('path') for item in value['inputs']] == registration['source_files'],
            'Pinned full-case reviewed input inventory differs')
    for item in value['inputs']:
        require(isinstance(item, dict) and set(item) == {'path', 'sha256', 'size'}, 'Exact bounded source input pin required')
        path = pin(root, {key: item[key] for key in ('path', 'sha256')})
        require(type(item['size']) is int and item['size'] == path.stat().st_size, 'Pinned source input size differs')
    native = copy.deepcopy(shared)
    native['test_inventory_sha256'] = Q.digest(Q.canonical(registration['assertion_ids']))
    Q.native_capture(root, native, registration['assertion_ids'])
    manifest = {'schema_version': 2, 'feature': value['feature'], 'native_source': native,
                'campaign_id': value['case_id'].lower() + '-' + value['variant'],
                'registered_variant': value['registered_variant'], 'scope': 'full-case',
                'case_ids': [value['case_id']], 'expected_assertion_ids': registration['assertion_ids'],
                'inputs': value['inputs'], 'resources': registration.get('resources', []),
                'approval': value['approval'], 'seed': value['seed'], 'policy': value['policy']}
    registry = read(registry_path)
    Q.validate_manifest(manifest, registration, registry)
    return manifest

def inventory_digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def receipt_inventory(root, output, files, source_roots):
    records = []
    for path in sorted({Path(name).absolute() for name in files}):
        require(not path.is_symlink(), 'Symbolic receipt inventory input: ' + str(path))
        records.append({'path': str(path), 'sha256': digest(path) if path.is_file() else None,
                        'size': path.stat().st_size if path.is_file() else None})
    return {'files': records, 'source_roots': source_roots,
            'source': Q.source_inventory(root, {'source_roots': source_roots}, output)}


def record_receipt_reuse(root, output, state):
    """Preserve receipts, but invalidate their result when any bound input changes."""
    invalid = []
    for key, entry in sorted(state['entries'].items()):
        if entry['status'] != 'PASS':
            continue
        before, after, reason = entry.get('inventory_sha256'), None, ''
        try:
            inventory = entry.get('reuse_inventory')
            require(isinstance(inventory, dict) and before == inventory_digest(inventory),
                    'Recorded receipt inventory digest is missing or inconsistent')
            current = receipt_inventory(root, output, [item['path'] for item in inventory['files']], inventory['source_roots'])
            after = inventory_digest(current)
            require(before == after, 'Affected receipt inventory digest changed')
            campaign = local(output, entry['campaign'])
            checked(campaign, entry['receipt_id'], entry['receipt_sha256'])
            require(read(campaign/'manifest.json').get('policy', {}).get('source_variant') == entry['variant'],
                    'Stored campaign input differs: manifest.json')
            require(read(campaign/'receipts'/(entry['receipt_id']+'.json')).get('case_ids') == [entry['case_id']],
                    'Stored campaign input differs: case identity')
            decision = 'REUSE'
            reason = 'Unchanged inventory digest and canonical independent checker confirm unaffected receipt'
        except (CampaignError, Q.GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
            decision, reason = 'INVALID', str(error)
            entry.update(status='INVALID', retry_safe=False, diagnostic=reason)
            invalid.append(key)
        record = {'case_id': entry['case_id'], 'variant': entry['variant'],
                  'campaign': entry['campaign'], 'receipt_id': entry['receipt_id'],
                  'receipt_sha256': entry['receipt_sha256'], 'decision': decision,
                  'previous_inventory_sha256': before, 'current_inventory_sha256': after,
                  'reason': reason}
        reference = 'reuse/' + inventory_digest(record) + '.json'
        immutable(output / reference, record)
        recorded = {'record': reference, **record}
        if recorded not in state.setdefault('reuse_records', []):
            state['reuse_records'].append(recorded)
    save(output, state)
    require(not invalid, 'Affected receipts are INVALID; historical evidence retained: ' + ', '.join(invalid))

def run(root, plan_path, output, resume=False):
    root, output = root.resolve(), output.resolve()
    require(output.is_relative_to(root) and output != root, 'Output must be inside its workspace')
    output.mkdir(parents=True, exist_ok=True)
    require(not any(path.is_symlink() for path in [output, *output.parents]), 'Symbolic output refused')
    with os.fdopen(os.open(output / '.release.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'a+b') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CampaignError('Another process owns this release campaign')
        return run_locked(root, plan_path, output, resume)


def run_locked(root, plan_path, output, resume):
    plan = read(plan_path)
    require(set(plan) == {'schema_version', 'release_id', 'registry', 'claims', 'native_source', 'entries'}
            and plan['schema_version'] == 1, 'Unsupported campaign plan')
    require(str(uuid.UUID(plan['release_id'])) == plan['release_id'], 'Canonical release UUID required')
    if resume and (output / 'state.json').is_file():
        prior = read(local(output, 'state.json'))
        require(prior.get('release_id') == plan['release_id'], 'Resume release identity differs')
        record_receipt_reuse(root, output, prior)
    registry_path, claims_path, native_path = (pin(root, plan[name]) for name in ('registry', 'claims', 'native_source'))
    registry, variants = Q.load_registry(registry_path)
    claims, shared = read(claims_path), read(native_path)
    identity = CLOSURE.source_identity({name: shared.get(name) for name in CLOSURE.IDENTITY})
    require(set(claims.get('cases', {})) == set(registry['cases']), 'Claim/case inventory differs')
    require(claims.get('schema_version') == 1, 'Unsupported claims format')
    for case, claim in claims['cases'].items():
        required = claim.get('required_variants')
        require(isinstance(required, list) and required and all(isinstance(item, str) and item and all(c.isalnum() or c == '-' for c in item) for item in required) and len(required) == len(set(required)), 'Invalid required variants: ' + case)
        require(claim.get('requirement_clauses') == registry['cases'][case].get('reqs'), 'Claim requirement clauses differ: ' + case)
        if 'full_assertion_ids' in claim:
            require(claim['full_assertion_ids'] == registry['cases'][case].get('full_assertion_ids'), 'Claim assertion inventory differs: ' + case)
    expected = {(case, variant) for case, claim in claims['cases'].items() for variant in claim['required_variants']}
    require(isinstance(plan['entries'], list), 'Explicit case/variant manifest list required')
    tools = [Path(__file__).resolve(), ROOT / 'tests/hyperfide/qualify.py',
             ROOT / 'tests/hyperfide/check-evidence.py', ROOT / 'tests/hyperfide/source-control/closure.py']
    prepared, seen, inventories, reuse_inputs, bound_manifests = [], set(), [], {}, []
    for entry in plan['entries']:
        require(isinstance(entry, dict) and set(entry) == {'case_id', 'variant', 'manifest'}, 'Exact entry required')
        key = (entry['case_id'], entry['variant'])
        require(key in expected and key not in seen, 'Unknown or duplicate required variant')
        seen.add(key)
        path = pin(root, entry['manifest'])
        manifest = read(path)
        manifest_path = path
        if manifest.get('kind') == 'hyperfide.source-full-case-inputs':
            manifest = bind_full_manifest(root, manifest, shared, registry_path, claims_path, variants)
            manifest_path = output / 'bound-manifests' / (inventory_digest(manifest)+'.json')
            bound_manifests.append((manifest_path, manifest))
        require(manifest.get('registered_variant') in variants, 'Manifest has no canonical registration')
        registration, registered_path = variants[manifest['registered_variant']]
        Q.validate_manifest(manifest, registration, registry)
        require(manifest.get('scope') == 'full-case' and manifest.get('case_ids') == [key[0]]
                and manifest.get('policy', {}).get('source_variant') == key[1],
                'Task or unrelated evidence cannot fill a full-case slot')
        actual, wanted = copy.deepcopy(manifest['native_source']), copy.deepcopy(shared)
        actual.pop('test_inventory_sha256', None)
        wanted.pop('test_inventory_sha256', None)
        require(actual == wanted, 'Manifest does not use the shared native capture')
        Q.native_capture(root, manifest['native_source'], manifest['expected_assertion_ids'])
        Q.verify_status_contracts(root,registration)
        inventory = Q.source_inventory(root, registration, output)
        source_manifest = read(local(root, shared['manifest']['path']))
        captured_paths = source_manifest.get('source_paths', {})
        captured_files = source_manifest.get('files', [])
        reviewed = {root / name for name in registration['source_files']}
        reviewed.update(Path(item['original_path']) for item in inventory)
        for reviewed_path in reviewed:
            logical = reviewed_path.relative_to(root).as_posix()
            captured = captured_paths.get(logical)
            require(isinstance(captured, dict) and captured in captured_files
                    and captured.get('sha256') == digest(reviewed_path),
                    'Shared native tree does not bind current implementation file: ' + logical)
        native_files = [shared['manifest'], shared['readiness_receipt'], *shared['toolchain'],
                        *source_manifest['files'], *read(local(root, shared['readiness_receipt']['path']))['objects']]
        reviewed.update(local(root, item['path']) for item in native_files)
        reviewed.update([registry_path, claims_path, native_path, path, registered_path, *tools])
        reuse_inputs[key] = receipt_inventory(root, output, reviewed, registration['source_roots'])
        inventories.append({'registration_sha256': digest(registered_path), 'source': inventory})
        prepared.append((entry, manifest_path, registration, registered_path))
    frozen = {'plan_sha256': digest(plan_path), 'pins': {name: plan[name] for name in ('registry', 'claims', 'native_source')},
              'inventories': inventories, 'tools': {str(path.relative_to(ROOT)): digest(path) for path in tools}}
    fingerprint = hashlib.sha256(canonical(frozen)).hexdigest()

    def unchanged():
        require(digest(plan_path) == frozen['plan_sha256'], 'Plan changed during campaign')
        for value in frozen['pins'].values():
            pin(root, value)
        for (entry, _, registration, registered_path), before in zip(prepared, inventories):
            pin(root, entry['manifest'])
            require(digest(registered_path) == before['registration_sha256']
                    and Q.source_inventory(root, registration, output) == before['source'],
                    'Implementation or registration changed during campaign')
        require(all(digest(ROOT / name) == value for name, value in frozen['tools'].items()), 'Canonical tools changed')

    if (output / 'state.json').exists():
        require(resume, 'Existing campaign requires --resume')
        state = read(local(output, 'state.json'))
        require(state.get('fingerprint') == fingerprint and state.get('release_id') == plan['release_id'],
                'Resume inputs differ from the immutable campaign')
    else:
        require(not resume, 'No campaign exists to resume')
        require(not any(path.name != '.release.lock' for path in output.iterdir()), 'Nonempty output refused')
        state = {'schema_version': 1, 'release_id': plan['release_id'], 'fingerprint': fingerprint, 'entries': {}, 'history': [], 'reuse_records': []}
        immutable(output / 'plan.json', plan)
        immutable(output / 'inputs.json', frozen)
        save(output, state)
    immutable(output / 'plan.json', plan)
    immutable(output / 'inputs.json', frozen)
    for path, manifest in bound_manifests:
        immutable(path, manifest)
    for entry, manifest_path, registration, registered_path in prepared:
        unchanged()
        key = entry['case_id'] + '/' + entry['variant']
        previous = state['entries'].get(key)
        if previous:
            require(previous.get('case_id') == entry['case_id'] and previous.get('variant') == entry['variant'], 'Stored case/variant identity changed')
            prior_campaign = local(output, previous['campaign'])
            for filename, original in [('manifest.json', manifest_path), ('registry.json', registry_path), ('registration.json', registered_path)]:
                stored = prior_campaign / filename
                if stored.exists():
                    require(digest(stored) == digest(original), 'Stored campaign input differs: ' + filename)
        if previous and previous['status'] == 'PASS':
            require(previous.get('inventory_sha256') == inventory_digest(reuse_inputs[(entry['case_id'], entry['variant'])]),
                    'Receipt inventory changed after reuse decision')
            continue
        require(not previous or previous['status'] != 'INVALID', 'Affected receipt remains INVALID: ' + key)
        if previous and previous['status'] == 'FAIL':
            if not previous.get('retry_safe'):
                continue
            failed_cleanup(local(output, previous['campaign']), previous['receipt_id'], previous['receipt_sha256'])
            prior_receipt = read(local(output, previous['campaign']) / 'receipts' / (previous['receipt_id'] + '.json'))
            require(prior_receipt.get('cleanup', {}).get('complete') is True, 'Failed attempt cleanup is unresolved')
        if previous and previous['status'] == 'RUNNING':
            campaign = local(output, previous['campaign'])
            receipts = sorted((campaign / 'receipts').glob('*.json'))
            recovered = False
            for receipt in receipts:
                try:
                    require(digest(campaign / 'manifest.json') == digest(manifest_path), 'Interrupted manifest differs')
                    receipt_hash = checked(campaign, receipt.stem)
                    previous.update(status='PASS', receipt_id=receipt.stem, receipt_sha256=receipt_hash, recovered=True)
                    save(output, state)
                    recovered = True
                    break
                except (CampaignError, OSError, ValueError):
                    continue
            if not recovered:
                previous['diagnostic'] = 'Interrupted entry has no verified receipt; reconcile its recorded process before retrying'
                save(output, state)
            continue
        attempt = output / 'attempts' / (entry['case_id'] + '-' + entry['variant']) / str(uuid.uuid4())
        attempt.mkdir(parents=True)
        campaign = attempt / 'campaign'
        record = {'case_id': entry['case_id'], 'variant': entry['variant'], 'status': 'RUNNING',
                  'attempt': attempt.relative_to(output).as_posix(), 'campaign': campaign.relative_to(output).as_posix(),
                  'reuse_inventory': reuse_inputs[(entry['case_id'], entry['variant'])],
                  'inventory_sha256': inventory_digest(reuse_inputs[(entry['case_id'], entry['variant'])])}
        state['entries'][key] = record
        state['history'].append(record)
        save(output, state)
        argv = [sys.executable, str(ROOT / 'tests/hyperfide/qualify.py'), '--root', str(root),
                '--registry', str(registry_path), '--manifest', str(manifest_path), '--output-dir', str(campaign), '--case', entry['case_id']]
        started = time.monotonic()
        with (attempt / 'stdout.log').open('x') as stdout, (attempt / 'stderr.log').open('x') as stderr:
            process = subprocess.Popen(argv, cwd=root, stdout=stdout, stderr=stderr)
            record['process_id'] = process.pid
            save(output, state)
            try:
                code = process.wait(timeout=registration.get('timeout_seconds', 60) + registration.get('cleanup_timeout_seconds', 60) + 600)
            except subprocess.TimeoutExpired:
                raise CampaignError('Qualifier exceeded its deadline; reconcile the recorded process before resuming')
        record.update(status='FAIL', exit_code=code, duration_ms=round((time.monotonic() - started) * 1000))
        try:
            summaries = [json.loads(line) for line in (attempt / 'stdout.log').read_text().splitlines() if line.startswith('{')]
            summary = summaries[-1] if summaries else {}
            if summary.get('receipt_id'):
                record['receipt_id'] = summary['receipt_id']
                if code != 0 or summary.get('status') != 'PASS':
                    record['receipt_sha256'] = failed_cleanup(campaign, record['receipt_id'])
                    record['retry_safe'] = True
            require(code == 0 and summary.get('status') == 'PASS' and summary.get('full_case_status') == 'PASS', 'Canonical qualifier did not pass')
            receipt_id = summary['receipt_id']
            record.update(status='PASS', receipt_id=receipt_id, receipt_sha256=checked(campaign, receipt_id))
        except (CampaignError, OSError, ValueError, KeyError) as error:
            record['diagnostic'] = str(error)
        unchanged()
        save(output, state)
    unchanged()
    evidence = [{name: entry[name] for name in ('case_id', 'variant', 'campaign', 'receipt_id', 'receipt_sha256')}
                for entry in sorted(state['entries'].values(), key=lambda item: (item['case_id'], item['variant'])) if entry['status'] == 'PASS']
    packet = {'schema_version': 1, 'release_id': plan['release_id'], 'source': identity,
              'registry_sha256': digest(registry_path), 'claims_sha256': digest(claims_path), 'evidence': evidence}
    immutable(output / ('closure-' + hashlib.sha256(canonical(packet)).hexdigest() + '.json'), packet)
    missing = sorted(expected - {(item['case_id'], item['variant']) for item in evidence})
    report = {'schema_version': 1, 'status': 'BLOCKED' if missing else 'PASS', 'release_id': plan['release_id'],
              'fingerprint': fingerprint, 'reuse_records': state.get('reuse_records', []), 'missing_variants': [case + '/' + variant for case, variant in missing], 'entries': sorted(state['entries'].values(), key=lambda item: (item['case_id'], item['variant']))}
    if not missing:
        immutable(output / 'closure.json', packet)
        report['closure'] = CLOSURE.verify_packet(output / 'closure.json', registry_path, claims_path)
    immutable(output / 'reports' / (hashlib.sha256(canonical(report)).hexdigest() + '.json'), report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    try:
        report = run(args.root, args.plan.resolve(), args.output, args.resume)
        print(json.dumps(report, sort_keys=True))
        return 0 if report['status'] == 'PASS' else 2
    except (CampaignError, Q.GateError, CLOSURE.ClosureError, OSError, ValueError, KeyError) as error:
        print(json.dumps({'schema_version': 1, 'status': 'BLOCKED', 'diagnostics': [str(error)]}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
