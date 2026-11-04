#!/usr/bin/env python3
"""Capture a reviewed workspace case through the shared native capture pipeline."""
import argparse
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--case',choices=['SCM-010','SCM-011'],required=True)
    args=parser.parse_args()
    name='source-backed-sparse-real-s3' if args.case=='SCM-010' else 'linux-fuse7-real-s3'
    registration=ROOT/'tests/hyperfide/source-control/registrations'/('full-'+args.case+'-'+name+'.json')
    raise SystemExit(subprocess.run([sys.executable,str(Path(__file__).with_name('prepare_capture.py')),'--registration',str(registration)],cwd=ROOT).returncode)
