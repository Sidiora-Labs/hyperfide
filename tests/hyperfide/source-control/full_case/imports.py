#!/usr/bin/env python3
"""Run the complete bounded import or kernel-isolated cutover case."""
import subprocess
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
if __name__=='__main__':
    raise SystemExit(subprocess.run([sys.executable,str(Path(__file__).with_name('core.py')),'--definitions','tests/hyperfide/source-control/full_case/import_cases.json',*sys.argv[1:]],cwd=ROOT).returncode)
