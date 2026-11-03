#!/usr/bin/env python3
"""Exercise tooling paths and collect actual release/image/startup evidence."""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import fnmatch
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/layout/0.8'
PACK = ROOT / 'spec/hyperfide-source-control'
REQUIRED = ['ci-category-routing', 'prepared-image-generation', 'nonpublishing-release-assembly',
            'installed-service-startup', 'source-stamp-and-privacy-boundary']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local(value):
    if not isinstance(value, str) or not value or value.startswith('/') or '\\' in value or any(x in {'', '.', '..'} for x in value.split('/')):
        raise ValueError('Canonical repository-relative evidence path required')
    path = ROOT / value
    if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(ROOT):
        raise ValueError('Ordinary local evidence file required: ' + value)
    return path


def document(path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('Duplicate evidence key: ' + key)
            result[key] = value
        return result
    value = json.loads(path.read_text(), object_pairs_hook=pairs)
    if not isinstance(value, dict):
        raise ValueError('Versioned evidence object required')
    return value


def reference(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': digest(path)}


def workflow_paths(text, event):
    lines = text.splitlines()
    start = lines.index('  ' + event + ':') + 1
    patterns = []
    active = False
    for line in lines[start:]:
        if line and not line.startswith('    '):
            break
        if line == '    paths:':
            active = True
        elif active and line.startswith('      - '):
            value = ast.literal_eval(line.strip()[2:])
            if not isinstance(value, str) or value.startswith('!') or not re.fullmatch(r'[A-Za-z0-9_./*?-]+', value):
                raise ValueError('Unsupported workflow path expression requires explicit evaluator support')
            patterns.append(value)
        elif active and line.strip():
            raise ValueError('Ambiguous workflow path list')
    if not patterns:
        raise ValueError('Declared workflow paths required')
    return patterns


def source_references():
    pattern = re.compile(r'(?<![A-Za-z0-9_./-])(?:platform|services)/[A-Za-z0-9_@.+%~*/{}$-]*(?:/[A-Za-z0-9_@.+%~*/{}$-]*)*')
    installed = re.compile(r'^services/(?:dist|components|migrations|proof|runtime|node_modules|package\.json|package-lock\.json)(?:/|$)')
    proof_path = ROOT / 'build/layout/0.9/docs-forward-verification/receipt.json'
    verified_history = {}
    try:
        proof = document(proof_path)
        passed = {item['id'] for item in proof.get('assertions', []) if item.get('status') == 'PASS'}
        command = next(item for item in proof.get('commands', []) if item.get('id') == 'docs-reference-ownership')
        valid_log = command.get('exit_code') == 0 and digest(local(command['log'])) == command.get('log_sha256')
        pins = command.get('inputs', {})
        archived = ['docs/SOURCE-REFERENCE.md', 'docs/reference/editors-vscode.md', 'docs/reference/services-artifacts-and-storage.md', 'docs/reference/services-graph-and-spec.md', 'docs/reference/services-identity-and-policy.md', 'docs/reference/services-integration-and-review.md', 'docs/reference/services-providers-and-preparation.md', 'docs/reference/services-runtime.md']
        if proof.get('status') == 'PASS' and valid_log:
            for name in archived:
                if {'historical-attribution:' + name, 'historical-declarations:' + name} <= passed and pins.get(name) == digest(ROOT / name):
                    verified_history[name] = 'INDEX_A2A367F9'
            for name, assertion in [('docs/hyperfide/console-evaluation.md', 'dated-evaluation-preserved'), ('docs/hyperfide/operations.md', 'historical-measurement-scope')]:
                if assertion in passed and pins.get(name) == digest(ROOT / name):
                    verified_history[name] = assertion
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        pass
    try:
        history = document(ROOT / 'build/layout/0.9/operations-history-current/receipt.json')
        command = next(item for item in history.get('commands', []) if item.get('id') == 'operations-history-source-check')
        assertions = {item['id'] for item in history.get('assertions', [])
                      if item.get('status') == 'PASS' and item.get('command_id') == command['id']}
        required = {'historical-measurement-scope', 'historical-measurement-original-git-body'}
        pins = command.get('inputs', {})
        if (history.get('schema_version') == 1 and history.get('kind') == 'LAYOUT_HISTORICAL_DOCUMENT_SCOPE_V1'
                and history.get('status') == 'PASS' and required <= assertions
                and command.get('exit_code') == 0
                and digest(local(command['log'])) == command.get('log_sha256')
                and 'docs/hyperfide/operations.md' in pins
                and all(digest(local(name)) == expected for name, expected in pins.items())):
            verified_history['docs/hyperfide/operations.md'] = 'historical-measurement-scope'
    except (OSError, ValueError, KeyError, StopIteration, TypeError):
        pass
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    rows = []
    for name in sorted(set(files) - {''}):
        if not name.startswith(('tools/', 'deploy/', '.github/', '.agents/', 'docs/')):
            continue
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            continue
        try:
            text = path.read_text()
        except UnicodeError:
            continue
        lines = text.splitlines()
        archive_end = next((index for index, line in enumerate(lines, 1) if line.startswith('Historical source paths and declaration locations above remain pinned')), 0)
        archive_verified = verified_history.get(name) == 'INDEX_A2A367F9' and archive_end > 0 and 'a2a367f9388e9686deb52194ca45b05d008e84a3' in lines[archive_end - 1] and 'revision `a2a367f9`' in text
        measurement_start = next((index for index, line in enumerate(lines, 1) if line.startswith('Measurements on 2026-10-23')), 0)
        measurement_end = next((index for index, line in enumerate(lines, 1) if index > measurement_start and line.startswith('## ')), len(lines) + 1)
        for number, line in enumerate(lines, 1):
            for match in pattern.finditer(line):
                reference = match[0].rstrip('.')
                kind, reason = 'unresolved-current-reference', 'Current tooling or documentation needs an exact source/artifact disposition'
                if name.startswith('docs/history/') or name == 'docs/hyperfide/source-engine-evaluation.md' or re.search(r'/validation-\d{4}-\d{2}-\d{2}\.json$', name):
                    kind, reason = 'historical-evidence', 'Historical source identities remain attached to their original evaluation'
                elif archive_verified and number < archive_end:
                    kind, reason = 'revision-bound-source-reference', 'Exact verified historical index section retains original a2a367f9 paths/declarations and immutable source links; current category mapping is separate'
                elif verified_history.get(name) == 'dated-evaluation-preserved' and 'Review date 2026-10-22' in text:
                    kind, reason = 'historical-evaluation-reference', 'Exact original dated evaluation blob was restored and independently source-verified'
                elif verified_history.get(name) == 'historical-measurement-scope' and measurement_start <= number < measurement_end and reference == 'platform/apps/server/':
                    kind, reason = 'historical-measurement-reference', 'Verified 2026-10-23 measurement retains its original platform/apps/server input scope; current command guidance remains separate'
                elif installed.match(reference):
                    kind, reason = 'installed-artifact', 'Packaged services layout is distinct from checkout source categories'
                elif name == 'tools/repository/layout-inventory.py':
                    kind, reason = 'layout-schema', 'Validator names frozen original mapping inputs and rejects old source containers'
                elif name == 'tools/workspace/check-provider-literal-ratchet.mjs' and reference == 'platform/scripts/provider-literal-baseline.json':
                    kind, reason = 'historical-git-input', 'baselineFromGit resolves the old path through git show at the requested historical revision'
                elif name == 'deploy/hyperfide/fleet-control/README.md' and reference == 'services/sandboxes':
                    kind, reason = 'category-prose', 'This phrase describes service and sandbox execution categories'
                rows.append({'consumer': name, 'line': number, 'reference': reference, 'classification': kind, 'reason': reason})
    return rows


def reference_inputs():
    files = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    return [ROOT / name for name in sorted(set(files) - {''})
            if name.startswith(('tools/', 'deploy/', '.github/', '.agents/', 'docs/'))
            and (ROOT / name).is_file() and not (ROOT / name).is_symlink()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, default=OUT / 'inputs.json')
    parser.add_argument('--assemble-release', action='store_true', help='Run the real nonpublishing release builder once')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    mapping = document(PACK / 'repository-layout.json')
    binding_module = importlib.util.spec_from_file_location('layout_tooling_bindings', Path(__file__).with_name('0_9.py'))
    bindings = importlib.util.module_from_spec(binding_module)
    binding_module.loader.exec_module(bindings)
    report = {'schema_version': 1, 'task': '0.8', 'case': 'SCM-025', 'status': 'BLOCKED',
              'checked_at': datetime.now(timezone.utc).isoformat(), 'required_assertions': REQUIRED,
              'commands': [], 'assertions': [], 'checks': [], 'artifacts': [], 'missing_evidence': [],
              'regressions': [], **bindings.capture_bindings()}
    node = os.environ.get('HYPERFIDE_LAYOUT_NODE') or shutil.which('node')
    implementation = [Path(__file__), Path(__file__).with_name('0_9.py'), ROOT / 'tests/hyperfide/support/layout_tooling_stamp.mjs', PACK / 'repository-layout.json']

    def check(ident, passed, detail):
        report['checks'].append({'id': ident, 'status': 'PASS' if passed else 'FAIL', 'evidence': detail})
        if not passed:
            report['regressions'].append(ident)

    def command(ident, argv, inputs, timeout=60, cwd=ROOT):
        started = time.monotonic()
        env = {k: v for k, v in os.environ.items() if k not in {'NODE_OPTIONS', 'NODE_PATH'}}
        env.update(CI='1', COREPACK_ENABLE_NETWORK='0')
        try:
            result = subprocess.run(argv, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
            code, output = result.returncode, result.stdout
        except (OSError, subprocess.TimeoutExpired) as error:
            code, output = None, str(error)
        log = OUT / (ident + '.log')
        log.write_text(output)
        record = {'id': ident, 'command': [str(x) for x in argv], 'exit_code': code,
                  'duration_ms': int((time.monotonic() - started) * 1000), 'log': str(log.relative_to(ROOT)),
                  'log_sha256': digest(log), 'inputs': {str(x.relative_to(ROOT)): digest(x) for x in set(inputs + implementation)}}
        report['commands'].append(record)
        return record, output

    def assertion(ident, record):
        report['assertions'].append({'id': ident, 'status': 'PASS', 'command_id': record['id']})

    def retained_command(path):
        value = document(path)
        for key in ['source_snapshot_sha256', 'mapping_sha256', 'layout_generation']:
            if value.get(key) != report[key]:
                raise ValueError('Stale retained command: ' + key)
        revision = value.get('source_revision')
        if not isinstance(revision, str) or not re.fullmatch(r'[0-9a-f]{40}(?:[0-9a-f]{24})?', revision) or subprocess.run(['git', 'merge-base', '--is-ancestor', revision, report['source_revision']], cwd=ROOT, capture_output=True).returncode:
            raise ValueError('Retained command must bind an actual ancestor revision')
        if value.get('source_tree_id') != subprocess.check_output(['git', 'rev-parse', revision + '^{tree}'], cwd=ROOT, text=True).strip() or value.get('source_snapshot') != report['source_snapshot']:
            raise ValueError('Retained command runtime source inventory changed')
        record = value['command']
        if not isinstance(record, dict) or record.get('exit_code') != 0 or not isinstance(record.get('command'), list) or not record['command'] or not isinstance(record.get('duration_ms'), int) or record['duration_ms'] < 0:
            raise ValueError('Actual successful command inventory required')
        if digest(local(record['log'])) != record['log_sha256'] or not record.get('inputs'):
            raise ValueError('Retained command log/input inventory changed')
        for name, expected in record['inputs'].items():
            if digest(local(name)) != expected:
                raise ValueError('Retained command input changed: ' + name)
        if any(item['id'] == record['id'] for item in report['commands']):
            raise ValueError('Duplicate command identity')
        report['commands'].append(record)
        report['artifacts'].append(reference(path))
        return record

    try:
        obsolete = [name for name in ['platform', 'services', 'src', 'scripts', 'kvx', 'editors/vscode'] if (ROOT / name).exists()]
        check('no-obsolete-source-facades', not obsolete, obsolete)
        ci = ROOT / '.github/workflows/platform.yml'
        patterns = {event: workflow_paths(ci.read_text(), event) for event in ['push', 'pull_request']}
        tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
        samples = {category: next(name for name in tracked if name.startswith(category + '/') and (ROOT / name).is_file())
                   for category in ['apps', 'core', 'sdk', 'contracts', 'lib', 'plugins', 'tools', 'examples', 'tests', 'assets', 'patches']}
        uncovered = [(event, name) for event, filters in patterns.items() for name in samples.values() if not any(fnmatch.fnmatchcase(name, pattern) for pattern in filters)]
        check('ci.category-path-selection', not uncovered, {'samples': samples, 'uncovered': uncovered})
        command_record, _ = command('ci-entrypoint-arguments', [sys.executable, str(Path(__file__)), '--entrypoint-observation'], [ci, ROOT / 'tools/repository/platform-ci.sh'], cwd=OUT)
        check('ci.entrypoint-resolves-from-nested-directory', command_record['exit_code'] == 0, {'command_id': command_record['id']})
        routed, _ = command('ci-routing', [sys.executable, str(Path(__file__)), '--routing-observation'], [ci, ROOT / '.github/workflows/ci.yml'])
        if routed['exit_code'] == 0 and not uncovered:
            assertion('ci-category-routing', routed)
        else:
            check('ci.routing-observation', False, routed['id'])
        references, output = command('current-source-references', [sys.executable, str(Path(__file__)), '--references-observation'], reference_inputs())
        check('references.no-live-obsolete-source-roots', references['exit_code'] == 0, {'command_id': references['id']})
        if references['exit_code'] == 0:
            report['typed_reference_exceptions'] = json.loads(output)['references']
        if not node:
            report['missing_evidence'].append({'kind': 'node-executable', 'assertion': 'source-stamp-and-privacy-boundary'})
        else:
            emitted_inputs = [path for path in (ROOT / 'core/control-plane/dist').rglob('*') if path.is_file() and not path.is_symlink()]
            current_stamp, _ = command('current-control-source-stamp', [node, str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(ROOT / 'core/control-plane')], [ROOT / 'deploy/hyperfide/dist-stamp.mjs', *emitted_inputs])
            stamp, output = command('source-stamp', [node, str(ROOT / 'tests/hyperfide/support/layout_tooling_stamp.mjs'), str(ROOT)], [ROOT / 'deploy/hyperfide/dist-stamp.mjs'])
            privacy, _ = command('privacy-boundary', [sys.executable, str(Path(__file__)), '--privacy-observation'], [ROOT / '.gitignore'])
            check('privacy.git-ignore-boundary', privacy['exit_code'] == 0, {'command_id': privacy['id']})
            if current_stamp['exit_code'] == 0 and stamp['exit_code'] == 0 and privacy['exit_code'] == 0:
                assertion('source-stamp-and-privacy-boundary', stamp)
            else:
                check('source-stamp.actual-rejection-cases', False, {'current_stamp': current_stamp['exit_code'], 'stamp': stamp['exit_code'], 'privacy': privacy['exit_code']})
        compatibility = None
        if node:
            compatibility, _ = command('prepared-checkpoint-compatibility', [node, '--test', str(ROOT / 'deploy/hyperfide/sandbox/layout.test.mjs')],
                                       [ROOT / 'deploy/hyperfide/sandbox' / name for name in ['layout.mjs', 'layout.test.mjs', 'lib.mjs', 'provision.mjs', 'run-job.mjs']], timeout=60)
            check('prepared-image.actual-generation-invalidation', compatibility['exit_code'] == 0, {'command_id': compatibility['id']})
            if compatibility['exit_code'] == 0:
                assertion('prepared-image-checkpoint-compatibility', compatibility)
        inputs = document(args.inputs) if args.inputs.is_file() else {}
        if inputs and inputs.get('schema_version') != 1:
            raise ValueError('Versioned tooling evidence input required')
        if args.assemble_release:
            release = OUT / 'release'
            if release.exists():
                raise ValueError('Retain existing release output; provide its command receipt instead of rebuilding')
            record, _ = command('release-assembly', ['bash', str(ROOT / 'tools/repository/release.sh'), '--dry-run', '--skip-tests', '--output', str(release)], [ROOT / 'tools/repository/release.sh', ROOT / 'package.json', ROOT / 'pnpm-lock.yaml', ROOT / 'core/control-plane/package-lock.json'], timeout=1200)
            retained = {key: report[key] for key in ['source_revision', 'source_tree_id', 'mapping_sha256', 'layout_generation', 'source_snapshot', 'source_snapshot_sha256']}
            retained['command'] = record
            (OUT / 'release-command.json').write_text(json.dumps(retained, indent=2) + '\n')
            if record['exit_code'] == 0:
                inputs['release_command'] = 'build/layout/0.8/release-command.json'
                inputs['release_directory'] = 'build/layout/0.8/release'
            else:
                check('release.actual-nonpublishing-assembly', False, {'command_id': record['id'], 'exit_code': record['exit_code']})
        if inputs.get('release_directory') and inputs.get('release_command'):
            release = ROOT / inputs['release_directory']
            if not release.resolve().is_relative_to(ROOT) or release.is_symlink() or not release.is_dir():
                raise ValueError('Ordinary local release directory required')
            record = next((item for item in report['commands'] if item['id'] == 'release-assembly'), None) or retained_command(local(inputs['release_command']))
            if not any(str(arg).endswith('tools/repository/release.sh') for arg in record['command']) or '--dry-run' not in record['command']:
                raise ValueError('Real nonpublishing release command required')
            sums = local(str((release / 'SHA256SUMS').relative_to(ROOT)))
            members = {}
            for line in sums.read_text().splitlines():
                expected, name = line.split('  ', 1)
                if '/' in name or not re.fullmatch(r'[0-9a-f]{64}', expected) or digest(local(str((release / name).relative_to(ROOT)))) != expected:
                    raise ValueError('Release checksum inventory differs')
                if name.endswith('.tar.gz'):
                    with tarfile.open(release / name) as archive:
                        names = archive.getnames()
                        if any(name.startswith('/') or '..' in Path(name).parts or any(part == '.env' or part.startswith('.env.') and part not in {'.env.example', '.env.sample', '.env.template'} for part in Path(name).parts) for name in names):
                            raise ValueError('Unsafe or private release archive member')
                        members[name] = len(names)
                report['artifacts'].append(reference(release / name))
            expected = ['server', 'host-daemon', 'app', 'binary', 'service']
            if not all((release / ('hyperfide-' + ('platform-' if name in {'server', 'host-daemon', 'app'} else '') + name + '-2.2.0.tar.gz')).is_file() for name in expected):
                raise ValueError('Release component inventory incomplete')
            report['release_package_identities'] = {}
            for component, source in {'platform-server': 'core/server', 'platform-host-daemon': 'core/host-daemon', 'platform-app': 'apps/web', 'service': 'core/control-plane'}.items():
                with tarfile.open(release / ('hyperfide-' + component + '-2.2.0.tar.gz')) as archive:
                    package = json.load(archive.extractfile('package.json'))
                    expected_package = document(ROOT / source / 'package.json')
                    if any(package.get(key) != expected_package.get(key) for key in ['name', 'version', 'license', 'bin', 'exports', 'type']):
                        raise ValueError('Release public package identity changed: ' + component)
                    if component == 'service':
                        if hashlib.sha256(archive.extractfile('package-lock.json').read()).hexdigest() != digest(ROOT / source / 'package-lock.json'):
                            raise ValueError('Release service dependency lock differs')
                    report['release_package_identities'][component] = {key: package[key] for key in ['name', 'version', 'license'] if key in package}
            report['artifacts'].append(reference(sums))
            assertion('nonpublishing-release-assembly', record)
            if inputs.get('installed_platform_command'):
                smoke = retained_command(local(inputs['installed_platform_command']))
                if str(release / 'smoke.py') not in smoke['command'] or smoke['inputs'].get(str(sums.relative_to(ROOT))) != digest(sums):
                    raise ValueError('Actual platform startup must bind this release smoke entry and archive inventory')
            else:
                smoke, _ = command('installed-service-startup', [sys.executable, str(release / 'smoke.py')], [release / 'smoke.py', sums], timeout=180)
            if smoke['exit_code'] == 0:
                assertion('packaged-platform-server-host-startup', smoke)
                if not inputs.get('installed_platform_command'):
                    retained = {key: report[key] for key in ['source_revision', 'source_tree_id', 'mapping_sha256', 'layout_generation', 'source_snapshot', 'source_snapshot_sha256']}
                    (OUT / 'installed-platform-command.json').write_text(json.dumps({**retained, 'command': smoke}, indent=2) + '\n')
                if inputs.get('installed_control_command'):
                    control = retained_command(local(inputs['installed_control_command']))
                    control_evidence = document(local(inputs['installed_control_command']))
                    if control_evidence.get('archive_sha256') != digest(release / 'hyperfide-service-2.2.0.tar.gz') or control_evidence.get('component_bootstrap') != 'PASS' or control_evidence.get('source_stamp_preflight') != 'PASS':
                        raise ValueError('Actual packaged control startup must bind the verified service archive')
                    assertion('installed-service-startup', control)
                else:
                    report['missing_evidence'].append({'kind': 'installed-control-service-startup', 'assertion': 'installed-service-startup', 'required_input': 'installed_control_command binding actual control bootstrap/preflight to service archive SHA256'})
            else:
                check('release.actual-packaged-startup', False, smoke['id'])
        else:
            report['missing_evidence'].append({'kind': 'nonpublishing-release', 'assertions': ['nonpublishing-release-assembly', 'installed-service-startup'], 'required_input': ['release_directory', 'release_command']})
        if inputs.get('prepared_image'):
            image = inputs['prepared_image']
            manifest = local(image['manifest'])
            value = document(manifest)
            if image.get('layout_generation') != mapping['layout_generation'] or value.get('layout_generation') != mapping['layout_generation'] or value.get('mapping_digest') != 'sha256:' + digest(PACK / 'repository-layout.json') or digest(manifest) != image.get('manifest_sha256') or not image.get('identity'):
                raise ValueError('Actual prepared image must bind this layout generation and manifest')
            if compatibility is None or compatibility['exit_code'] != 0:
                raise ValueError('Actual checkpoint generation compatibility must pass before image qualification')
            command_record = retained_command(local(image['command_receipt']))
            provider = document(local(image['provider_receipt']))
            manifest_pin = 'sha256:' + hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            if provider.get('status') != 'BUILT' or provider.get('preparation_reference') != image['identity'] or provider.get('image_http_status') != 200 or provider.get('tag_http_status') != 200 or provider.get('payload_manifest_digest') != manifest_pin:
                raise ValueError('Provider read-back must confirm the exact built image')
            report['prepared_image'] = {key: image[key] for key in ['layout_generation', 'identity', 'manifest', 'manifest_sha256']}
            report['artifacts'] += [reference(manifest), reference(local(image['provider_receipt']))]
            assertion('prepared-image-generation', command_record)
        else:
            report['missing_evidence'].append({'kind': 'prepared-image', 'assertion': 'prepared-image-generation', 'required_input': 'prepared_image: exact immutable identity, generation, manifest, provider and command receipts'})
    except (OSError, ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError, tarfile.TarError) as error:
        report['missing_evidence'].append({'kind': 'driver-input', 'detail': str(error)})
    observed = {item['id'] for item in report['assertions']}
    for ident in set(REQUIRED) - observed:
        if not any(item.get('assertion') == ident or ident in item.get('assertions', []) for item in report['missing_evidence']):
            report['missing_evidence'].append({'kind': 'required-assertion', 'assertion': ident})
    report['status'] = 'FAIL' if report['regressions'] else 'BLOCKED' if report['missing_evidence'] else 'PASS'
    (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'task': '0.8', 'status': report['status'], 'assertions': len(report['assertions']), 'missing_evidence': len(report['missing_evidence']), 'regressions': report['regressions'], 'receipt': 'build/layout/0.8/receipt.json'}))
    return 0 if report['status'] == 'PASS' else 2 if report['status'] == 'BLOCKED' else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--entrypoint-observation']:
        result = subprocess.run(['bash', str(ROOT / 'tools/repository/platform-ci.sh'), '--layout-invalid-argument'], cwd=OUT, text=True, capture_output=True)
        assert result.returncode == 2 and 'usage: tools/repository/platform-ci.sh' in result.stderr
        print(json.dumps({'status': 'PASS', 'actual_exit': result.returncode, 'working_directory': 'build/layout/0.8', 'scope': 'Real relocated CI entrypoint argument preflight'}))
    elif sys.argv[1:] == ['--references-observation']:
        rows = source_references()
        print(json.dumps({'status': 'FAIL' if any(row['classification'] == 'unresolved-current-reference' for row in rows) else 'PASS', 'references': rows}))
        raise SystemExit(1 if any(row['classification'] == 'unresolved-current-reference' for row in rows) else 0)
    elif sys.argv[1:] == ['--routing-observation']:
        text = (ROOT / '.github/workflows/platform.yml').read_text()
        patterns = {event: workflow_paths(text, event) for event in ['push', 'pull_request']}
        ci = (ROOT / '.github/workflows/ci.yml').read_text()
        assert 'working-directory: core/control-plane' in ci and 'cache-dependency-path: core/control-plane/package-lock.json' in ci
        assert 'hashFiles(\'pnpm-lock.yaml\')' in text and 'run: bash tools/repository/platform-ci.sh' in text
        print(json.dumps({'status': 'PASS', 'scope': 'Declared CI category filters, root lockfile cache and real script entrypoint', 'patterns': patterns}))
    elif sys.argv[1:] == ['--privacy-observation']:
        private = ['.env', '.env.production', 'build/layout/private.json', 'spec/hyperfide/private/config.json', 'deploy/hyperfide/identity/actual.json', 'core/control-plane/dist/control.js']
        public = ['.env.example', '.env.sample', '.env.template', 'deploy/hyperfide/identity/control.example.json']
        result = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'], cwd=ROOT, input='\n'.join(private + public) + '\n', text=True, capture_output=True)
        assert result.returncode in {0, 1} and set(result.stdout.splitlines()) == set(private)
        print(json.dumps({'status': 'PASS', 'private_paths': len(private), 'public_examples': len(public)}))
    else:
        raise SystemExit(main())
