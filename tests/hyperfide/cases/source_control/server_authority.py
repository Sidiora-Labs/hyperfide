#!/usr/bin/env python3
"""Run the standalone listener against a genuine independently advanced journal."""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
    spec=importlib.util.spec_from_file_location('identity_fixture',ROOT/'tests/hyperfide/support/identity_fixture.py');identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
    backend=subprocess.Popen(['node','--input-type=module','-e',"import {createSourceS3Fixture} from './tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],cwd=ROOT,stdout=subprocess.PIPE,text=True)
    fixture=None
    try:
        if not select.select([backend.stdout],[],[],15)[0]:raise RuntimeError('Object backend unavailable')
        s=json.loads(backend.stdout.readline())
        env={'HF_SOURCE_S3_ENDPOINT':s['endpoint'],'HF_SOURCE_S3_REGION':s['region'],'HF_SOURCE_S3_BUCKET':s['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':s['accessKey'],'HF_SOURCE_S3_SECRET_ACCESS_KEY':s['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1','HF_SOURCE_CURSOR_KEY':'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk','HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608','HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
        fixture=identity.IdentityFixture(extra_env=env)
        fixture.child.terminate();fixture.child.wait(timeout=15);old_pid=fixture.child.pid;fixture.child=None
        inputs=fixture.path/'standalone-input.json';inputs.write_text(json.dumps({'admin_url':fixture.url,'deployment':fixture.ids['deployment'],'epoch':fixture.ids['epoch'],'journal':str(fixture.authority_journal),'old_component_pid':old_pid}));inputs.chmod(0o600)
        return subprocess.run(['node','--import','tsx',str(ROOT/'tests/hyperfide/support/native_source_server_authority.mjs')],cwd=ROOT,env={**fixture.env,'SOURCE_SERVER_AUTHORITY_INPUT':str(inputs)},timeout=240).returncode
    finally:
        if fixture:fixture.close()
        backend.terminate()
        try:backend.wait(timeout=10)
        except subprocess.TimeoutExpired:backend.kill();backend.wait()
if __name__=='__main__':raise SystemExit(main())
