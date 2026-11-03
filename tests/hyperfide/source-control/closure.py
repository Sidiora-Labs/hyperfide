#!/usr/bin/env python3
"""Close full-case source evidence using the canonical independent checker."""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[3]
IDENTITY = ('scope', 'revision_id', 'root_tree_id', 'authority_epoch', 'policy_version')

class ClosureError(Exception):
    pass

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode()

def digest(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            result.update(chunk)
    return result.hexdigest()

def load(path):
    path = Path(path)
    if not path.is_file() or path.is_symlink() or path.stat().st_size > 16 * 1024 * 1024:
        raise ClosureError('Missing or invalid bounded JSON input: ' + str(path))
    def unique(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ClosureError('Duplicate JSON field: ' + key)
            result[key] = value
        return result
    value = json.loads(path.read_text(), object_pairs_hook=unique, parse_constant=lambda _: (_ for _ in ()).throw(ClosureError('Nonfinite JSON')))
    if not isinstance(value, dict):
        raise ClosureError('JSON document must be an object')
    return value

def require(value, message):
    if not value:
        raise ClosureError(message)

def path_from(base, value):
    require(isinstance(value, str) and value and '\x00' not in value, 'Evidence path is absent')
    path = Path(value)
    require('..' not in path.parts, 'Evidence path traverses parent directories')
    path = path if path.is_absolute() else Path(base) / path
    require(not any(part.is_symlink() for part in [path, *path.parents]), 'Symbolic evidence path is forbidden')
    return path

def source_identity(value):
    require(isinstance(value, dict) and set(value) == set(IDENTITY), 'Exact native source identity required')
    scope = value['scope']
    require(isinstance(scope, dict) and set(scope) == {'organisation_id', 'repository_id', 'security_domain_id'}, 'Native source scope required')
    for item in [*scope.values(), value['authority_epoch']]:
        require(isinstance(item, str) and str(uuid.UUID(item)) == item, 'Canonical source authority UUID required')
    for field in ('revision_id', 'root_tree_id'):
        require(isinstance(value[field], str) and re.fullmatch(r'sha256:[0-9a-f]{64}', value[field]), 'Native revision and root digests required')
    require(isinstance(value['policy_version'], str) and value['policy_version'].strip(), 'Source policy version required')
    return value

def verify_packet(packet_path, registry_path=None, claims_path=None):
    packet_path = Path(packet_path).resolve()
    registry_path = Path(registry_path or ROOT / 'tests/hyperfide/source-control/registry.json').resolve()
    claims_path = Path(claims_path or ROOT / 'tests/hyperfide/source-control/claims.json').resolve()
    packet, registry, claims = load(packet_path), load(registry_path), load(claims_path)
    require(set(packet) == {'schema_version', 'release_id', 'source', 'registry_sha256', 'claims_sha256', 'evidence'}, 'Closure packet fields differ from version 1')
    require(type(packet['schema_version']) is int and packet['schema_version'] == 1, 'Unsupported closure packet version')
    require(str(uuid.UUID(packet['release_id'])) == packet['release_id'], 'Canonical release UUID required')
    source = source_identity(packet['source'])
    require(packet['registry_sha256'] == digest(registry_path), 'Closure registry is stale')
    require(packet['claims_sha256'] == digest(claims_path), 'Closure claims are stale')
    require(registry.get('schema_version') == 2 and isinstance(registry.get('cases'), dict) and registry['cases'], 'Native case registry required')
    require(claims.get('schema_version') == 1 and set(claims.get('cases', {})) == set(registry['cases']), 'Claims must cover every canonical case')
    expected, assertion_owner = set(), {}
    for case_id, case in registry['cases'].items():
        claim = claims['cases'][case_id]
        require(claim.get('requirement_clauses') == case.get('reqs') and bool(claim.get('requirement_clauses')), 'Claim requirement inventory differs: ' + case_id)
        variants, assertions = claim.get('required_variants'), case.get('full_assertion_ids')
        require(isinstance(variants, list) and variants and len(set(variants)) == len(variants), 'Required variants are absent or duplicated: ' + case_id)
        require(isinstance(assertions, list) and assertions and len(set(assertions)) == len(assertions), 'Full assertion inventory is absent or duplicated: ' + case_id)
        for assertion in assertions:
            require(isinstance(assertion, str) and assertion and assertion not in assertion_owner, 'Assertion is reused to fill multiple case obligations')
            assertion_owner[assertion] = case_id
        expected.update((case_id, variant) for variant in variants)
    records = packet['evidence']
    require(isinstance(records, list), 'Evidence list required')
    actual, receipts, checked = set(), set(), []
    for record in records:
        require(isinstance(record, dict) and set(record) == {'case_id', 'variant', 'campaign', 'receipt_id', 'receipt_sha256'}, 'Exact evidence reference required')
        key = (record['case_id'], record['variant'])
        require(key in expected and key not in actual, 'Unknown or duplicate case variant')
        require(record['receipt_id'] not in receipts, 'One receipt cannot fill multiple variant obligations')
        actual.add(key); receipts.add(record['receipt_id'])
    missing = sorted(expected - actual)
    require(not missing, 'Missing required source case variants: ' + ', '.join(case + '/' + variant for case, variant in missing))
    for record in records:
        campaign = path_from(packet_path.parent, record['campaign'])
        require(str(uuid.UUID(record['receipt_id'])) == record['receipt_id'], 'Canonical evidence receipt UUID required')
        receipt_path = campaign / 'receipts' / (record['receipt_id'] + '.json')
        require(record['receipt_sha256'] == digest(receipt_path), 'Evidence receipt hash differs')
        receipt, manifest = load(receipt_path), load(campaign / 'manifest.json')
        require(receipt.get('scope') == 'full-case' and receipt.get('full_case_status') == 'PASS', 'Component evidence cannot close a full case')
        require(receipt.get('case_ids') == [record['case_id']], 'Receipt must identify its exact canonical case')
        require(receipt.get('expected_assertion_ids') == registry['cases'][record['case_id']]['full_assertion_ids'], 'Full case assertion inventory differs')
        require(manifest.get('policy', {}).get('source_variant') == record['variant'], 'Evidence backend/provider variant differs')
        captured = receipt.get('source', {}).get('native')
        require(isinstance(captured, dict) and {field: captured.get(field) for field in IDENTITY} == source, 'Evidence source or policy is stale')
        command = [sys.executable, '-I', str(ROOT / 'tests/hyperfide/check-evidence.py'), '--campaign', str(campaign), '--receipt', record['receipt_id']]
        result = subprocess.run(command, capture_output=True, text=True, timeout=120)
        require(result.returncode == 0, 'Independent evidence checker refused ' + record['case_id'] + ': ' + result.stdout[-600:])
        report = json.loads(result.stdout)
        require(report.get('checked') is True and report.get('observed_outcome') == 'PASS' and report.get('full_case_status') == 'PASS' and report.get('receipt_sha256') == record['receipt_sha256'], 'Independent checker did not confirm exact evidence')
        require(not report.get('unverifiable_references'), 'Evidence has unverifiable references')
        checked.append({'case_id': record['case_id'], 'variant': record['variant'], 'receipt_id': record['receipt_id'], 'receipt_sha256': record['receipt_sha256']})
    missing = sorted(expected - actual)
    require(not missing, 'Missing required source case variants: ' + ', '.join(case + '/' + variant for case, variant in missing))
    return {'schema_version': 1, 'status': 'PASS', 'release_id': packet['release_id'], 'source': source, 'packet_sha256': digest(packet_path), 'registry_sha256': digest(registry_path), 'claims_sha256': digest(claims_path), 'checked_evidence': checked}

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--packet', required=True)
    parser.add_argument('--registry')
    parser.add_argument('--claims')
    args = parser.parse_args()
    try:
        print(json.dumps(verify_packet(args.packet, args.registry, args.claims), sort_keys=True))
    except (ClosureError, ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({'schema_version': 1, 'status': 'BLOCKED', 'diagnostics': [str(error)]}))
        raise SystemExit(2)
