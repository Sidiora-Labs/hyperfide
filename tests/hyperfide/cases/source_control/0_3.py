#!/usr/bin/env python3
"""Layout 0.3: pinned inventory, reversible dry-run and baseline observations.

Mutations below challenge the inventory validator using the actual repository
mapping and manifests. They do not simulate successful file moves or qualify
product runtimes. Absent dependencies are recorded, not treated as build passes.
"""
from __future__ import annotations

import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import traceback

ROOT = Path(__file__).resolve().parents[4]
PACK = ROOT / 'spec/hyperfide-source-control'
OUT = ROOT / 'build/layout/0.3'
RESULTS: dict[str, bool] = {}
DETAILS: dict[str, object] = {}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(name: str, condition: bool, detail=None) -> None:
    RESULTS[name] = bool(condition)
    if detail is not None:
        DETAILS[name] = detail
    if not condition:
        print('FAIL ' + name, file=sys.stderr)


def command(name: str, argv: list[str], *, timeout=20) -> dict:
    env = dict(os.environ, COREPACK_ENABLE_NETWORK='0', CI='1')
    try:
        result = subprocess.run(argv, cwd=ROOT, env=env, text=True,
                                capture_output=True, timeout=timeout)
        rc, stdout, stderr = result.returncode, result.stdout, result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        rc, stdout, stderr = None, '', str(error)
    path = OUT / (name + '.log')
    path.write_text(stdout + stderr)
    return {'command': argv, 'exit_code': rc, 'status': 'OBSERVED' if rc == 0 else 'UNAVAILABLE_OR_FAILED',
            'log': str(path.relative_to(ROOT)), 'log_sha256': digest(path),
            'stdout': stdout[:3000], 'stderr': stderr[:1500]}


def baseline() -> dict:
    probes = {}
    for name, argv in [
        ('native-components', ['python3', 'scripts/hyperfide-native-components.py', '--check']),
        ('native-sources', ['python3', 'scripts/hyperfide-native-components.py', '--sources']),
        ('native-headers', ['python3', 'scripts/hyperfide-native-components.py', '--headers']),
        ('native-libraries', ['python3', 'scripts/hyperfide-native-components.py', '--libraries']),
        ('python-version', ['python3', '--version']),
        ('node-version', ['node', '--version']),
        ('npm-version', ['npm', '--version']),
        ('pnpm-version-offline', ['pnpm', '--version']),
        ('compiler-version', ['cc', '--version']),
        ('make-version', ['make', '--version']),
    ]:
        probes[name] = command(name, argv)
    profiles = {}
    for path in ['platform/package.json', 'services/hyperfide/package.json']:
        data = json.loads((ROOT / path).read_text())
        profiles[path] = {key: data.get(key) for key in ['name', 'version', 'engines', 'packageManager', 'scripts', 'devDependencies']}
    profiles['platform/.nvmrc'] = (ROOT / 'platform/.nvmrc').read_text().strip()
    # Match the existing literal workspace patterns and Vitest discovery separately.
    # Preserve their actual contract bytes and discovered results, never conflate them.
    workspace = ROOT / 'platform'
    workspace_text = (workspace / 'pnpm-workspace.yaml').read_text()
    declared_patterns = [json.loads(line.strip()[2:]) for line in workspace_text.splitlines() if line.strip().startswith('- ')]
    patterns = [pattern for pattern in declared_patterns if not pattern.startswith('!')]
    exclusions = [pattern[1:] for pattern in declared_patterns if pattern.startswith('!')]
    packages = sorted({str(path.relative_to(ROOT)) for pattern in patterns
                       for path in workspace.glob(pattern + '/package.json')
                       if not any(Path(str(path.parent.relative_to(workspace))).match(pattern) for pattern in exclusions)})
    vitest_source = (workspace / 'vitest.config.ts').read_text()
    literal = re.search(r'const workspaceRoots = \[(.*?)\] as const;', vitest_source, re.S)
    if literal is None:
        raise ValueError('Vitest discovery changed; baseline needs its actual consumer contract')
    vitest_roots = re.findall(r'"([^"]+)"', literal.group(1))
    projects = sorted(str(path.relative_to(ROOT)) for parent in vitest_roots
                      for path in (workspace / parent).glob('*/vitest.config.ts'))
    checks = {path: {'present': (ROOT / path).exists(),
                    'meaning': 'presence only; runtime/build qualification UNRUN'} for path in [
        'platform/node_modules', 'services/hyperfide/node_modules', 'services/hyperfide/dist',
        'hyperfide', 'cg', 'build/hyperfide-native']}
    return {'probes': probes, 'declared_profiles': profiles, 'workspace_packages': packages,
            'workspace_package_count': len(packages), 'workspace_patterns': declared_patterns, 'vitest_roots': vitest_roots,
            'packages_with_test_script': sum(bool(json.loads((ROOT / p).read_text()).get('scripts', {}).get('test')) for p in packages),
            'root_vitest_projects': projects, 'root_vitest_project_count': len(projects),
            'workspace_definition_sha256': digest(workspace / 'pnpm-workspace.yaml'),
            'test_discovery_definition_sha256': digest(workspace / 'vitest.config.ts'),
            'test_coverage_note': 'Root Vitest excludes plugins; Turbo uses package scripts. Counts are membership, not executed test results.',
            'presence': checks, 'checkout_build': 'UNRUN', 'product_runtime': 'UNRUN',
            'toolchain_note': 'Scoped development, control service and release pins remain distinct. Installed versions are observations, not proof of pinned qualification.'}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    report = {'schema_version': 1, 'task': '0.3', 'case': 'SCM-025',
              'scope': 'inventory and baseline capture only; no relocation',
              'case_qualification': 'UNRUN', 'checked_at': datetime.now(timezone.utc).isoformat()}
    try:
        spec = importlib.util.spec_from_file_location('layout_inventory', ROOT / 'tools/repository/layout-inventory.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        mapping = json.loads((PACK / 'repository-layout.json').read_text())
        revision = mapping['implementation_baseline']
        inventory = module.generate_inventory(ROOT, mapping, revision)
        (OUT / 'inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
        report.update({'revision': inventory['revision'], 'mapping_sha256': digest(PACK / 'repository-layout.json'),
                       'inventory': 'build/layout/0.3/inventory.json', 'inventory_sha256': digest(OUT / 'inventory.json')})
        tracked = subprocess.check_output(['git', 'ls-tree', '-r', '--name-only', '-z', revision], cwd=ROOT).decode().split('\0')
        tracked = {p for p in tracked if p}
        files = inventory['files']
        check('inventory.exact-tracked-coverage', {p['source'] for p in files} == tracked)
        check('inventory.content-type-mode', all(p.get('blob_id') and p.get('mode') and isinstance(p.get('size'), int) for p in files))
        check('inventory.no-runtime-drift', not inventory['worktree_drift'], inventory['worktree_drift'])
        check('inventory.valid', inventory['valid'])
        kinds = {row['classification'] for row in inventory['rewrite_obligations']}
        check('references.distinct-source-artifact-history', {'source', 'installed-artifact', 'historical'} <= kinds, sorted(kinds))
        mapped = {p['source']: p for p in files}
        check('mapping.sdk-category', mapped['platform/packages/sdk/package.json']['target'] == 'sdk/client/package.json')
        check('mapping.control-category', mapped['services/hyperfide/package.json']['target'] == 'core/control-plane/package.json')
        check('mapping.extension-longest-prefix', mapped['kvx/editors/vscode/package.json']['target'] == 'extensions/kvx-vscode/package.json')
        inputs = [item['source'] for move in inventory['inverse_plan'] for item in move['inputs']]
        check('inverse.retains-every-original', len(inputs) == len(files) and set(inputs) == tracked)
        merges = [move for move in inventory['inverse_plan'] if len(move['inputs']) > 1]
        check('inverse.merge-is-not-automatic', bool(merges) and all(not move['automatic'] for move in merges))

        def refused(name, transform):
            bad = copy.deepcopy(mapping)
            transform(bad)
            try:
                module.generate_inventory(ROOT, bad, revision)
            except module.InventoryError as error:
                check(name, True, str(error))
            else:
                check(name, False)

        refused('reject.unmapped-source', lambda m: m.update(mappings=[r for r in m['mappings'] if r['source'] != 'platform/apps/app']))
        refused('reject.duplicate-rule', lambda m: m['mappings'].append(copy.deepcopy(m['mappings'][0])))
        def duplicate_target(m, folded=False):
            for rule in m['mappings']:
                if rule['source'] == 'platform/packages/sdk':
                    rule['destination'] = 'SDK/PLUGINS' if folded else 'sdk/plugins'
        refused('reject.destination-collision', duplicate_target)
        refused('reject.casefold-collision', lambda m: duplicate_target(m, True))
        def escape(m):
            m['mappings'][0]['destination'] = '../escape'
        refused('reject.path-escape', escape)
        def artifact(m):
            for rule in m['mappings']:
                if rule['source'] == 'services/hyperfide':
                    rule['destination'] = 'services/dist'
        refused('reject.source-artifact-confusion', artifact)

        # Comparator mutations use real inventories as data, never a fake runtime.
        # A hypothetical path-transformed report tests comparison logic only.
        relocated = copy.deepcopy(inventory)
        relocated['files'] = []
        for move in inventory['inverse_plan']:
            row = copy.deepcopy(mapped[move['inputs'][0]['source']])
            row['source'] = row['target'] = move['target']
            relocated['files'].append(row)
        for package in relocated['packages']:
            package['source'] = package['target']
        # Check negative drift detection independently of rewrite/merge obligations.
        changed = copy.deepcopy(relocated)
        chosen = next(p for p in changed['packages'] if p.get('name') == '@hyperfide/sdk')
        chosen['name'] = '@unexpected/renamed-sdk'
        issues = module.compare_inventories(inventory, changed)
        check('compare.reject-package-identity-drift', any('package' in str(i).lower() and ('identity' in str(i).lower() or 'name' in str(i).lower()) for i in issues), issues[:12])
        changed = copy.deepcopy(relocated)
        chosen = next(p for p in changed['packages'] if p.get('name') == '@hyperfide/control-services')
        chosen.setdefault('dependencies', {})['pg'] = '0.0.0-invalid'
        issues = module.compare_inventories(inventory, changed)
        check('compare.reject-dependency-drift', any('depend' in str(i).lower() for i in issues), issues[:12])
        changed = copy.deepcopy(relocated)
        chosen = next(p for p in changed['files'] if p['source'] == 'core/native/src/main.c')
        chosen['mode'] = '100755' if chosen['mode'] != '100755' else '100644'
        issues = module.compare_inventories(inventory, changed)
        check('compare.reject-mode-drift', any('mode' in str(i).lower() for i in issues), issues[:12])

        observations = baseline()
        (OUT / 'baseline.json').write_text(json.dumps(observations, indent=2) + '\n')
        report.update({'baseline': 'build/layout/0.3/baseline.json', 'baseline_sha256': digest(OUT / 'baseline.json')})
        check('baseline.native-discovery-recorded', all(k in observations['probes'] for k in ['native-components', 'native-sources', 'native-headers', 'native-libraries']))
        check('baseline.workspace-membership', bool(observations['workspace_packages']) and bool(observations['root_vitest_projects']))
        check('baseline.distinguishes-unrun-runtime', observations['checkout_build'] == observations['product_runtime'] == 'UNRUN')
        report['summary'] = {'tracked_files': len(files), 'package_manifests': len(inventory['packages']),
                             'merge_targets': len(merges), 'workspace_packages': observations['workspace_package_count'],
                             'root_vitest_projects': observations['root_vitest_project_count']}
        report['implementation_inputs'] = {str(p.relative_to(ROOT)): digest(p) for p in [
            ROOT / 'tools/repository/layout-inventory.py', Path(__file__), PACK / 'repository-layout.json']}
    except Exception:
        check('driver.exception', False, traceback.format_exc())
        traceback.print_exc()
    report['assertions'] = RESULTS
    report['details'] = DETAILS
    report['status'] = 'PASS' if RESULTS and all(RESULTS.values()) else 'FAIL'
    (OUT / 'receipt.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'status': report['status'], 'task': '0.3', 'assertions': len(RESULTS),
                      'failed': [k for k,v in RESULTS.items() if not v],
                      'receipt': 'build/layout/0.3/receipt.json', 'case_qualification': 'UNRUN'}))
    return int(report['status'] != 'PASS')


if __name__ == '__main__':
    raise SystemExit(main())
