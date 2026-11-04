#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('live_fleet_contract',ROOT/'tests/hyperfide/support/fleet_live_qualification.py')
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)
IDS=['complete-live-authority-chain','native-run-source-binding','replacement-preserves-task-lineage','managed-workspaces-bind-real-workers','native-custody-qualified-independently','submitted-custody-owned-after-worker','checkpoint-survives-replaced-compute','qualified-native-candidate-accepted','dependent-assignment-uses-accepted-native-source','taskless-client-has-independent-authority','taskless-sparse-client-materializes-native-bytes','taskless-client-commits-durable-native-checkpoint']
def main():
    output=Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR',ROOT/'build/source-control/full-case/SCM-014'))
    output.mkdir(parents=True,exist_ok=True)
    try:
        target=live.private_json(os.environ['HF_FLEET_QUALIFICATION_TARGET'])
        evidence_path=Path(os.environ['HF_FLEET_QUALIFICATION_EVIDENCE'])
        evidence=live.private_json(evidence_path)
        config=live.private_json(os.environ['HF_SOURCE_LIVE_FLEET_CONFIG'])
        report=live.verify('0.14',evidence,target,evidence_path.parent)
        if report.get('status')!='PASS' or report.get('qualified') is not True or report.get('source_backend')!='native':raise live.Refused('COMPLETE_NATIVE_LIVE_FLEET_REQUIRED')
        process=subprocess.run(['node',str(ROOT/'tests/hyperfide/support/native_source_live_fleet_verify.mjs')],input=json.dumps({'target':target,'config':config}),cwd=ROOT,text=True,capture_output=True,timeout=600)
        (output/'native-client.stderr.log').write_text(process.stderr)
        if process.returncode:raise live.Refused('NATIVE_LIVE_CLIENT_VERIFICATION_FAILED')
        native=json.loads(process.stdout)
        if native.get('status')!='PASS' or native.get('checks')!=IDS[1:]:raise live.Refused('NATIVE_LIVE_ASSERTION_INVENTORY_MISMATCH')
        result={'schema_version':1,'case':'SCM-014','status':'PASS','execution_profile':'actual-provider-native-fleet-and-signed-taskless-client','assertions':IDS,'fleet':report,'native':native}
        (output/'live-fleet-conformance.json').write_text(json.dumps(result,indent=2)+'\n')
        for name in IDS:print(json.dumps({'type':'assertion','id':'SCM-014.'+name,'expected':True,'actual':True}),flush=True)
        print(json.dumps({'type':'cleanup','complete':True,'resources':[]}),flush=True)
        return 0
    except (KeyError,OSError,ValueError,live.Refused,subprocess.SubprocessError) as error:
        print(json.dumps({'status':'BLOCKED','case':'SCM-014','diagnostic':str(error)}))
        return 77
if __name__=='__main__':raise SystemExit(main())
