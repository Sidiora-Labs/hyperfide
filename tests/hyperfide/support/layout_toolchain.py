"""Select exact layout-test tool versions without requiring one host install path."""
from pathlib import Path
import json
import os
import shutil
import subprocess


def _select(variable, candidates, expected, env):
    explicit = os.environ.get(variable)
    choices = [explicit] if explicit else candidates
    observed = []
    for candidate in dict.fromkeys(str(item) for item in choices if item):
        selected = shutil.which(candidate) if not Path(candidate).is_absolute() else candidate
        if not selected or not Path(selected).is_file():
            continue
        try:
            result = subprocess.run([selected, '--version'], env=env, capture_output=True,
                                    text=True, timeout=15)
        except (OSError, subprocess.TimeoutExpired):
            continue
        version = result.stdout.strip()
        if result.returncode == 0 and version == expected:
            return Path(selected).absolute()
        observed.append(version[:64])
    raise FileNotFoundError('CAPABILITY_MISSING: ' + variable + ' requires ' + expected
                            + '; observed ' + repr(observed))


def node_tool(version, variable):
    env = dict(os.environ)
    env.pop('NODE_OPTIONS', None)
    env.pop('NODE_PATH', None)
    nvm = Path(os.environ.get('NVM_DIR', str(Path.home() / '.nvm')))
    return _select(variable, [shutil.which('node'), nvm / 'versions/node' / ('v' + version) / 'bin/node'],
                   'v' + version, env)


def pnpm_tool(root, node):
    package_manager = json.loads((root / 'package.json').read_text())['packageManager']
    if not package_manager.startswith('pnpm@'):
        raise ValueError('Declared pnpm package manager required')
    version = package_manager.removeprefix('pnpm@').split('+', 1)[0]
    env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get('PATH', ''),
               COREPACK_ENABLE_NETWORK='0')
    env.pop('NODE_OPTIONS', None)
    env.pop('NODE_PATH', None)
    cache = Path(os.environ.get('COREPACK_HOME', str(Path.home() / '.cache/node/corepack')))
    return _select('HYPERFIDE_LAYOUT_PNPM', [shutil.which('pnpm'),
                   cache / 'v1/pnpm' / version / 'bin/pnpm.cjs'], version, env)
