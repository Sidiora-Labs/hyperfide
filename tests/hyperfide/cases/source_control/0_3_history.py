#!/usr/bin/env python3
"""Verify preserved pre-relocation evidence; never recapture historical tools."""
from pathlib import Path, PurePosixPath
import hashlib
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[4]
ARCHIVE = Path('build/layout/0.3-preserved-original')
OUT = ROOT / 'build/layout/0.3-historical-verification'
RECEIPT = Path('build/layout/0.3/receipt.json')
RECEIPT_SHA = 'cdae79a776ea59fb8874a9f09ab394d121a6f883dfc1d541f5f4b563176f4372'
MANIFEST_SHA = '76c0b40aa5011f31796e7b9849bb3af90d58ef17420850c56dfc7aef824ee2a9'
GENERATOR_REV = 'e20e190712e4467e363b0e10864b2edc5ab6e012'
GENERATOR_SHA = 'c4953d88e00df31bb9ae8d05b6ff730619b64185939051ae0992edd4ccc40ac3'
DRIVER = Path('tests/hyperfide/cases/source_control/0_3.py')
MAPPING = Path('spec/hyperfide-source-control/repository-layout.json')
SCOPE = 'Verification of preserved historical inventory, mapping and baseline observations; no current build/runtime qualification'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def require(value, code):
    if not value:
        raise ValueError(code)


def local(root, name):
    path = Path(name)
    require(not path.is_absolute() and '..' not in path.parts, 'HISTORICAL_PATH_REQUIRED')
    result = root / path
    require(result.is_file() and not result.is_symlink() and result.resolve().is_relative_to(root.resolve()), 'HISTORICAL_FILE_MISSING:' + name)
    return result


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def frozen_inputs(root=ROOT):
    manifest_path = local(root, str(ARCHIVE / 'manifest.json'))
    require(sha(manifest_path) == MANIFEST_SHA, 'HISTORICAL_MANIFEST_CHANGED')
    manifest = json.loads(manifest_path.read_text())
    require(len(manifest['files']) == 14, 'HISTORICAL_FILE_SET_CHANGED')
    inputs = {str(ARCHIVE / 'manifest.json'): MANIFEST_SHA}
    for entry in manifest['files']:
        stored = local(root, entry['copy'])
        require(sha(stored) == entry['sha256'], 'HISTORICAL_ARCHIVE_CHANGED:' + entry['original'])
        inputs[entry['copy']] = entry['sha256']
        if entry['original'] != str(DRIVER):
            original = local(root, entry['original'])
            require(sha(original) == entry['sha256'], 'HISTORICAL_ORIGINAL_CHANGED:' + entry['original'])
            inputs[entry['original']] = entry['sha256']
    original = local(root, str(RECEIPT))
    require(sha(original) == RECEIPT_SHA, 'HISTORICAL_RECEIPT_CHANGED')
    receipt = json.loads(original.read_text())
    require(receipt['status'] == 'PASS' and receipt['case_qualification'] == 'UNRUN', 'HISTORICAL_SCOPE_CHANGED')
    require(len(receipt['assertions']) == 22 and all(v is True for v in receipt['assertions'].values()), 'HISTORICAL_ASSERTIONS_CHANGED')
    for field in ['inventory', 'baseline']:
        require(sha(local(root, receipt[field])) == receipt[field + '_sha256'], 'HISTORICAL_' + field.upper() + '_CHANGED')
    baseline = json.loads(local(root, receipt['baseline']).read_text())
    require(len(baseline['probes']) == 10, 'HISTORICAL_PROBE_SET_CHANGED')
    for name, probe in baseline['probes'].items():
        require(sha(local(root, probe['log'])) == probe['log_sha256'], 'HISTORICAL_PROBE_LOG_CHANGED:' + name)
        require(probe['status'] == ('OBSERVED' if probe['exit_code'] == 0 else 'UNAVAILABLE_OR_FAILED'), 'HISTORICAL_PROBE_STATUS_CHANGED:' + name)
        require(isinstance(probe['command'], list) and probe['command'], 'HISTORICAL_PROBE_COMMAND_CHANGED:' + name)
    generator = local(root, str(ARCHIVE / 'original-generator.py'))
    require(sha(generator) == GENERATOR_SHA, 'HISTORICAL_GENERATOR_CHANGED')
    inputs[str(ARCHIVE / 'original-generator.py')] = GENERATOR_SHA
    return receipt, baseline, inputs


def matches(relative, pattern):
    return len(PurePosixPath(relative).parts) == len(PurePosixPath(pattern).parts) and PurePosixPath(relative).match(pattern)


def verify_profiles(receipt, baseline, tracked):
    revision = receipt['revision']
    for name in ['platform/package.json', 'services/hyperfide/package.json']:
        original = json.loads(git('show', revision + ':' + name))
        expected = {key: original.get(key) for key in ['name', 'version', 'engines', 'packageManager', 'scripts', 'devDependencies']}
        require(baseline['declared_profiles'][name] == expected, 'HISTORICAL_PROFILE_CHANGED:' + name)
    require(baseline['declared_profiles']['platform/.nvmrc'] == git('show', revision + ':platform/.nvmrc').decode().strip(), 'HISTORICAL_NODE_PROFILE_CHANGED')
    workspace = git('show', revision + ':platform/pnpm-workspace.yaml')
    require(hashlib.sha256(workspace).hexdigest() == baseline['workspace_definition_sha256'], 'HISTORICAL_WORKSPACE_DEFINITION_CHANGED')
    patterns = [json.loads(line.strip()[2:]) for line in workspace.decode().splitlines() if line.strip().startswith('- ')]
    require(patterns == baseline['workspace_patterns'], 'HISTORICAL_WORKSPACE_PATTERNS_CHANGED')
    include = [p for p in patterns if not p.startswith('!')]
    exclude = [p[1:] for p in patterns if p.startswith('!')]
    packages = sorted(name for name in tracked if name.startswith('platform/') and any(matches(name[len('platform/'):], p + '/package.json') for p in include) and not any(matches(str(PurePosixPath(name[len('platform/'):]).parent), p) for p in exclude))
    require(packages == baseline['workspace_packages'] and len(packages) == baseline['workspace_package_count'], 'HISTORICAL_WORKSPACE_MEMBERSHIP_CHANGED')
    count = sum(bool(json.loads(git('show', revision + ':' + name)).get('scripts', {}).get('test')) for name in packages)
    require(count == baseline['packages_with_test_script'], 'HISTORICAL_TEST_SCRIPT_MEMBERSHIP_CHANGED')
    vitest = git('show', revision + ':platform/vitest.config.ts')
    require(hashlib.sha256(vitest).hexdigest() == baseline['test_discovery_definition_sha256'], 'HISTORICAL_VITEST_DEFINITION_CHANGED')
    literal = re.search(r'const workspaceRoots = \[(.*?)\] as const;', vitest.decode(), re.S)
    require(literal is not None, 'HISTORICAL_VITEST_CONTRACT_MISSING')
    roots = re.findall(r'"([^"]+)"', literal.group(1))
    projects = sorted(name for name in tracked if any(matches(name, 'platform/' + parent + '/*/vitest.config.ts') for parent in roots))
    require(roots == baseline['vitest_roots'] and projects == baseline['root_vitest_projects'] and len(projects) == baseline['root_vitest_project_count'], 'HISTORICAL_VITEST_MEMBERSHIP_CHANGED')
    require(baseline['checkout_build'] == baseline['product_runtime'] == 'UNRUN', 'HISTORICAL_UNRUN_SCOPE_CHANGED')


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    prior = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        spec.loader.exec_module(value)
    finally:
        sys.dont_write_bytecode = prior
    return value


def verify_history():
    receipt, baseline, inputs = frozen_inputs()
    mapping = json.loads((ROOT / MAPPING).read_text())
    require(sha(ROOT / MAPPING) == receipt['mapping_sha256'] == receipt['implementation_inputs'][str(MAPPING)], 'HISTORICAL_MAPPING_CHANGED')
    require(receipt['revision'] == mapping['implementation_baseline'], 'HISTORICAL_BASELINE_REVISION_CHANGED')
    require(subprocess.run(['git', 'merge-base', '--is-ancestor', receipt['revision'], 'HEAD'], cwd=ROOT).returncode == 0, 'HISTORICAL_BASELINE_NOT_ANCESTOR')
    source = git('show', GENERATOR_REV + ':tools/repository/layout-inventory.py')
    require(hashlib.sha256(source).hexdigest() == GENERATOR_SHA == receipt['implementation_inputs']['tools/repository/layout-inventory.py'], 'HISTORICAL_GENERATOR_GIT_PIN_CHANGED')
    saved_driver = ROOT / ARCHIVE / DRIVER
    require(sha(saved_driver) == receipt['implementation_inputs'][str(DRIVER)], 'HISTORICAL_DRIVER_CHANGED')
    generator = module(ROOT / ARCHIVE / 'original-generator.py', 'historical_original_layout_generator')
    inventory = json.loads((ROOT / receipt['inventory']).read_text())
    recomputed = generator.generate_inventory(ROOT, mapping, receipt['revision'])
    historical_worktree_only = {'worktree_drift', 'valid', 'errors'}
    require({k: v for k, v in recomputed.items() if k not in historical_worktree_only} == {k: v for k, v in inventory.items() if k not in historical_worktree_only}, 'HISTORICAL_PINNED_GIT_INVENTORY_CHANGED')
    tracked = set(git('ls-tree', '-r', '--name-only', '-z', receipt['revision']).decode().split('\0')) - {''}
    verify_profiles(receipt, baseline, tracked)
    owner = module(ROOT / DRIVER, 'historical_inventory_owner')
    owner.verify_inventory(generator, mapping, receipt['revision'], inventory)
    owner.check('baseline.native-discovery-recorded', all(k in baseline['probes'] for k in ['native-components', 'native-sources', 'native-headers', 'native-libraries']))
    owner.check('baseline.workspace-membership', bool(baseline['workspace_packages']) and bool(baseline['root_vitest_projects']))
    owner.check('baseline.distinguishes-unrun-runtime', baseline['checkout_build'] == baseline['product_runtime'] == 'UNRUN')
    require(owner.RESULTS == receipt['assertions'], 'HISTORICAL_ASSERTION_REVERIFICATION_FAILED')
    with tempfile.TemporaryDirectory(prefix='tampered-history-', dir=OUT) as temporary:
        fixture = Path(temporary)
        shutil.copytree(ROOT / ARCHIVE, fixture / ARCHIVE)
        manifest = json.loads((ROOT / ARCHIVE / 'manifest.json').read_text())
        for entry in manifest['files']:
            target = fixture / entry['original']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / entry['copy'], target)
        with (fixture / receipt['baseline']).open('ab') as stream:
            stream.write(b' ')
        try:
            frozen_inputs(fixture)
        except ValueError as error:
            require(str(error) == 'HISTORICAL_ORIGINAL_CHANGED:' + receipt['baseline'], 'HISTORICAL_NEGATIVE_WRONG_REFUSAL')
        else:
            raise ValueError('HISTORICAL_TAMPER_ACCEPTED')
    inputs.update({str(DRIVER): sha(ROOT / DRIVER), str(Path(__file__).relative_to(ROOT)): sha(Path(__file__)), str(MAPPING): sha(ROOT / MAPPING)})
    return receipt, inputs, owner.RESULTS


def validate_verification():
    receipt, _, frozen = frozen_inputs()
    path = OUT / 'receipt.json'
    result = json.loads(local(ROOT, str(path.relative_to(ROOT))).read_text())
    require(result.get('status') == 'PASS' and result.get('scope') == SCOPE and result.get('historical_receipt_sha256') == RECEIPT_SHA, 'HISTORICAL_VERIFICATION_REQUIRED')
    require(result.get('historical_assertions') == receipt['assertions'] and result.get('tampered_hash_refused') is True, 'HISTORICAL_VERIFICATION_ASSERTIONS_REQUIRED')
    command = result['commands'][0]
    require(command['exit_code'] == 0 and command['command'] == [sys.executable, str(ROOT / DRIVER)] and type(command['duration_ms']) is int and command['duration_ms'] >= 0, 'HISTORICAL_VERIFICATION_COMMAND_REQUIRED')
    require(sha(local(ROOT, command['log'])) == command['log_sha256'], 'HISTORICAL_VERIFICATION_LOG_CHANGED')
    required = {**frozen, str(DRIVER): sha(ROOT / DRIVER), str(Path(__file__).relative_to(ROOT)): sha(Path(__file__)), str(MAPPING): sha(ROOT / MAPPING)}
    require(command['inputs'] == required, 'HISTORICAL_VERIFICATION_INPUT_SET_CHANGED')
    for name, expected in required.items():
        require(sha(local(ROOT, name)) == expected, 'HISTORICAL_VERIFICATION_INPUT_CHANGED:' + name)
    return {'path': str(path.relative_to(ROOT)), 'sha256': sha(path), 'historical_receipt_sha256': RECEIPT_SHA, 'historical_assertions': 22, 'tampered_hash_refused': True, 'scope': SCOPE}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    result = {'schema_version': 1, 'task': '0.3', 'status': 'FAIL', 'scope': SCOPE, 'historical_receipt_sha256': RECEIPT_SHA, 'historical_receipt': str(RECEIPT), 'case_qualification': 'UNRUN', 'checked_at': datetime.now(timezone.utc).isoformat(), 'commands': []}
    try:
        _, inputs, assertions = verify_history()
        result.update(status='PASS', historical_assertions=assertions, tampered_hash_refused=True, verification_source_revision=git('rev-parse', 'HEAD').decode().strip(), original_generator_revision=GENERATOR_REV, historical_environment_observations_reexecuted=False)
        log = OUT / 'verification.log'
        log.write_text(json.dumps({k: v for k, v in result.items() if k != 'commands'}, indent=2) + '\n')
        result['commands'] = [{'id': 'historical-baseline-verification', 'command': [sys.executable, str(ROOT / DRIVER)], 'exit_code': 0, 'duration_ms': round((time.monotonic() - started) * 1000), 'log': str(log.relative_to(ROOT)), 'log_sha256': sha(log), 'inputs': inputs}]
    except Exception as error:
        result['error'] = str(error)
    (OUT / 'receipt.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'status': result['status'], 'scope': SCOPE, 'receipt': str((OUT / 'receipt.json').relative_to(ROOT)), 'error': result.get('error')}))
    return 0 if result['status'] == 'PASS' else 1
