#!/usr/bin/env python3
"""Prepare an isolated, immutable input bundle for the fleet installer seed image."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[4]


def run(*argv):
    return subprocess.check_output(argv, text=True, stderr=subprocess.PIPE).strip()


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return 'sha256:' + h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base-images', type=Path, required=True)
    parser.add_argument('--resource-plan', type=Path, required=True)
    parser.add_argument('--claude', type=Path)
    parser.add_argument('--claude-sha256')
    parser.add_argument('--python-root', type=Path)
    parser.add_argument('--preparation-candidate', type=Path)
    args = parser.parse_args()
    output = args.output.resolve()
    output.relative_to((ROOT / 'build/fleet/seed').resolve())
    if output.exists():
        raise SystemExit('Seed context already exists; retain it and select a new explicit output path')
    node_root = args.node_root.resolve()
    if run(str(node_root / 'bin/node'), '--version') != 'v24.22.0':
        raise SystemExit('Pinned Node24.22.0 required')
    if json.loads((node_root / 'lib/node_modules/npm/package.json').read_text())['version'] != '11.19.1':
        raise SystemExit('Pinned npm11.19.1 required')
    for source in ['hyperfide', 'build/hyperfide-native', 'core/control-plane/dist/.source-digest.json']:
        if not (ROOT / source).is_file():
            raise SystemExit('Current compiled seed input missing: ' + source)
    subprocess.run([str(node_root / 'bin/node'), str(ROOT / 'deploy/hyperfide/dist-stamp.mjs'), 'check', str(ROOT / 'core/control-plane')], check=True, stdout=subprocess.DEVNULL)
    bases = json.loads(args.base_images.read_text())
    plan = json.loads(args.resource_plan.read_text())
    for name in ['ubuntu', 'sandbox_api']:
        if not re.fullmatch(r'.+@sha256:[0-9a-f]{64}', bases[name]['reference']):
            raise SystemExit('Immutable OCI platform references required')
    output.mkdir(parents=True)
    payload = output / 'payload'
    prefix = payload / 'opt/hyperfide'
    (prefix / 'bin').mkdir(parents=True)
    (prefix / 'runtime/node-lib/node_modules').mkdir(parents=True)
    (prefix / 'lib/hyperfide').mkdir(parents=True)
    binaries = []
    for source, target in [(ROOT / 'hyperfide', prefix / 'bin/hyperfide'), (ROOT / 'build/hyperfide-native', prefix / 'bin/hyperfide-native'), (node_root / 'bin/node', prefix / 'runtime/node'), (Path('/usr/bin/git'), prefix / 'bin/git')]:
        shutil.copy2(source, target)
        binaries.append(source)
    optional_runtime = {}
    if args.claude is not None or args.claude_sha256 is not None:
        if args.claude is None or not re.fullmatch(r'[0-9a-f]{64}', args.claude_sha256 or '') or sha(args.claude) != 'sha256:' + args.claude_sha256:
            raise SystemExit('Exact verified Claude binary and SHA256 are required together')
        if not run(str(args.claude), '--version').startswith('2.1.300 '):
            raise SystemExit('Pinned Claude2.1.300 required')
        shutil.copy2(args.claude, prefix / 'bin/claude')
        (prefix / 'bin/claude').chmod(0o755)
        binaries.append(args.claude)
        optional_runtime['claude'] = '2.1.300'
    if args.python_root is not None:
        python_root = args.python_root.resolve()
        if run(str(python_root / 'bin/python3'), '--version') != 'Python 3.14.8':
            raise SystemExit('Pinned Python3.14.8 required')
        target_python = prefix / 'runtime/python'
        shutil.copytree(python_root, target_python, symlinks=True, ignore=shutil.ignore_patterns('__pycache__'))
        actual_python = Path(run(str(python_root / 'bin/python3'), '-I', '-c', 'import sys; print(sys.executable)')).resolve()
        target_binary = target_python / 'bin/python3.bin'
        if target_binary.is_symlink():
            target_binary.unlink()
        shutil.copy2(actual_python, target_binary)
        launcher = target_python / 'bin/python3'
        if launcher.exists() or launcher.is_symlink():
            launcher.unlink()
        shutil.copy2(ROOT / 'tools/repository/hyperfide-python.sh', launcher)
        launcher.chmod(0o755)
        (payload / 'usr/bin').mkdir(parents=True, exist_ok=True)
        system_launcher = payload / 'usr/bin/python3'
        system_launcher.write_text('#!/bin/sh\nexec /opt/hyperfide/runtime/python/bin/python3 "$@"\n')
        system_launcher.chmod(0o755)
        shutil.copy2(ROOT / 'runtime/supervisory_host.py', prefix / 'runtime/supervisory_host.py')
        binaries.append(actual_python)
        binaries.extend((python_root / 'lib/python3.14/lib-dynload').glob('*.so'))
        optional_runtime['python'] = '3.14.8'
    shutil.copytree(node_root / 'lib/node_modules/npm', prefix / 'runtime/node-lib/node_modules/npm', symlinks=True)
    shutil.copytree('/usr/lib/git-core', prefix / 'runtime/git-core', symlinks=True)
    binaries.extend(p for p in Path('/usr/lib/git-core').iterdir() if p.is_file() and not p.is_symlink() and p.read_bytes()[:4] == b'\x7fELF')
    service = prefix / 'services'
    service.mkdir()
    shutil.copytree(ROOT / 'core/control-plane/dist', service / 'dist')
    for name in ['package.json', 'package-lock.json']:
        shutil.copy2(ROOT / 'core/control-plane' / name, service / name)
    npm_env = dict(os.environ)
    npm_env['PATH'] = str(node_root / 'bin') + os.pathsep + npm_env.get('PATH', '')
    subprocess.run([str(node_root / 'bin/npm'), 'ci', '--omit=dev', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], cwd=service, env=npm_env, check=True, stdout=subprocess.DEVNULL)
    libraries = set()
    for binary in binaries:
        for line in run('/usr/bin/ldd', str(binary)).splitlines():
            match = re.search(r'=> (/[^ ]+)', line)
            if match:
                libraries.add(Path(match[1]))
    for library in sorted(libraries):
        shutil.copy2(library, prefix / 'lib/hyperfide' / library.name)
    (payload / 'etc/ssl/certs').mkdir(parents=True)
    shutil.copy2('/etc/ssl/certs/ca-certificates.crt', payload / 'etc/ssl/certs/ca-certificates.crt')
    (payload / 'usr/local/bin').mkdir(parents=True)
    for name, target in [('node', '/opt/hyperfide/runtime/node'), ('npm', '/opt/hyperfide/runtime/node-lib/node_modules/npm/bin/npm-cli.js'), ('npx', '/opt/hyperfide/runtime/node-lib/node_modules/npm/bin/npx-cli.js'), ('git', '/opt/hyperfide/bin/git'), ('hyperfide', '/opt/hyperfide/bin/hyperfide'), ('hyperfide-native', '/opt/hyperfide/bin/hyperfide-native')]:
        (payload / 'usr/local/bin' / name).symlink_to(target)
    (payload / 'run/hyperfide-stage').mkdir(parents=True)
    (payload / 'sandbox').mkdir()
    if args.preparation_candidate is not None:
        shutil.copytree(args.preparation_candidate.resolve(), prefix / 'prepared', symlinks=True)
    files = []
    for path in sorted(payload.rglob('*')):
        relative = path.relative_to(payload).as_posix()
        if path.is_symlink():
            files.append({'path': relative, 'mode': 'symlink', 'target': os.readlink(path)})
        elif path.is_file():
            files.append({'path': relative, 'mode': oct(path.stat().st_mode & 0o777), 'size': path.stat().st_size, 'digest': sha(path)})
    manifest = {'schema_version': 1, 'kind': 'hyperfide.fleet-bootstrap-seed', 'source_commit': run('git', 'rev-parse', 'HEAD'), 'source_working_tree_dirty': bool(run('git', 'status', '--porcelain')), 'control_source_digest': json.loads((ROOT / 'core/control-plane/dist/.source-digest.json').read_text())['digest'], 'runtime': {'node': '24.22.0', 'npm': '11.19.1', 'git': run('/usr/bin/git', '--version'), 'hyperfide': run(str(ROOT / 'hyperfide'), '--version'), 'sandbox_api': bases['sandbox_api']['labels'].get('org.opencontainers.image.version'), **optional_runtime}, 'base_images': bases, 'files': files}
    canonical = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
    manifest_digest = 'sha256:' + hashlib.sha256(canonical).hexdigest()
    (prefix / 'seed-manifest.json').write_bytes(canonical + b'\n')
    dockerfile = '\n'.join(['FROM ' + bases['ubuntu']['reference'], 'COPY --from=' + bases['sandbox_api']['reference'] + ' /sandbox-api /usr/local/bin/sandbox-api', 'COPY payload/ /', 'ENV PATH="/opt/hyperfide/runtime:/opt/hyperfide/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"', 'ENV LD_LIBRARY_PATH="/opt/hyperfide/lib/hyperfide"', 'ENV GIT_EXEC_PATH="/opt/hyperfide/runtime/git-core"', 'ENV NODE_EXTRA_CA_CERTS="/etc/ssl/certs/ca-certificates.crt"', 'ENV SANDBOX_DISABLE_PROCESS_LOGGING="true"', 'RUN ["/opt/hyperfide/runtime/node", "--version"]', 'RUN ["/opt/hyperfide/runtime/node", "/opt/hyperfide/runtime/node-lib/node_modules/npm/bin/npm-cli.js", "--version"]', 'RUN ["/opt/hyperfide/bin/git", "--version"]', 'RUN ["/opt/hyperfide/bin/hyperfide", "install", "--help"]', 'ENTRYPOINT ["/usr/local/bin/sandbox-api"]', ''])
    optional_probes = ['RUN ' + json.dumps(['/opt/hyperfide/runtime/node', '--input-type=module', '-e', 'await import("/opt/hyperfide/services/dist/preparation/fleet_install.js"); console.log("fleet-installer-runtime-ready")'])]
    optional_probes.append('RUN ' + json.dumps(['/opt/hyperfide/bin/hyperfide-native', '--component', '13.1', '--action', 'connector.describe', '--request-base64', 'e30']))
    if args.claude is not None:
        optional_probes.append('RUN ["/opt/hyperfide/bin/claude", "--version"]')
    if args.python_root is not None:
        optional_probes.append('RUN ["/opt/hyperfide/runtime/python/bin/python3", "--version"]')
        optional_probes.append('RUN ' + json.dumps(['/usr/bin/python3', '-I', '-c', 'import ctypes, os, ssl, sqlite3; assert hasattr(os, "pidfd_open"); print("python-runtime-ready")']))
    if optional_probes:
        dockerfile = dockerfile.replace('ENTRYPOINT ', '\n'.join(optional_probes) + '\nENTRYPOINT ', 1)
    (output / 'Dockerfile').write_text(dockerfile)
    (output / 'blaxel.toml').write_text('name = ' + json.dumps(plan['resource_name']) + '\ntype = "sandbox"\n[build]\nslim = false\nmemoryMb = 4096\nvolumeMb = 0\n')
    (output / '.blaxelignore').write_text('.env\n.env.*\n.git\n')
    receipt = {'schema_version': 1, 'status': 'PREPARED', 'resource_name': plan['resource_name'], 'manifest_digest': manifest_digest, 'files': len(files), 'bytes': sum(item.get('size', 0) for item in files), 'context': str(output)}
    (output.parent / 'prepared-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({key: value for key, value in receipt.items() if key != 'context'}))


if __name__ == '__main__':
    main()
