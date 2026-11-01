#!/usr/bin/env python3
"""Qualify relocated SDK/library consumers, membership and real generator caching."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/layout/0.6'
MAPPING = ROOT / 'spec/hyperfide-source-control/repository-layout.json'
TOOLCHAIN = ROOT / 'tests/hyperfide/support/layout_toolchain.py'
sys.path.insert(0, str(TOOLCHAIN.parent))
from layout_toolchain import node_tool, pnpm_tool
NODE = node_tool((ROOT / '.nvmrc').read_text().strip(), 'HYPERFIDE_LAYOUT_NODE22')
PNPM = pnpm_tool(ROOT, NODE)
HELPER = ROOT / 'tests/hyperfide/cases/source_control/fixtures/layout_sdk_consumer.mts'
TEST = re.compile(r'\.(?:test|spec)\.[cm]?[jt]sx?$')
GENERATED = ['lib/templates/src/generated/templates.generated.ts', 'lib/templates/src/generated/plugin-starter-files.generated.ts', 'tools/plugin-build/src/generated/plugin-theme.generated.ts', 'tools/plugin-build/src/generated/runtime-export-manifest.generated.ts']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


def units():
    mapping = json.loads(MAPPING.read_text())
    return mapping, [row for row in mapping['mappings'] if row['source'].startswith('platform/packages/') and row['destination'].split('/')[0] in {'sdk', 'contracts', 'lib', 'tools'}]


def environment():
    value = dict(os.environ, PATH=str(NODE.parent) + os.pathsep + os.environ.get('PATH', ''), CI='1', COREPACK_ENABLE_NETWORK='0', TURBO_TELEMETRY_DISABLED='1')
    for name in list(value):
        if name.startswith('TURBO_') and name != 'TURBO_TELEMETRY_DISABLED':
            del value[name]
    return value


def inventory(test_files):
    mapping, selected = units()
    baseline = mapping['implementation_baseline']
    rules = module(ROOT / 'tools/repository/layout-inventory.py', 'layout_sdk_inventory')
    identities, expected_tests, targets, exports, bins, generators = [], [], [], [], [], []
    fields = ['name', 'version', 'type', 'private', 'exports', 'bin', 'main', 'module', 'types', 'typings', 'files', 'engines', 'packageManager', 'peerDependenciesMeta']
    dependencies = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    patterns = re.findall(r'^\s*-\s*"([^"]+)"', (ROOT / 'pnpm-workspace.yaml').read_text(), re.M)
    workspace = {str(p.parent.relative_to(ROOT)) for pattern in patterns if not pattern.startswith('!') for p in ROOT.glob(pattern + '/package.json')}
    baseline_files = git('ls-tree', '-r', '--name-only', baseline).decode().splitlines()
    for row in selected:
        source, target = row['source'], row['destination']
        if (ROOT / source).exists():
            raise ValueError('Old source duplicate exists: ' + source)
        before = json.loads(git('show', baseline + ':' + source + '/package.json'))
        after = json.loads((ROOT / target / 'package.json').read_text())
        for field in fields + dependencies:
            if before.get(field) != after.get(field):
                raise ValueError('Public identity/dependency drift: ' + target + ':' + field)
        if set(before.get('scripts', {})) != set(after.get('scripts', {})) or target not in workspace:
            raise ValueError('Package scripts/workspace membership changed: ' + target)
        def leaves(value):
            if isinstance(value, str):
                yield value
            elif isinstance(value, dict):
                for child in value.values():
                    yield from leaves(child)
            elif isinstance(value, list):
                for child in value:
                    yield from leaves(child)
        for entry in leaves(after.get('exports', {})):
            if entry.startswith('./') and not list((ROOT / target).glob(entry[2:])):
                raise ValueError('Missing public export target: ' + target + ':' + entry)
            exports.append({'package': after['name'], 'target': entry})
        for entry in leaves(after.get('bin', {})):
            filename = ROOT / target / entry.removeprefix('./')
            if not filename.is_file():
                raise ValueError('Declared package bin is unavailable: ' + target + ':' + entry)
            bins.append({'package': after['name'], 'path': str(filename.relative_to(ROOT)), 'sha256': digest(filename)})
        for filename in baseline_files:
            if filename.startswith(source + '/') and TEST.search(filename):
                expected_tests.append(target + filename[len(source):])
            if filename.startswith(source + '/scripts/') and re.search(r'/generate[^/]*\.[cm]?[jt]s$', filename):
                destination = target + filename[len(source):]
                if not (ROOT / destination).is_file():
                    raise ValueError('Mapped generator is unavailable: ' + destination)
                generators.append({'source': filename, 'target': destination})
        targets.append(target)
        identities.append({'source': source, 'target': target, 'name': after['name'], 'version': after['version'], 'scripts': sorted(after.get('scripts', {}))})
    old_lock = git('show', baseline + ':platform/pnpm-lock.yaml')
    def resolutions(text):
        return text.split(b'\npackages:\n', 1)[1]
    if resolutions(old_lock) != resolutions((ROOT / 'pnpm-lock.yaml').read_bytes()):
        raise ValueError('External locked package/snapshot resolution drift')
    raw = json.loads(Path(test_files).read_text())
    discovered = set()
    def strings(value):
        if isinstance(value, str):
            yield value
        elif isinstance(value, list):
            for item in value:
                yield from strings(item)
        elif isinstance(value, dict):
            for item in value.values():
                yield from strings(item)
    for value in strings(raw):
        if TEST.search(value):
            filename = Path(value)
            if not filename.is_absolute():
                filename = ROOT / filename
            if filename.is_relative_to(ROOT):
                discovered.add(str(filename.relative_to(ROOT)))
    missing = sorted(set(expected_tests) - discovered)
    report = {'status': 'PASS' if not missing else 'BLOCKED', 'packages': identities, 'exports': exports, 'bins': bins, 'generators': generators, 'expected_tests': sorted(expected_tests), 'discovered_tests': sorted(discovered), 'missing_tests': missing}
    (OUT / 'inventory.json').write_text(json.dumps(report, indent=2) + '\n')
    if missing:
        raise ValueError('Mapped baseline tests absent from actual Vitest discovery: ' + ', '.join(missing[:12]))
    print(json.dumps({'status': 'PASS', 'packages': len(identities), 'public_export_targets': len(exports), 'mapped_test_files': len(expected_tests)}))


def cache():
    mapping, selected = units()
    with tempfile.TemporaryDirectory(prefix='cache-', dir=OUT) as temporary:
        temporary = Path(temporary)
        checkout = temporary / 'source'
        checkout.mkdir()
        archive = temporary / 'source.tar'
        with archive.open('wb') as stream:
            subprocess.run(['git', '-C', str(ROOT), 'archive', 'HEAD'], stdout=stream, check=True)
        with tarfile.open(archive) as stream:
            stream.extractall(checkout, filter='data')
        tracked = git('ls-files', '-z').decode().split('\0')
        roots = [row['destination'] for row in selected] + ['tools/workspace', 'apps/web']
        for name in tracked:
            if name and (any(name == prefix or name.startswith(prefix + '/') for prefix in roots) or name in {'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'turbo.json'}):
                source, target = ROOT / name, checkout / name
                if source.is_file() and not source.is_symlink():
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
        manifests = list(checkout.rglob('package.json'))
        for package in [checkout] + [path.parent for path in manifests]:
            source = ROOT / package.relative_to(checkout) / 'node_modules'
            if source.is_dir() and not (package / 'node_modules').exists():
                (package / 'node_modules').symlink_to(source, target_is_directory=True)
        observations = []
        def run(label):
            before = set((checkout / '.turbo/runs').glob('*.json'))
            argv = [str(PNPM), 'exec', 'turbo', 'run', 'generate', 'generate:templates', 'generate:plugin-scaffold', '--filter=@hyperfide/plugin-build', '--filter=@hyperfide/templates', '--cache=local:rw', '--cache-dir=' + str(temporary / 'cache'), '--summarize', '--output-logs=errors-only']
            result = subprocess.run(argv, cwd=checkout, env=environment(), text=True, capture_output=True, timeout=180)
            (OUT / ('cache-' + label + '.log')).write_text(result.stdout + result.stderr)
            if result.returncode:
                raise ValueError('Actual Turbo generator failed: ' + label)
            summaries = set((checkout / '.turbo/runs').glob('*.json')) - before
            if len(summaries) != 1:
                raise ValueError('Expected one actual Turbo execution summary')
            summary = json.loads(summaries.pop().read_text())
            task = next(row for row in summary['tasks'] if row['taskId'] == '@hyperfide/plugin-build#generate')
            observations.append({'step': label, 'task_id': task['taskId'], 'hash': task['hash'], 'cache': task['cache'], 'execution': task.get('execution'), 'command': argv})
            (OUT / ('cache-' + label + '-summary.json')).write_text(json.dumps(summary, indent=2) + '\n')
            return task
        cold, warm = run('cold'), run('warm')
        generated = []
        for name in GENERATED:
            if digest(checkout / name) != digest(ROOT / name):
                raise ValueError('Current consumed generated module differs from fresh relocated generator: ' + name)
            generated.append({'path': name, 'sha256': digest(checkout / name)})
        if cold['cache']['status'] != 'MISS' or warm['cache']['status'] != 'HIT' or cold['hash'] != warm['hash']:
            raise ValueError('Actual cold/warm cache behavior differs')
        generator = checkout / 'tools/plugin-build/scripts/generate-runtime-export-manifest.mjs'
        generator.write_text(generator.read_text() + '\n// Isolated layout cache invalidation input.\n')
        changed = run('generator-input')
        library = checkout / 'lib/shared-ui/src/components/ui/icon.tsx'
        library.write_text(library.read_text() + '\n// Isolated moved-library cache invalidation input.\n')
        moved = run('library-input')
        if changed['cache']['status'] != 'MISS' or changed['hash'] == warm['hash'] or moved['cache']['status'] != 'MISS' or moved['hash'] == changed['hash']:
            raise ValueError('Moved generator/library input reused a warm cache')
        report = {'status': 'PASS', 'observations': observations, 'generated_output_equivalence': generated, 'layout_generation': mapping['layout_generation']}
        (OUT / 'cache-report.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if '--inventory' in sys.argv:
        return inventory(sys.argv[sys.argv.index('--inventory') + 1])
    if '--cache' in sys.argv:
        return cache()
    evidence = module(Path(__file__).with_name('0_9.py'), 'layout_sdk_receipt')
    mapping, selected = units()
    inputs = [TOOLCHAIN, MAPPING, Path(__file__), HELPER, Path(__file__).with_name('0_9.py'), ROOT / 'tools/repository/layout-inventory.py', ROOT / '.nvmrc', *ROOT.glob('vitest*.ts')]
    inputs.extend(ROOT.glob('tests/fixtures/plugins/*/vitest.config.*'))
    inputs.extend(ROOT / name for name in GENERATED)
    for row in selected:
        for generated_dir in ['dist', 'bundled-types']:
            inputs.extend(path for path in (ROOT / row['destination'] / generated_dir).rglob('*') if path.is_file() and not path.is_symlink())
    for name in git('ls-files', '-z').decode().split('\0'):
        if name and (any(name.startswith(row['destination'] + '/') for row in selected) or name in {'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'turbo.json', 'vitest.config.ts', 'vitest.shared.ts'}):
            if (ROOT / name).is_file() and not (ROOT / name).is_symlink():
                inputs.append(ROOT / name)
    input_hashes = {str(path.relative_to(ROOT)): digest(path) for path in inputs}
    receipt = {'schema_version': 1, 'task': '0.6', 'status': 'BLOCKED', **evidence.capture_bindings(), 'commands': [], 'assertions': [], 'artifacts': [], 'missing_obligations': []}
    try:
        commands = [
            ('discovery', [str(NODE), str(ROOT / 'node_modules/vitest/vitest.mjs'), 'list', '--filesOnly', '--json=' + str(OUT / 'vitest-files.json')], []),
            ('inventory', ['python3', str(Path(__file__)), '--inventory', str(OUT / 'vitest-files.json')], ['public-exports', 'test-membership']),
            ('consumer', [str(NODE), '--conditions=source', '--import', 'tsx', str(HELPER), str(ROOT), str(OUT)], ['sdk-plugin-consumers']),
            ('cache', ['python3', str(Path(__file__)), '--cache'], ['cold-warm-cache-invalidation']),
        ]
        for name, argv, assertions in commands:
            started = time.monotonic()
            result = subprocess.run(argv, cwd=ROOT, env=environment(), text=True, capture_output=True, timeout=720)
            log = OUT / (name + '.log')
            log.write_text(result.stdout + result.stderr)
            receipt['commands'].append({'id': name, 'command': argv, 'exit_code': result.returncode, 'duration_ms': int((time.monotonic() - started) * 1000), 'log': str(log.relative_to(ROOT)), 'log_sha256': digest(log), 'inputs': input_hashes})
            if result.returncode:
                raise ValueError(name + ' exited ' + str(result.returncode) + '; see ' + str(log.relative_to(ROOT)))
            receipt['assertions'].extend({'id': name, 'status': 'PASS', 'command_id': receipt['commands'][-1]['id']} for name in assertions)
        for name in ['inventory.json', 'vitest-files.json', 'consumer-report.json', 'cache-report.json']:
            receipt['artifacts'].append(evidence.reference(OUT / name))
        receipt['artifacts'].extend(json.loads((OUT / 'consumer-report.json').read_text())['artifacts'])
        if any(digest(ROOT / name) != value for name, value in input_hashes.items()):
            raise ValueError('An actual command input changed during qualification')
        receipt['status'] = 'PASS'
    except Exception as error:
        receipt['missing_obligations'].append(str(error))
    receipt['checked_at'] = datetime.now(timezone.utc).isoformat()
    (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'task': '0.6', 'status': receipt['status'], 'assertions': len(receipt['assertions']), 'missing_obligations': receipt['missing_obligations']}))
    return 0 if receipt['status'] == 'PASS' else 1


if __name__ == '__main__':
    try:
        sys.exit(main() or 0)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
