#!/usr/bin/env python3
"""Aggregate current layout evidence, refusing incomplete or stale qualification."""
from pathlib import Path
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
PACK = ROOT / 'spec/hyperfide-source-control'
OUT = ROOT / 'build/layout/0.9'
LAYOUT_REVISION = 'fc5ea53bb00d659196c9fceee62fae75720fa22c'
REQUIRED = {
    '0.4': ['root-workspace-membership', 'pinned-frozen-install', 'root-nested-discovery', 'dependency-resolution-conservation'],
    '0.5': ['native-frontdoor-and-components', 'control-schema-component-bootstrap', 'core-runtime', 'installed-cli-discovery'],
    '0.6': ['sdk-plugin-consumers', 'public-exports', 'test-membership', 'cold-warm-cache-invalidation'],
    '0.7': ['web-server-host-startup', 'desktop-mobile-packaging', 'plugin-scaffold-consumer', 'vsix-packaging', 'assets-bins-plugin-identities'],
    '0.8': ['ci-category-routing', 'prepared-image-generation', 'nonpublishing-release-assembly', 'installed-service-startup', 'source-stamp-and-privacy-boundary'],
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def capture_bindings():
    mapping = document(PACK / 'repository-layout.json')
    paths = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    snapshot = {}
    for name in sorted(set(paths) - {''}):
        if name.startswith(('docs/', 'spec/', 'tests/')) or name.endswith('.md'):
            continue
        source = ROOT / name
        if source.is_symlink():
            snapshot[name] = {'mode': '120000', 'sha256': hashlib.sha256(os.readlink(source).encode()).hexdigest()}
        elif source.is_file():
            snapshot[name] = {'mode': '100755' if source.stat().st_mode & 0o111 else '100644', 'sha256': digest(source)}
    return {
        'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_tree_id': subprocess.check_output(['git', 'rev-parse', 'HEAD^{tree}'], cwd=ROOT, text=True).strip(),
        'mapping_sha256': digest(PACK / 'repository-layout.json'),
        'layout_generation': mapping['layout_generation'],
        'source_snapshot': snapshot,
        'source_snapshot_sha256': canonical_digest(snapshot),
    }


def local(value):
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value or any(part in {'', '.', '..'} for part in value.split('/')):
        raise ValueError('Evidence paths must be canonical repository-relative paths')
    path = ROOT / value
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT):
        raise ValueError('Evidence must resolve to an existing ordinary repository file: ' + value)
    return path


def document(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate evidence key: ' + key)
            result[key] = value
        return result
    result = json.loads(path.read_text(), object_pairs_hook=pairs)
    if not isinstance(result, dict):
        raise ValueError('Evidence object required')
    return result


def reference(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': digest(path)}


def evidence_documents(value):
    names = [value] if isinstance(value, str) else value
    if not isinstance(names, list) or not names or any(not isinstance(name, str) for name in names) or len(set(names)) != len(names):
        raise ValueError('Evidence requires a file or unique explicit file list')
    return [(local(name), document(local(name))) for name in names]


def status_input_derivation(receipt):
    """Accept only an exact raw spec snapshot with existing status-value changes."""
    declarations = receipt.get('status_contracts', [])
    if not isinstance(declarations, list) or len(declarations) > 1:
        raise ValueError('Invalid layout status derivation inventory')
    if not declarations:
        return None
    item = declarations[0]
    if not isinstance(item, dict) or set(item) != {'path', 'snapshot', 'mode'} or item['path'] != 'spec/hyperfide-source-control/spec.kvx' or item['mode'] != 'kvx-existing-status-values-v1' or not isinstance(item['snapshot'], str):
        raise ValueError('Unsupported layout status derivation')
    match = re.fullmatch(r'build/layout/0\.9/status-snapshots/([0-9a-f]{64})\.kvx', item['snapshot'])
    if not match:
        raise ValueError('Layout status snapshot must be content addressed')
    snapshot, active = local(item['snapshot']), local(item['path'])
    if any(path.resolve() != path or path.stat().st_size > 4 * 1024 * 1024 for path in [snapshot, active]):
        raise ValueError('Unsafe layout status snapshot or source')
    expected = match[1]
    if digest(snapshot) != expected:
        raise ValueError('Layout status raw snapshot digest differs')
    spec = importlib.util.spec_from_file_location('layout_status_contract', Path(__file__).resolve().parents[2] / 'qualify.py')
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    try:
        equivalent = validator.status_projection(snapshot.read_bytes()) == validator.status_projection(active.read_bytes())
    except (validator.GateError, UnicodeError) as error:
        raise ValueError('Invalid layout status-only source') from error
    if not equivalent:
        raise ValueError('Layout source changed beyond existing status values')
    commands = receipt.get('commands', [])
    if not isinstance(commands, list) or any(not isinstance(command, dict) or not isinstance(command.get('inputs'), dict) for command in commands):
        raise ValueError('Layout status derivation requires typed command inputs')
    bound = [command for command in commands if item['path'] in command['inputs']]
    if not bound or any(command['inputs'][item['path']] != expected or command['inputs'].get(item['snapshot']) != expected for command in bound):
        raise ValueError('Layout status snapshot must equal every recorded raw source input')
    return item['path'], expected


def validate_execution(receipt, required=(), required_input=None):
    commands, assertions = receipt.get('commands'), receipt.get('assertions')
    status_derivation = status_input_derivation(receipt)
    if not isinstance(commands, list) or not commands or not isinstance(assertions, list) or not assertions:
        raise ValueError('Actual command and assertion inventories are required')
    ids = set()
    for command in commands:
        if not isinstance(command, dict) or not isinstance(command.get('id'), str) or not command['id'] or command['id'] in ids:
            raise ValueError('Each executed command requires a distinct identity')
        ids.add(command['id'])
        if command.get('exit_code') != 0 or not isinstance(command.get('command'), list) or not command['command'] or any(not isinstance(arg, str) or not arg for arg in command['command']):
            raise ValueError('Executed argument vector and zero exit code required')
        if not isinstance(command.get('duration_ms'), int) or command['duration_ms'] < 0:
            raise ValueError('Observed command duration required')
        if digest(local(command.get('log'))) != command.get('log_sha256'):
            raise ValueError('Command log digest differs')
        inputs = command.get('inputs')
        if not isinstance(inputs, dict) or not inputs:
            raise ValueError('Command input identities are required')
        for name, expected in inputs.items():
            if digest(local(name)) != expected and status_derivation != (name, expected):
                raise ValueError('Command input changed: ' + name)
    observed = {}
    for assertion in assertions:
        if not isinstance(assertion, dict) or assertion.get('status') != 'PASS' or assertion.get('command_id') not in ids or not isinstance(assertion.get('id'), str) or assertion['id'] in observed:
            raise ValueError('Assertions must identify one successful executed command')
        observed[assertion['id']] = assertion
    missing = set(required) - set(observed)
    if missing:
        raise ValueError('Missing required assertions: ' + ', '.join(sorted(missing)))
    if required_input:
        referenced = {observed[ident]['command_id'] for ident in required}
        if not referenced or not any(required_input in command['inputs'] for command in commands if command['id'] in referenced):
            raise ValueError('Repair verification does not bind its actual repaired source input')
    return commands, set(observed)


def repair_verification(item, bindings):
    proof = item.get('verification')
    ids = item.get('verification_assertions')
    if not isinstance(proof, dict) or not isinstance(ids, list) or not ids or any(not isinstance(ident, str) or not ident for ident in ids):
        raise ValueError('Forward repair needs explicit executed verification and assertion identities')
    path = local(proof.get('path'))
    if digest(path) != proof.get('sha256'):
        raise ValueError('Forward repair verification receipt changed')
    receipt = document(path)
    revision = receipt.get('source_revision')
    if receipt.get('schema_version') != 1 or receipt.get('status') != 'PASS' or not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', revision):
        raise ValueError('Passing versioned repair execution receipt and qualifying revision required')
    if subprocess.run(['git', 'merge-base', '--is-ancestor', revision, bindings['source_revision']], cwd=ROOT, capture_output=True).returncode:
        raise ValueError('Repair execution revision is not an ancestor of the candidate')
    validate_execution(receipt, ids, item['target'])
    return {'receipt': reference(path), 'qualifying_revision': revision, 'assertions': ids}


def task_receipt(task, path, bindings):
    receipt = document(path)
    if receipt.get('schema_version') != 1 or receipt.get('task') != task or receipt.get('status') != 'PASS':
        raise ValueError('A passing versioned task receipt is required')
    for key in ['mapping_sha256', 'layout_generation', 'source_snapshot_sha256']:
        if receipt.get(key) != bindings[key]:
            raise ValueError('Stale task receipt binding: ' + key)
    revision = receipt.get('source_revision')
    if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', revision):
        raise ValueError('Exact qualifying source revision required')
    if subprocess.run(['git', 'merge-base', '--is-ancestor', revision, bindings['source_revision']], cwd=ROOT, capture_output=True).returncode:
        raise ValueError('Qualifying revision is not an ancestor of the current candidate')
    tree = subprocess.check_output(['git', 'rev-parse', revision + '^{tree}'], cwd=ROOT, text=True).strip()
    if receipt.get('source_tree_id') != tree or receipt.get('source_snapshot') != bindings['source_snapshot'] or canonical_digest(receipt['source_snapshot']) != receipt['source_snapshot_sha256']:
        raise ValueError('Qualifying runtime input snapshot changed')
    commands, observed = validate_execution(receipt, REQUIRED[task])
    artifacts = receipt.get('artifacts', [])
    if not isinstance(artifacts, list):
        raise ValueError('Artifact inventory must be an array')
    for artifact in artifacts:
        if not isinstance(artifact, dict) or digest(local(artifact.get('path'))) != artifact.get('sha256'):
            raise ValueError('Artifact is missing or changed')
    if task == '0.8':
        image = receipt.get('prepared_image')
        if not isinstance(image, dict) or image.get('layout_generation') != bindings['layout_generation'] or not isinstance(image.get('identity'), str) or not image['identity'] or not re.fullmatch(r'[0-9a-f]{64}', str(image.get('manifest_sha256', ''))):
            raise ValueError('Qualified prepared-image identity and layout-generation binding required')
        if digest(local(image.get('manifest'))) != image['manifest_sha256']:
            raise ValueError('Prepared-image manifest changed')
    return {'receipt': reference(path), 'qualifying_revision': revision, 'source_snapshot_sha256': receipt['source_snapshot_sha256'], 'commands': len(commands), 'assertions': sorted(observed), 'artifacts': artifacts, **({'prepared_image': receipt['prepared_image']} if 'prepared_image' in receipt else {})}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, default=OUT / 'inputs.json')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'schema_version': 1, 'task': '0.9', 'case': 'SCM-025', 'status': 'BLOCKED', 'case_qualification': 'UNRUN', 'checked_at': datetime.now(timezone.utc).isoformat(), 'checks': [], 'missing_evidence': [], 'regressions': [], 'task_receipts': {}, 'exclusions': [], 'required_assertions': REQUIRED}
    def check(ident, passed, evidence):
        report['checks'].append({'id': ident, 'status': 'PASS' if passed else 'FAIL', 'evidence': evidence})
    try:
        mapping = document(PACK / 'repository-layout.json')
        bindings = capture_bindings()
        source_revision = bindings['source_revision']
        status = subprocess.check_output(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd=ROOT)
        report['bindings'] = {'baseline_revision': mapping['implementation_baseline'], **bindings, 'worktree_status_sha256': hashlib.sha256(status).hexdigest()}
        check('source.final-revision-clean', not status, {'source_revision': source_revision, 'worktree_status_sha256': report['bindings']['worktree_status_sha256']})
        baseline_path = ROOT / 'build/layout/0.3/receipt.json'
        baseline_receipt = document(baseline_path)
        baseline_inventory_path = local(baseline_receipt['inventory'])
        baseline = document(baseline_inventory_path)
        valid_baseline = baseline_receipt.get('status') == 'PASS' and baseline_receipt.get('revision') == mapping['implementation_baseline'] and baseline_receipt.get('mapping_sha256') == report['bindings']['mapping_sha256'] and baseline_receipt.get('inventory_sha256') == digest(baseline_inventory_path) and baseline.get('revision') == mapping['implementation_baseline']
        check('source.frozen-baseline', valid_baseline, reference(baseline_path))
        if not valid_baseline:
            raise ValueError('Frozen baseline receipt is missing or changed')
        history_spec = importlib.util.spec_from_file_location('layout_historical_verification', Path(__file__).with_name('0_3_history.py'))
        history = importlib.util.module_from_spec(history_spec)
        history_spec.loader.exec_module(history)
        check('source.historical-baseline-verified', True, history.validate_verification())
        spec = importlib.util.spec_from_file_location('layout_final_inventory', ROOT / 'tools/repository/layout-inventory.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        current = module.generate_inventory(ROOT, mapping, source_revision)
        inventory_path = OUT / 'inventory.json'
        inventory_path.write_text(json.dumps(current, indent=2) + '\n')
        report['bindings']['source_inventory_sha256'] = digest(inventory_path)
        check('source.current-inventory', current['valid'], reference(inventory_path))
        obsolete = [name for name in ['platform', 'services', 'src', 'scripts', 'kvx', 'editors'] if (ROOT / name).exists()]
        check('source.no-old-containers', not obsolete, obsolete)
        inputs = document(args.inputs) if args.inputs.is_file() else {}
        if not inputs:
            report['missing_evidence'].append({'kind': 'aggregation-input', 'path': str(args.inputs.relative_to(ROOT)), 'required_fields': ['schema_version', 'layout_revision', 'authorized_followon_revisions', 'task_receipts', 'rewrite_dispositions']})
        elif inputs.get('schema_version') != 1 or not isinstance(inputs.get('task_receipts'), dict):
            raise ValueError('Versioned aggregation input and task_receipts map required')
        layout_revision = inputs.get('layout_revision', LAYOUT_REVISION)
        if not isinstance(layout_revision, str) or not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', layout_revision) or subprocess.run(['git', 'merge-base', '--is-ancestor', layout_revision, source_revision], cwd=ROOT, capture_output=True).returncode:
            raise ValueError('Exact original layout revision must be an ancestor of the current candidate')
        if subprocess.run(['git', 'merge-base', '--is-ancestor', mapping['implementation_baseline'], layout_revision], cwd=ROOT, capture_output=True).returncode:
            raise ValueError('Layout revision does not descend from the frozen implementation baseline')
        layout = module.generate_inventory(ROOT, mapping, layout_revision)
        layout_inventory_path = OUT / 'layout-inventory.json'
        layout_inventory_path.write_text(json.dumps(layout, indent=2) + '\n')
        report['bindings']['layout_revision'] = layout_revision
        report['bindings']['layout_inventory_sha256'] = digest(layout_inventory_path)
        commits = subprocess.check_output(['git', 'rev-list', '--reverse', layout_revision + '..' + source_revision], cwd=ROOT, text=True).splitlines()
        allowed_followon = inputs.get('authorized_followon_revisions', [])
        if not isinstance(allowed_followon, list) or len(set(allowed_followon)) != len(allowed_followon) or any(not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', value) for value in allowed_followon):
            raise ValueError('Authorized follow-on revisions must be an explicit unique full-commit allowlist')
        followon = []
        for revision in commits:
            raw = subprocess.check_output(['git', 'diff-tree', '--root', '-r', '--raw', '--no-renames', '-z', '--no-commit-id', revision], cwd=ROOT).split(b'\0')
            changes = []
            for index in range(0, len(raw) - 1, 2):
                metadata = raw[index].decode().split()
                if len(metadata) != 5 or not metadata[0].startswith(':'):
                    raise ValueError('Unsupported follow-on Git change framing')
                changes.append({'path': raw[index + 1].decode(), 'before_mode': metadata[0][1:], 'after_mode': metadata[1], 'before_blob': metadata[2], 'after_blob': metadata[3], 'status': metadata[4]})
            followon.append({'revision': revision, 'authorized': revision in allowed_followon, 'changes': changes})
            if revision not in allowed_followon:
                report['missing_evidence'].append({'kind': 'follow-on-authorization', 'revision': revision, 'changed_paths': len(changes)})
        if set(allowed_followon) - set(commits):
            report['regressions'].append('Follow-on authorization contains a revision outside the actual layout-to-candidate ancestry')
        followon_path = OUT / 'follow-on-inventory.json'
        followon_path.write_text(json.dumps(followon, indent=2) + '\n')
        report['follow_on_inventory'] = reference(followon_path)
        baseline_files = {item['source']: item for item in baseline['files']}
        layout_files = {item['source']: item for item in layout['files']}
        final_files = {item['source']: item for item in current['files']}
        dispositions, flags, review_refs, repair_documents = {}, {}, [], []
        for review_path, review in evidence_documents(inputs['rewrite_dispositions']) if inputs.get('rewrite_dispositions') else []:
            if review.get('schema_version') != 1 or review.get('source_revision') != layout_revision or review.get('mapping_sha256') != report['bindings']['mapping_sha256'] or not isinstance(review.get('rewrites'), list):
                raise ValueError('Rewrite reviews must bind the original layout revision and frozen mapping')
            review_refs.append(reference(review_path))
            for item in review['rewrites']:
                if not isinstance(item, dict) or not all(isinstance(item.get(key), str) and item[key] for key in ['source', 'target', 'before_blob', 'after_blob', 'reason', 'evidence_task']):
                    raise ValueError('Exact rewrite identities, reason and owning evidence task required')
                key = (item['source'], item['target'], item['before_blob'], item['after_blob'])
                if item.get('diff') and digest(local(item['diff'])) != item.get('diff_sha256'):
                    raise ValueError('Historical rewrite diff changed')
                dispositions.setdefault(key, item)
            for item in review.get('flagged', []) + review.get('flagged_rewrites', []):
                if not isinstance(item, dict) or not all(isinstance(item.get(key), str) and item[key] for key in ['source', 'target', 'before_blob', 'after_blob', 'reason']):
                    raise ValueError('Semantic flags require exact historical identities and observed reasons')
                key = (item['source'], item['target'], item['before_blob'], item['after_blob'])
                flags[key] = item
            for item in review.get('existing_mapped_follow_on_repairs', []):
                key = (item['source'], item['target'], item.get('before_blob', item.get('baseline_blob')), item['layout_blob'])
                flags[key] = dict(item, before_blob=key[2], after_blob=key[3])
            if any(review.get(key) for key in ['repairs', 'forward_repairs', 'existing_mapped_follow_on_repairs']):
                repair_documents.append((review_path, review))
        report['rewrite_dispositions'] = review_refs
        if inputs.get('forward_repairs'):
            repair_documents.extend(evidence_documents(inputs['forward_repairs']))
        repairs, repair_rows, repair_refs = {}, {}, []
        for repair_path, repair_document in repair_documents:
            pinned_layout = repair_document.get('layout_revision', repair_document.get('historic_layout_revision', repair_document.get('source_revision')))
            if pinned_layout != layout_revision or repair_document.get('mapping_sha256') != report['bindings']['mapping_sha256']:
                raise ValueError('Forward repairs must bind the actual original layout and mapping')
            repair_refs.append(reference(repair_path))
            entries = repair_document.get('repairs', []) + repair_document.get('forward_repairs', []) + repair_document.get('existing_mapped_follow_on_repairs', [])
            for raw in entries:
                item = dict(raw)
                item['before_blob'] = raw.get('before_blob', raw.get('historic_before_blob', raw.get('baseline_blob')))
                item['layout_blob'] = raw.get('layout_blob', raw.get('historic_after_blob'))
                item['after_blob'] = raw.get('after_blob', raw.get('current_fixed_blob', raw.get('current_blob')))
                if not all(isinstance(item.get(key), str) and item[key] for key in ['source', 'target', 'before_blob', 'after_blob', 'reason', 'evidence_task']):
                    raise ValueError('Forward repair requires exact baseline/layout/current identities and owning evidence')
                original, actual = baseline_files.get(item['source']), final_files.get(item['target'])
                historic = layout_files.get(item['target'])
                item['mode'] = raw.get('mode', original['mode'] if original else None)
                if not original or original['target'] != item['target'] or not actual or item['before_blob'] != original['object_id'] or item['after_blob'] != actual['object_id'] or item['mode'] != original['mode'] or actual['mode'] != original['mode'] or item['layout_blob'] != (historic['object_id'] if historic else None):
                    report['missing_evidence'].append({'kind':'forward-repair-current-binding','source':item['source'],'target':item['target'],'detail':'Exact baseline/layout/current blobs or modes differ','recorded_after_blob':item['after_blob'],'current_after_blob':actual['object_id'] if actual else None})
                    continue
                previous = repair_rows.get(item['source'])
                if previous and any(previous[key] != item[key] for key in ['target', 'before_blob', 'layout_blob', 'after_blob', 'mode']):
                    raise ValueError('Conflicting forward repair identities')
                if previous and previous.get('verification') and not item.get('verification'):
                    continue
                repair_rows[item['source']] = item
        report['forward_repairs'] = repair_refs
        for source, item in repair_rows.items():
            historic_key = (source, item['target'], item['before_blob'], item['layout_blob'])
            approved_historic = dispositions.get(historic_key)
            additional_consumer = item.get('repair_kind') == 'ADDITIONAL_MAPPED_CONSUMER_REPAIR' and (item['layout_blob'] == item['before_blob'] or approved_historic is not None and approved_historic['evidence_task'] in REQUIRED and historic_key not in flags)
            if item['layout_blob'] is not None and historic_key not in flags and not additional_consumer:
                report['missing_evidence'].append({'kind': 'forward-repair-semantic-flag', 'source': source, 'target': item['target']})
                continue
            try:
                item['execution'] = repair_verification(item, report['bindings'])
                repairs[source] = item
            except (OSError, ValueError, KeyError, TypeError) as error:
                report['missing_evidence'].append({'kind': 'forward-repair-verification', 'source': source, 'target': item['target'], 'detail': str(error)})
        report['semantic_flags'] = []
        for key, item in flags.items():
            repair = repairs.get(key[0])
            resolved = bool(repair and (repair['target'], repair['before_blob'], repair['layout_blob']) == key[1:])
            report['semantic_flags'].append({'source': key[0], 'target': key[1], 'before_blob': key[2], 'layout_blob': key[3], 'reason': item['reason'], 'status': 'FORWARD_REPAIRED' if resolved else 'UNRESOLVED', **({'repair': repair} if resolved else {})})
            if not resolved:
                report['missing_evidence'].append({'kind': 'semantic-flag-unresolved', 'source': key[0], 'target': key[1], 'reason': item['reason']})
        after_files = {item['source']: item for item in layout['files']}
        approved = set()
        changes = []
        for item in baseline['files']:
            actual = after_files.get(item['target'])
            if actual and item['object_id'] != actual['object_id']:
                key = (item['source'], item['target'], item['object_id'], actual['object_id'])
                changes.append({'source': key[0], 'target': key[1], 'before_blob': key[2], 'after_blob': key[3], 'disposition': dispositions.get(key)})
                if (key in dispositions and dispositions[key]['evidence_task'] in REQUIRED and key not in flags) or (item['source'] in repairs and repairs[item['source']]['layout_blob'] == actual['object_id']):
                    approved.add(f'content rewrite requires explicit disposition: {key[0]} -> {key[1]} ({key[2]} -> {key[3]})')
        for error in module.compare_inventories(baseline, layout, pinned_only=True):
            if error in approved:
                continue
            if any(item['layout_blob'] is None and error == f'missing mapped file: {item["source"]} -> {item["target"]}' for item in repairs.values()):
                continue
            if error.startswith('content rewrite requires explicit disposition:'):
                report['missing_evidence'].append({'kind': 'rewrite-disposition', 'detail': error})
            else:
                report['regressions'].append(error)
        for task, assertions in REQUIRED.items():
            name = inputs.get('task_receipts', {}).get(task)
            if not name:
                report['missing_evidence'].append({'kind': 'task-runtime-receipt', 'task': task, 'driver': f'tests/hyperfide/cases/source_control/{task.replace(".", "_")}.py', 'assertions': assertions})
                continue
            try:
                report['task_receipts'][task] = task_receipt(task, local(name), report['bindings'])
            except (OSError, ValueError, KeyError, TypeError) as error:
                report['missing_evidence'].append({'kind': 'invalid-task-runtime-receipt', 'task': task, 'detail': str(error)})
        if (set(dispositions) | set(flags)) - {(item['source'], item['target'], item['before_blob'], item['after_blob']) for item in changes}:
            report['regressions'].append('Rewrite disposition contains identities outside the actual baseline comparison')
        for key, item in dispositions.items():
            if item['evidence_task'] not in report['task_receipts']:
                report['missing_evidence'].append({'kind': 'rewrite-owner-receipt', 'source': key[0], 'task': item['evidence_task']})
        for source, item in repairs.items():
            if item['evidence_task'] not in report['task_receipts']:
                report['missing_evidence'].append({'kind': 'forward-repair-owner-receipt', 'source': source, 'task': item['evidence_task']})
        (OUT / 'rewrite-inventory.json').write_text(json.dumps(changes, indent=2) + '\n')
        report['summary'] = {'baseline_files': len(baseline['files']), 'layout_files': len(layout['files']), 'current_files': len(current['files']), 'changed_mapped_blobs': len(changes), 'approved_rewrites': len(approved), 'packages': len(current['packages']), 'runtime_receipts': len(report['task_receipts']), 'follow_on_commits': len(followon), 'forward_repairs': len(repairs)}
        report['rollback'] = {'baseline_revision': mapping['implementation_baseline'], 'mapping': reference(PACK / 'repository-layout.json'), 'inverse_inventory': reference(baseline_inventory_path), 'policy': 'Preserve subsequent work; selecting the original tree is not an authorized destructive rollback.'}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        report['missing_evidence'].append({'kind': 'driver-input', 'detail': str(error)})
    failed_checks = [item['id'] for item in report['checks'] if item['status'] != 'PASS']
    report['status'] = 'FAIL' if report['regressions'] else 'BLOCKED' if report['missing_evidence'] or failed_checks else 'PASS'
    if report['status'] == 'PASS':
        report['case_qualification'] = 'PASS'
    (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'task': '0.9', 'status': report['status'], 'checks': len(report['checks']), 'missing_evidence': len(report['missing_evidence']), 'regressions': len(report['regressions']), 'receipt': 'build/layout/0.9/receipt.json'}))
    return 0 if report['status'] == 'PASS' else 2 if report['status'] == 'BLOCKED' else 1


if __name__ == '__main__':
    raise SystemExit(main())
