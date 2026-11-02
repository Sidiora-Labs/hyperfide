"""Compile native source modules and run an actor on an owned temporary PostgreSQL server."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]


def run_source_actor(actor_path, migrations=None, timeout=120):
    database = os.environ.get('DATABASE_URL', '')
    if not database:
        env = {k: v for k, v in os.environ.items() if k != 'DATABASE_URL'}
        return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--',
                               sys.executable, str(Path(sys.argv[0]).resolve()), *sys.argv[1:]],
                              cwd=ROOT, env=env).returncode
    host = parse_qs(urlparse(database).query).get('host', [''])[0]
    if not host.startswith('/tmp/hyperfide/hf-withpg-'):
        raise RuntimeError('Native source tests require an owned withpg socket')
    output = ROOT / 'build/source-control/actors'
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='native-source-', dir=output) as temporary:
        folder = Path(temporary)
        (folder / 'package.json').write_text('{"type":"module"}\n')
        (folder / 'node_modules').symlink_to(ROOT / 'core/control-plane/node_modules', target_is_directory=True)
        modules = ROOT / 'core/control-plane/src/source_control'
        config = {'compilerOptions': {'target': 'ES2023', 'module': 'NodeNext', 'moduleResolution': 'NodeNext',
                  'rootDir': str(ROOT / 'core/control-plane/src'), 'outDir': str(folder / 'control'),
                  'strict': True, 'noUncheckedIndexedAccess': True, 'exactOptionalPropertyTypes': True,
                  'noEmitOnError': True, 'skipLibCheck': True, 'types': ['node'],
                  'typeRoots': [str(ROOT / 'core/control-plane/node_modules/@types')]},
                  'files': [str(path) for path in sorted(modules.glob('*.ts'))]}
        config_path = folder / 'tsconfig.json'
        config_path.write_text(json.dumps(config))
        subprocess.run([str(ROOT / 'core/control-plane/node_modules/.bin/tsc'), '-p', str(config_path)],
                       cwd=ROOT, check=True)
        subprocess.run([str(ROOT / 'core/control-plane/node_modules/.bin/tsc'), '-p',
                        str(ROOT / 'sdk/source-control/tsconfig.json'), '--outDir', str(folder / 'sdk')],
                       cwd=ROOT, check=True)
        env = dict(os.environ, SOURCE_CONTROL_MODULE_ROOT=str(folder / 'control/source_control'),
                   SOURCE_CONTROL_SDK_MODULE_ROOT=str(folder / 'sdk'),
                   SOURCE_CONTROL_MIGRATIONS=json.dumps(migrations or [
                       '0736-source-control-storage.sql', '0737-source-control-metadata.sql',
                       '0738-source-control-capabilities.sql', '0739-source-control-workspaces.sql']))
        return subprocess.run(['node', str(Path(actor_path).resolve()), str(folder / 'control/source_control')],
                              cwd=ROOT, env=env, timeout=timeout).returncode
