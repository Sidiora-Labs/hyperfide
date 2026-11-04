#!/usr/bin/env python3
"""Drive the deployed signed source product against an existing real fleet candidate."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]


def main():
    filename = os.environ.get('HF_SOURCE_LIVE_JOURNEY_INPUT')
    if not filename or not Path(filename).is_absolute():
        raise RuntimeError('HF_SOURCE_LIVE_JOURNEY_INPUT must name the protected live journey input')
    environment = dict(os.environ)
    environment.setdefault('SOURCE_CONTROL_MODULE_ROOT', str(ROOT / 'core/control-plane/dist/source_control'))
    environment['NODE_OPTIONS'] = '--import=' + str(ROOT / 'node_modules/tsx/dist/loader.mjs') + ' --conditions=source'
    return subprocess.run(['node', str(Path(__file__).with_suffix('.mjs'))], cwd=ROOT, env=environment, timeout=900).returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
