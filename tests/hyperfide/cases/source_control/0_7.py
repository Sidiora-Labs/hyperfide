#!/usr/bin/env python3
"""Exercise moved distribution consumers; unavailable native executors remain unqualified."""
from pathlib import Path
import hashlib
import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[4]
OUT = ROOT / 'build/layout/0.7'
MAPPING = ROOT / 'spec/hyperfide-source-control/repository-layout.json'
SELF = Path(__file__).resolve()
SUPPORT = SELF.parent / 'support/layout_app_consumers.mjs'
TOOLCHAIN = ROOT / 'tests/hyperfide/support/layout_toolchain.py'
sys.path.insert(0, str(TOOLCHAIN.parent))
from layout_toolchain import node_tool


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def evidence_contract():
    helper = SELF.parent / '0_9.py'
    spec = importlib.util.spec_from_file_location('layout_evidence_contract', helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bindings():
    return evidence_contract().capture_bindings()


def inventory():
    mapping = json.loads(MAPPING.read_text())
    rules = sorted(mapping['mappings'], key=lambda row: len(row['source']), reverse=True)
    baseline = mapping['implementation_baseline']
    def moved(name):
        for row in rules:
            if name == row['source'] or name.startswith(row['source'].rstrip('/') + '/'):
                return row['destination'].rstrip('/') + name[len(row['source'].rstrip('/')):]
        return name
    original = subprocess.check_output(['git', 'ls-tree', '-r', baseline], cwd=ROOT, text=True)
    manifests = assets = patches = 0
    for line in original.splitlines():
        identity, name = line.split('\t', 1)
        target = moved(name)
        if not target.startswith(('apps/', 'plugins/', 'extensions/', 'examples/', 'assets/', 'patches/')):
            continue
        current = ROOT / target
        if name.endswith('/package.json') and (ROOT / target).is_file():
            old = json.loads(subprocess.check_output(['git', 'show', baseline + ':' + name], cwd=ROOT))
            new = json.loads(current.read_text())
            for field in ['name', 'version', 'license', 'publisher', 'bin']:
                if old.get(field) != new.get(field):
                    raise AssertionError('Distributed identity changed: ' + target + ':' + field)
            for dep_kind in ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']:
                for dep, version in old.get(dep_kind, {}).items():
                    if new.get(dep_kind, {}).get(dep) != version:
                        raise AssertionError('Declared dependency target changed: ' + target + ':' + dep)
            if target == 'apps/launcher/package.json':
                for path in new['bin'].values():
                    if not (current.parent / path).is_file():
                        raise AssertionError('Missing installed launcher bin: ' + path)
            manifests += 1
        is_patch = target.startswith('patches/')
        is_asset = target.startswith('assets/') or '/assets/' in target and current.suffix.lower() in ['.png', '.svg', '.jpg', '.webp', '.ico', '.icns', '.ttf', '.woff', '.woff2']
        if is_patch or is_asset:
            if not current.is_file():
                raise AssertionError('Missing moved asset/patch: ' + target)
            data = current.read_bytes()
            actual = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            if actual != identity.split()[2]:
                raise AssertionError('Authored asset/patch bytes changed: ' + target)
            patches += int(is_patch)
            assets += int(is_asset)
    if not manifests or not assets or not patches:
        raise AssertionError('Actual manifest, asset and authored-patch inventories required')
    print(json.dumps({'status': 'PASS', 'manifests': manifests, 'assets': assets, 'patches': patches}))


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def startup(node):
    with tempfile.TemporaryDirectory(prefix='runtime-', dir=OUT) as directory:
        directory = Path(directory)
        server_port, host_port = free_port(), free_port()
        env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(directory), 'NODE_ENV': 'production',
               'HYPERFIDE_DATA_DIR': str(directory / 'data'), 'HYPERFIDE_SERVER_PORT': str(server_port),
               'HYPERFIDE_HOST_DAEMON_PORT': str(host_port), 'HYPERFIDE_SERVER_URL': 'http://127.0.0.1:' + str(server_port),
               'HYPERFIDE_APP_URL': 'http://127.0.0.1:' + str(server_port), 'HYPERFIDE_SERVER_BIND_HOST': '127.0.0.1',
               'HYPERFIDE_HOST_DAEMON_AUTO_UPDATE': 'false'}
        children = []
        try:
            for name, entry, port in [('server', 'core/server/dist/index.js', server_port), ('host', 'core/host-daemon/dist/index.js', host_port)]:
                if name == 'host':
                    # Obtain real loopback enrollment from the isolated running server.
                    request = urllib.request.Request(
                        'http://127.0.0.1:' + str(server_port) + '/internal/hosts/enroll-key',
                        data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
                    with urllib.request.urlopen(request, timeout=3) as response:
                        enrollment = json.loads(response.read())
                    env['HYPERFIDE_HOST_ENROLL_KEY'] = enrollment['enrollKey']
                    env['HYPERFIDE_HOST_ID'] = enrollment['hostId']
                log = OUT / (name + '-startup.log')
                with log.open('wb') as stream:
                    child = subprocess.Popen([node, str(ROOT / entry)], cwd=ROOT / 'apps/web', env=env, stdout=stream, stderr=stream, start_new_session=True)
                children.append(child)
                deadline = time.monotonic() + 35
                while time.monotonic() < deadline:
                    if child.poll() is not None:
                        raise RuntimeError(name + ' exited ' + str(child.returncode) + ': ' + log.read_text()[-1800:])
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=1) as response:
                            body = response.read()
                        if name == 'server' and not json.loads(body).get('ok') or name == 'host' and body.decode().strip() != 'ok':
                            raise AssertionError('Actual health response differs')
                        break
                    except OSError:
                        time.sleep(.15)
                else:
                    raise RuntimeError(name + ' health deadline expired')
            with urllib.request.urlopen('http://127.0.0.1:' + str(server_port) + '/', timeout=3) as response:
                html = response.read().decode()
            paths = re.findall(r'(?:src|href)="(/[^" ]+\.(?:js|css))"', html)
            if not paths:
                raise AssertionError('Actual app HTML has no packaged JS/CSS references')
            for asset in paths[:3]:
                with urllib.request.urlopen('http://127.0.0.1:' + str(server_port) + asset, timeout=3) as response:
                    if not response.read():
                        raise AssertionError('Empty packaged app asset')
            print(json.dumps({'status': 'PASS', 'server': 'healthy', 'host': 'healthy', 'app_assets_fetched': len(paths[:3])}))
        finally:
            for child in children:
                if child.poll() is None:
                    os.killpg(child.pid, signal.SIGTERM)
            for child in children:
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=3)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if '--inventory' in sys.argv:
        inventory()
        return 0
    if '--startup' in sys.argv:
        startup(sys.argv[-1])
        return 0
    receipt = {'schema_version': 1, 'task': '0.7', 'status': 'UNQUALIFIED', **bindings(), 'commands': [], 'assertions': [], 'artifacts': [], 'gaps': []}
    node = str(node_tool((ROOT / '.nvmrc').read_text().strip(), 'HYPERFIDE_LAYOUT_NODE22'))
    base_env = {'PATH': str(Path(node).parent) + ':/usr/bin:/bin', 'HOME': str(OUT / 'home'), 'HYPERFIDE_CLI_REEXEC': '1', 'NO_COLOR': '1'}
    Path(base_env['HOME']).mkdir(exist_ok=True)
    def command(identity, args, cwd=ROOT, inputs=(), timeout=90):
        log = OUT / (identity + '.log')
        started = time.monotonic()
        try:
            result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=base_env, capture_output=True, text=True, timeout=timeout)
            code, output = result.returncode, result.stdout + result.stderr
        except subprocess.TimeoutExpired as error:
            code, output = 124, str(error)
        log.write_text(output)
        receipt['commands'].append({'id': identity, 'command': [str(arg) for arg in args], 'exit_code': code, 'duration_ms': int((time.monotonic() - started) * 1000), 'log': str(log.relative_to(ROOT)), 'log_sha256': digest(log), 'inputs': {str(path.relative_to(ROOT)): digest(path) for path in [SELF, SELF.parent / '0_9.py', MAPPING, TOOLCHAIN, ROOT / '.nvmrc', *inputs] if path.is_file()}})
        if code:
            receipt['gaps'].append({'id': identity, 'status': 'FAIL', 'exit_code': code, 'log': str(log.relative_to(ROOT))})
        return code == 0
    def assertion(identity, passed, command_id, reason=None):
        receipt['assertions'].append({'id': identity, 'status': 'PASS' if passed else 'UNRUN' if command_id is None else 'FAIL', 'command_id': command_id, **({'reason': reason} if reason else {})})
    command('runtime-version', [node, '--version'])
    inv = command('inventories', [sys.executable, SELF, '--inventory'], inputs=[ROOT / 'apps/launcher/package.json'])
    assertion('assets-bins-plugin-identities', inv, 'inventories')
    cli_root = command('cli-root', [node, ROOT / 'apps/cli/dist/index.js', '--help'], inputs=[ROOT / 'apps/cli/dist/index.js'])
    cli_nested = command('cli-nested', [node, ROOT / 'apps/cli/dist/index.js', '--help'], cwd=ROOT / 'plugins/hyperfide-dispatch', inputs=[ROOT / 'apps/cli/dist/index.js'])
    live = command('web-server-host', [sys.executable, SELF, '--startup', node], inputs=[ROOT / name for name in ['core/server/dist/index.js', 'core/host-daemon/dist/index.js', 'apps/web/dist/index.html']], timeout=95)
    assertion('web-server-host-startup', live and cli_root and cli_nested, 'web-server-host')
    scaffold = command('plugin-scaffold', [node, '--conditions=source', '--import', 'tsx', SUPPORT, 'scaffold'], inputs=[SUPPORT, ROOT / 'lib/templates/src/plugin-scaffold.ts', ROOT / 'tools/plugin-build/src/build-plugin-server.ts'], timeout=120)
    assertion('plugin-scaffold-consumer', scaffold, 'plugin-scaffold')
    command('plugin-registry', [node, ROOT / 'tools/plugin-registry/scripts/build-registry.mjs', '--check'], inputs=[ROOT / 'tools/plugin-registry/scripts/build-registry.mjs'])
    extensions = command('extension-consumers', [node, SUPPORT, 'extensions'], inputs=[SUPPORT])
    vsix = extensions
    for folder in ['vscode', 'kvx-vscode']:
        source = ROOT / 'extensions' / folder
        packaged = command('vsix-' + folder, [sys.executable, '-I', ROOT / 'tools/repository/package-vsix.py', '--source', source, '--out', OUT / folder], cwd=ROOT / 'apps/web', inputs=[ROOT / 'tools/repository/package-vsix.py', source / 'package.json'])
        files = list((OUT / folder).glob('*.vsix'))
        checked = bool(files) and command('vsix-check-' + folder, [sys.executable, '-I', ROOT / 'tools/repository/package-vsix.py', '--source', source, '--check', files[0]], inputs=[ROOT / 'tools/repository/package-vsix.py', source / 'package.json'])
        vsix = vsix and packaged and checked
        for file in files:
            receipt['artifacts'].append({'path': str(file.relative_to(ROOT)), 'sha256': digest(file)})
    assertion('vsix-packaging', vsix, 'vsix-check-kvx-vscode' if vsix else 'extension-consumers')
    native_passed = True
    native_command = None
    contract = evidence_contract()
    for platform, assertion_id, filename in [('desktop', 'desktop-linux-packaged-startup', 'desktop-receipt.json'), ('android', 'mobile-android-packaged-startup', 'android-receipt.json')]:
        native_path = Path(os.environ.get('HYPERFIDE_LAYOUT_' + platform.upper() + '_RECEIPT', str(OUT / 'native-packaging' / filename)))
        if not native_path.is_file():
            native_passed = False
            receipt['gaps'].append({'id': 'native-' + platform, 'status': 'UNRUN', 'required': assertion_id})
            continue
        try:
            native_path = contract.local(str(native_path.relative_to(ROOT)))
            native = contract.document(native_path)
            receipt['artifacts'].append(contract.reference(native_path))
            if native.get('schema_version') != 1 or native.get('status') != 'PASS':
                native_passed = False
                receipt['gaps'].append({'id': 'native-' + platform, 'status': 'UNRUN', 'details': native.get('gaps', native.get('reason', 'Supported-executor packaging remains unqualified'))})
                continue
            for key in ['mapping_sha256', 'layout_generation', 'source_snapshot_sha256', 'source_snapshot']:
                if native.get(key) != receipt[key]:
                    raise ValueError('Native packaging input binding differs: ' + key)
            revision = native.get('source_revision')
            if not isinstance(revision, str) or subprocess.run(['git', 'merge-base', '--is-ancestor', revision, receipt['source_revision']], cwd=ROOT, capture_output=True).returncode:
                raise ValueError('Native packaging qualifying revision is not an ancestor')
            tree = subprocess.check_output(['git', 'rev-parse', revision + '^{tree}'], cwd=ROOT, text=True).strip()
            if native.get('source_tree_id') != tree:
                raise ValueError('Native packaging qualifying tree differs')
            commands, _observed = contract.validate_execution(native, [assertion_id])
            for artifact in native.get('artifacts', []):
                if not isinstance(artifact, dict) or contract.digest(contract.local(artifact.get('path'))) != artifact.get('sha256'):
                    raise ValueError('Native packaged artifact changed')
                receipt['artifacts'].append(artifact)
            prefix = 'native-' + platform + ':'
            for item in commands:
                receipt['commands'].append(dict(item, id=prefix + item['id']))
            for item in native['assertions']:
                receipt['assertions'].append(dict(item, id=prefix + item['id'], command_id=prefix + item['command_id']))
            native_command = native_command or prefix + next(item['command_id'] for item in native['assertions'] if item['id'] == assertion_id)
            receipt.setdefault('platform_limitations', {})[platform] = native.get('platform_limitations', native.get('unavailable_platforms', []))
        except Exception as error:
            native_passed = False
            receipt['gaps'].append({'id': 'native-' + platform + '-evidence', 'status': 'FAIL', 'reason': str(error)})
    assertion('desktop-mobile-packaging', native_passed, native_command if native_passed else None, None if native_passed else 'Awaiting hash-bound actual Linux desktop and Android packaging/execution evidence; unavailable OS execution remains explicit.')
    if not receipt['gaps'] and all(item['status'] == 'PASS' for item in receipt['assertions']):
        receipt['status'] = 'PASS'
    (OUT / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': receipt['status'], 'assertions': receipt['assertions'], 'gaps': receipt['gaps']}))
    return 0 if receipt['status'] == 'PASS' else 1 if any(gap['status'] == 'FAIL' for gap in receipt['gaps']) else 77


if __name__ == '__main__':
    raise SystemExit(main())
