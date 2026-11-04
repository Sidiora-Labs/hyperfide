#!/usr/bin/env python3
"""Retain native source namespace in an authenticated fault capture."""
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'tests/hyperfide/support'))
from identity_fixture import IdentityFixture, uid


def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable, str(ROOT/'tests/hyperfide/support/withpg.py'), '--', sys.executable, __file__], cwd=ROOT).returncode
    fixture = IdentityFixture()
    try:
        scope = {'organisation_id':fixture.ids['organisation'], 'repository_id':uid(), 'security_domain_id':uid()}
        base = {'origin':fixture.origin, 'run_id':fixture.ids['run'], 'organisation_id':fixture.ids['organisation'], 'credential_id':fixture.ids['operator'], 'key_file':str(fixture.keys['operator']['path']), 'ca_file':str(fixture.ca), 'case':'path_escape', 'authority_epoch':fixture.ids['epoch'], 'timeout_ms':10000}
        module = Path(os.environ.get('HF_FAULT_JOURNAL_MODULE', ROOT/'tests/hyperfide/support/fleet_fault_journal.mjs'))
        cases = [
            ('native', {'source_backend':'native','source_scope':scope,'source_object_id':'sha256:'+'1'*64}, True),
            ('legacy-git', {'source_object_id':'2'*40}, True),
            ('tagged-git', {'source_backend':'git','source_object_id':'sha256:'+'1'*64}, False),
            ('untagged-native', {'source_backend':'native','source_scope':scope,'source_object_id':'1'*64}, False),
            ('wrong-namespace', {'source_backend':'native','source_scope':{**scope,'organisation_id':uid()},'source_object_id':'sha256:'+'1'*64}, False),
            ('missing-namespace', {'source_backend':'native','source_object_id':'sha256:'+'1'*64}, False),
        ]
        for name, fields, accepted in cases:
            config=fixture.path/(name+'-config.json');request=fixture.path/(name+'-request.json');journal=fixture.path/(name+'-journal')
            journal.mkdir(mode=0o700)
            config.write_text(json.dumps({**base,**fields}));config.chmod(0o600)
            request.write_text(json.dumps(fixture.operation('14.1','identity.describe',{})));request.chmod(0o600)
            before=fixture.sql('SELECT count(*)::int AS n FROM hyperfide.identity_request_nonces WHERE credential_id=$1',[fixture.ids['operator']])[0]['n']
            result=subprocess.run(['node',str(module),str(config),str(request),str(journal)],cwd=ROOT,env=fixture.env,text=True,capture_output=True,timeout=30)
            after=fixture.sql('SELECT count(*)::int AS n FROM hyperfide.identity_request_nonces WHERE credential_id=$1',[fixture.ids['operator']])[0]['n']
            if accepted:
                assert result.returncode==0,(name,result.stderr)
                output=json.loads(result.stdout);capture=json.loads(Path(output['receipt_path']).read_text())
                assert capture['response']['body']['ok'] is True
                assert capture['response']['body']['result']['principal']['credential_id']==fixture.ids['operator']
                assert after==before+1
                if name=='native':assert capture['source_scope']==scope and capture['source_backend']=='native'
                else:assert 'source_scope' not in capture and 'source_backend' not in capture
            else:
                assert result.returncode==1 and json.loads(result.stderr)['error']['code']=='CASE_SOURCE_BINDING_REQUIRED',(name,result.stdout,result.stderr)
                assert after==before and not list(journal.iterdir())
        print(json.dumps({'status':'PASS','cases':len(cases),'boundary':'actual signed identity HTTPS and retained fault capture'}))
        return 0
    finally:
        fixture.close()


if __name__=='__main__':
    raise SystemExit(main())
