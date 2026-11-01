#!/usr/bin/env python3
"""Actual migrated PostgreSQL queue selection over declared history and real signatures.

This covers completion eligibility and pagination, not native execution or archive durability.
"""
import json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import identity_fixture
from identity_fixture import IdentityFixture

def main():
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 fixture=None
 try:
  if os.environ.get('HF_COMPLETION_QUEUE_RUNTIME_ROOT'):
   identity_fixture.ROOT=Path(os.environ['HF_COMPLETION_QUEUE_RUNTIME_ROOT']).resolve().parents[1]
  fixture=IdentityFixture();fixture.bootstrap_runner()
  data={'ids':fixture.ids}
  return subprocess.run(['node',str(Path(__file__).with_suffix('.mjs'))],input=json.dumps(data),text=True,cwd=ROOT,env=fixture.env).returncode
 finally:
  if fixture:fixture.close()

if __name__=='__main__':raise SystemExit(main())
