#!/usr/bin/env python3
"""Execute all nineteen required live fleet/API/CLI/UI assertions."""
import os
from pathlib import Path
import runpy

os.environ['HF_SOURCE_LIVE_FULL'] = '1'
runpy.run_path(str(Path(__file__).with_name('scm_023_live.py')), run_name='__main__')
