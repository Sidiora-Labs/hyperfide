#!/usr/bin/env python3
"""Execute the native qualification adapter through the production signed endpoint."""
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
if __name__ == '__main__':
    raise SystemExit(subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/cases/source_control/signed_transport.py')], cwd=ROOT, env={**os.environ, 'HF_SOURCE_QUALIFICATION': '1'}).returncode)
