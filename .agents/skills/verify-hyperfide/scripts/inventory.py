#!/usr/bin/env python3
import argparse
import difflib
import hashlib
import json
import re
import subprocess
from urllib.parse import unquote
from pathlib import Path

SKILL = Path('.agents/skills/verify-hyperfide')
CLI_OWNERS = {
    'environment': 'projects-environments', 'project': 'projects-environments',
    'file': 'workspace-panels', 'terminal': 'workspace-panels',
    'machine': 'hosts-updates', 'updates': 'hosts-updates',
    'settings': 'settings', 'theme': 'settings', 'voice': 'composer',
    'skill': 'extensions', 'plugin': 'extensions', 'marketplace': 'extensions',
    'provider': 'composer', 'guide': 'compatibility-api',
    'status': 'compatibility-api',
    'helpers': 'compatibility-api', 'environment-helpers': 'projects-environments',
    'browser': 'desktop',
    'thread': 'execution-controls',
}
CORE_PAGES = [
    'navigation', 'projects-environments', 'composer', 'execution-controls',
    'interactions', 'timeline', 'workspace-panels', 'settings', 'extensions',
    'hosts-updates', 'compatibility-api', 'responsive-accessibility',
]
PATTERNS = {
    'cli-command': r'\.command\(\s*["\x27`]([^"\x27`]+)["\x27`]',
    'api-route': r'path:\s*"([^"]+)"\s*,\s*method:\s*"([^"]+)"',
    'app-route': r'(?:export\s+)?const\s+(\w*ROUTE_PATH)\s*=\s*([^;]+);',
    'app-action': r'(?<![.\w])(?:command|paletteHiddenCommand)\(\s*"([^"]+)"',
    'web-route': r'createFileRoute\(\s*"([^"]+)"',
    'plugin-slot': r'app\.slots\.(\w+)\(',
    'plugin-tool': r'hyperfide-platform\.agents\.registerTool\(\{\s*name:\s*"([^"]+)"',
}


def source_files(repo):
    result = subprocess.run(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        cwd=repo, check=True, capture_output=True,
    )
    return sorted({
        name for name in result.stdout.decode().split('\0')
        if name and (repo / name).is_file()
        and not re.search(r'(?:\.test\.|\.spec\.|/tests/|/__tests__/|/test-fixtures)', name)
        and Path(name).suffix in {'.ts', '.tsx', '.json', '.css', '.mjs', '.sh'}
    })


def collect(repo):
    files = source_files(repo)
    groups = {}

    def add(key, paths, owners, extract=False):
        if not paths:
            raise ValueError(f'No sources for {key}; review the inventory scanner')
        docs = [f'features/{owner}.md' for owner in owners]
        for doc in docs:
            if not (repo / SKILL / doc).is_file():
                raise ValueError(f'{key} has no recipe: {doc}')
        digest = hashlib.sha256()
        declarations = set()
        for name in sorted(paths):
            data = (repo / name).read_bytes()
            digest.update(name.encode() + b'\0' + data + b'\0')
            if extract:
                body = data.decode()
                for kind, pattern in PATTERNS.items():
                    for match in re.finditer(pattern, body):
                        value = ' '.join(' '.join(match.groups()).split())
                        declarations.add(f'{kind}: {name}: {value}')
                if key.startswith('plugin:') and 'hyperfide-platform.cli.register(' in body:
                    for match in re.finditer(r'name:\s*"([^"]+)"', body):
                        declarations.add(f'cli-name-candidate: {name}: {match[1]}')
                if key == 'settings-and-actions':
                    for match in re.finditer(r'(?:id:\s*"([^"]+)"|^\s{2,4}(\w+):)', body, re.M):
                        declarations.add(f'setting-or-key: {name}: {match[1] or match[2]}')
        groups[key] = {
            'recipes': docs, 'sourceFiles': len(paths),
            'sourceDigest': digest.hexdigest(),
            'declarations': sorted(declarations),
        }

    def under(*roots):
        return [name for name in files if any(name.startswith(root) for root in roots)]

    cli_paths = under('apps/cli/src/commands/')
    families = {}
    for name in cli_paths:
        family = name.removeprefix('apps/cli/src/commands/').split('/')[0].removesuffix('.ts')
        families.setdefault(family, []).append(name)
    for family, paths in sorted(families.items()):
        owner = CLI_OWNERS.get(family)
        if owner is None:
            raise ValueError(f'Unmapped CLI family: {family}; add recipes and an explicit owner')
        owners = [owner]
        if family == 'thread':
            owners += ['navigation', 'interactions', 'timeline', 'workspace-panels', 'composer']
        add(f'cli:{family}', paths, owners, True)
    add('cli-runtime', [name for name in under('apps/cli/src/') if name not in cli_paths], ['compatibility-api'])
    add('app-routes', ['lib/client-core/src/routes/route-paths.ts'], ['compatibility-api', 'navigation', 'extensions', 'plugin-automations'], True)
    add('settings-and-actions', [
        'apps/web/src/lib/app-command-metadata.ts',
        'apps/web/src/components/settings/settings-sections.ts',
        'lib/domain/src/app-settings.ts', 'lib/domain/src/experiments.ts',
    ], CORE_PAGES, True)
    add('app-and-shared-ui', under('apps/web/src/', 'lib/client-core/src/', 'lib/shared-ui/src/'), CORE_PAGES)
    add('domain-contracts', under('lib/domain/src/'), CORE_PAGES)
    add('public-api-and-sdk', under('contracts/server/src/', 'sdk/client/src/'), CORE_PAGES, True)
    add('plugin-sdk-and-guide', under('sdk/plugins/src/', 'plugins/plugin-api-docs/src/'), ['extensions', 'plugin-plugin-api-docs', 'developer-fixtures'])
    for manifest in sorted((repo / 'plugins').glob('*/package.json')):
        data = json.loads(manifest.read_text())
        if 'hyperfide-platform' not in data:
            continue
        slug = manifest.parent.name
        add(f'plugin:{slug}', under(f'plugins/{slug}/'), [f'plugin-{slug}'], True)
    for app, source_root, owner in [
        ('desktop', 'apps/desktop/', 'desktop'),
        ('mobile', 'apps/mobile/', 'mobile'),
        ('web', 'apps/web/', 'hosted-web'),
        ('connect', 'apps/connect/', 'cloud-gateway'),
        ('demo-server', 'examples/demo-server/', 'developer-fixtures'),
    ]:
        add(f'app:{app}', under(source_root), [owner], True)
    add('server-and-daemon', under('core/server/src/', 'core/host-daemon/src/'), CORE_PAGES)
    add('dev-harness', [name for name in under('tools/workspace/') if 'cloud-dev' in name], ['developer-fixtures'])
    return {'schemaVersion': 1, 'groups': dict(sorted(groups.items()))}


def catalog(snapshot):
    lines = [
        '# Source inventory', '',
        'Generated by `.agents/skills/verify-hyperfide/scripts/inventory.py --write` after recipe reconciliation.',
        'This is a source index and drift baseline, not a live test report.', '',
        'Literal command declarations are local to their source file; they are not',
        'flattened CLI invocation paths. Dynamic registrations require source/help',
        'inspection. `cli-name-candidate` includes literal names in files registering',
        'plugin CLI commands and can include non-command names. All source files in',
        'each group are fingerprinted to catch changes the literal extractor misses.',
        'A recipe link assigns review ownership; it does not prove every declaration',
        'has been exercised or that every behavior has been understood.', '',
    ]
    for name, group in snapshot['groups'].items():
        links = ', '.join(f'[{Path(doc).stem}]({doc})' for doc in group['recipes'])
        lines += [f'## {name}', '', f'{group["sourceFiles"]} source files. Recipes: {links}.', '']
        lines += [f'- `{entry.replace("`", "&#96;")}`' for entry in group['declarations']]
        if group['declarations']:
            lines.append('')
    return '\n'.join(lines)


def validate_index(repo):
    directory = repo / SKILL / 'features'
    index = (directory / 'README.md').read_text()
    listed = {unquote(link) for link in re.findall(r'\]\(([^/()]+)\)', index) if unquote(link).endswith('.md')}
    actual = {path.name for path in directory.glob('*.md') if path.name != 'README.md'}
    if listed != actual:
        raise ValueError(f'Feature index mismatch: unlisted={sorted(actual - listed)}, missing={sorted(listed - actual)}')


def main():
    parser = argparse.ArgumentParser(description='Check HYPERFIDE feature-map source drift without starting the app')
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[4])
    parser.add_argument('--write', action='store_true', help='Accept source baseline after reconciling recipes; does not claim live coverage')
    args = parser.parse_args()
    repo = args.repo.resolve()
    snapshot = collect(repo)
    validate_index(repo)
    path = repo / SKILL / 'inventory.json'
    encoded = json.dumps(snapshot, indent=2, ensure_ascii=False) + '\n'
    index_path = repo / SKILL / 'INVENTORY.md'
    rendered = catalog(snapshot)
    if args.write:
        path.write_text(encoded)
        index_path.write_text(rendered)
        print(f'Wrote {len(snapshot["groups"])} source groups; review the diff before committing')
        return
    if not path.is_file():
        raise ValueError('Missing inventory.json; reconcile recipes before --write')
    old = path.read_text()
    if old != encoded:
        print('Source drift: reconcile affected recipes before accepting a new baseline.')
        print(''.join(difflib.unified_diff(old.splitlines(True), encoded.splitlines(True), fromfile='recorded', tofile='current')))
        raise SystemExit(1)
    if not index_path.is_file() or index_path.read_text() != rendered:
        raise ValueError('INVENTORY.md does not match the recorded inventory')
    print(f'PASS: {len(snapshot["groups"])} source groups match; all linked recipe files exist. Live status is unchanged.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error))
