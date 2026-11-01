"""Bind an actual pidfd observation to declared component metadata; no signed-native claim."""
import argparse,copy,json,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
import fleet_live_qualification as oracle

def main():
 p=argparse.ArgumentParser();p.add_argument('--actual-observation',required=True);p.add_argument('--digest',required=True);args=p.parse_args();filename=Path(args.actual_observation)
 assert oracle.digest(filename.read_bytes())==args.digest
 receipt=oracle.private_json(filename);assert receipt['status']=='PASS' and receipt['scope'].startswith('Local real process-signal safety')
 observations=[v for v in receipt['observations'] if v.get('signal')=='SIGKILL'];assert len(observations)==1;observed=observations[0]
 operation=observed['operation_id'];scope={k:observed[k] for k in ['sandbox_id','boot_id','boot_generation']};scope.update(environment_id='DECLARED_COMPONENT_ENVIRONMENT',environment_generation=1,environment_root='/declared/component/environment')
 admission={**scope,'plan_digest':observed['install_plan_digest']};previous={'operation_id':operation,'admission':admission};job={'plan_digest':observed['runner_plan_digest'],'plan':{'binding':{'state_dir':'/declared/component/native-state','uid':observed['process']['uid']}}}
 request={'schema_version':1,'request_id':observed['request_id'],'mode':'interrupt',**scope,'os_boot_id':observed['process']['os_boot_id'],'state_dir':job['plan']['binding']['state_dir'],'uid':observed['process']['uid'],'install_plan_digest':observed['install_plan_digest'],'deadline_seconds':60,'target':{'operation_id':operation,'runner_plan_digest':observed['runner_plan_digest'],'pid':observed['process']['pid'],'process_start':observed['process']['process_start'],'os_boot_id':observed['process']['os_boot_id']}}
 core={'retained_stage_digests':observed['retained_stage_digests']};install={'receipt':{'stages':[{'name':k,'status':'PASS','evidence_digest':v} for k,v in observed['retained_stage_digests'].items()]}}
 oracle.verified_install_interruption_observation(previous,job,request,observed,core,install)
 cases=['target-pid','runner-plan','uid','kernel','signal','completed-dependencies','retained-stage','invented-completion']
 for name in cases:
  req=copy.deepcopy(request);actual=copy.deepcopy(observed);final=copy.deepcopy(install)
  if name=='target-pid':req['target']['pid']+=1
  elif name=='runner-plan':actual['runner_plan_digest']=oracle.digest(b'wrong plan')
  elif name=='uid':actual['process']['uid']+=1
  elif name=='kernel':actual['process']['os_boot_id']='00000000-0000-4000-8000-000000000000'
  elif name=='signal':actual['signal']='SIGTERM'
  elif name=='completed-dependencies':actual['retained_stage_digests']['dependency-preparation']=oracle.digest(b'dependency');actual['stages']=sorted(actual['retained_stage_digests'])
  elif name=='retained-stage':final['receipt']['stages'][0]['evidence_digest']=oracle.digest(b'changed')
  else:actual['outcome']='SUCCEEDED'
  try:oracle.verified_install_interruption_observation(previous,job,req,actual,core,final)
  except oracle.Refused:pass
  else:raise AssertionError('Interruption oracle admitted '+name)
 print(json.dumps({'status':'PASS','scope':'actual retained pidfd SIGKILL observation plus explicitly controlled component admission/stage bindings; no native/provider/SDK-custody qualification','actual_observation_digest':args.digest,'negative_cases':cases}));return 0
if __name__=='__main__':raise SystemExit(main())
