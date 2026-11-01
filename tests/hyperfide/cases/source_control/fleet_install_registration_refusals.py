#!/usr/bin/env python3
"""Signed registration refusals over owned PostgreSQL/TLS; invalid environment manifests only."""
import argparse,base64,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import identity_fixture

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--runtime-root',type=Path,required=True);parser.add_argument('--cases',type=Path,required=True);args=parser.parse_args()
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
 identity_fixture.ROOT=args.runtime_root.resolve()
 cases=json.loads(args.cases.read_text())['cases'];assert len(cases)==6
 f=identity_fixture.IdentityFixture(extra_components=['fleet-install'])
 try:
  def counts():return f.sql('SELECT (SELECT count(*) FROM hyperfide.fleet_environment_specs)::int AS specs,(SELECT count(*) FROM hyperfide.fleet_effect_receipts)::int AS effects,(SELECT count(*) FROM hyperfide.runner_remote_jobs)::int AS jobs')[0]
  before=counts();observed=[]
  for case in cases:
   request=json.loads(Path(case['request']).read_text());input=json.loads(base64.urlsafe_b64decode(request['payload_b64']+'='*(-len(request['payload_b64'])%4)))['input']
   envelope=f.operation('fleet-install','fleet.install.register',input);status,body=f.request(envelope)
   observed.append({'case':case['case'],'http_status':status,'operation_id':body.get('operation_id'),'expected_operation_id':envelope['operation_id'],'expected_code':case['expected_code'],'error_code':body.get('error',{}).get('code'),'message':body.get('error',{}).get('message'),'ok':body.get('ok')})
  after=counts();nonces=f.sql('SELECT count(*)::int AS n FROM hyperfide.identity_request_nonces WHERE credential_id=$1',[f.ids['operator']])[0]['n'];assert before==after and nonces>=6,(before,after,nonces)
  paths={'missing_dependencies':'dependency.node','stale_install':'environment','path_escape':'mount.code.paths[0]','constraint_refusal':'workers.slots'}
  passed=all(v['ok']is False and v['operation_id']==v['expected_operation_id'] and v['error_code']==v['expected_code'] and (v['case']not in paths or v['message'].startswith(paths[v['case']]+':')) for v in observed)
  print(json.dumps({'status':'PASS'if passed else'FAIL','scope':'actual signed owned PostgreSQL/TLS registration boundary; no successful registration or live provider mutation','cases':observed,'authority_counts_before':before,'authority_counts_after':after,'authenticated_nonces':nonces},indent=2),flush=True)
  return 0 if passed else 1
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
