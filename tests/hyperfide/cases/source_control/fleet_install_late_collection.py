#!/usr/bin/env python3
"""Actual native terminal custody across expired lease and explicit cohort adoption."""
import datetime,importlib.util,json,os,socket,subprocess,sys,time,types
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
spec=importlib.util.spec_from_file_location('late_native_install',ROOT/'tests/hyperfide/cases/source_control/fleet_install_interrupted.py');fixture=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixture)

def scenario(c):
 f,i,a,manager=[c[k] for k in ['f','i','a','manager']];op=a['operation_id'];scope=[i['organisation'],i['run']];checks=[]
 def refusal(action,value,expected,component='fleet-install-delivery',key='operator'):
  status,response=f.invoke(action,value,component=component,key=key)
  code=response.get('error',{}).get('code')
  if status==200 or code!=expected:raise AssertionError((action,expected,status,response))
  checks.append(expected)
 def job():return f.sql('SELECT * FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',scope+[op])[0]
 deadline=time.monotonic()+60
 while time.monotonic()<deadline:
  c['heartbeat']();terminal=job()
  if terminal['state'] in ['COMPLETED','UNKNOWN']:break
  time.sleep(.2)
 else:raise AssertionError('Actual native terminal result unavailable')
 if terminal['state']!='COMPLETED' or terminal['result']['outcome']!='SUCCEEDED':raise AssertionError(terminal)
 if datetime.datetime.fromisoformat(terminal['result']['ended_at'].replace('Z','+00:00'))>datetime.datetime.fromisoformat(a['expires_at'].replace('Z','+00:00')):raise AssertionError('Fixture native execution missed original lease')
 value={'install_operation_id':op,'previous_adoption_id':None,'admission_digest':a['admission_digest'],'receipt_digest':None,'input_digest':a['input_digest'],'handoff_id':None,'runner_operation_id':op,'runner_result_digest':terminal['result_digest']}
 def adoption(v=value):
  decision=fixture.authority._accepted_decision_input(f,manager,'fleet.install.adopt',v)
  return {'decision':decision}
 refusal('fleet.install.adopt',adoption(),'FLEET_INSTALL_ADOPTION_UNNECESSARY','fleet-install','manager')
 while datetime.datetime.now(datetime.timezone.utc)<=datetime.datetime.fromisoformat(a['expires_at'].replace('Z','+00:00')):
  c['heartbeat']();time.sleep(.2)
 refusal('fleet.install.delivery.schedule',{'operation_id':op},'FLEET_INSTALL_EXPIRED')
 cohort=c['ok']('fleet.cohort.bind',{'cohort_id':manager['cohort_id'],'host_id':socket.gethostname(),'leader_generation':manager['leader_generation'],'expected_generation':manager['cohort_generation']},component='fleet-orchestration',key='leader')
 binding={'actor_id':manager['manager_id'],'actor_role':'WAVE_MANAGER','authority_epoch':i['epoch'],'leader_generation':manager['leader_generation'],'delegation_id':manager['package_id'],'manager_generation':manager['manager_generation']}
 c['ok']('fleet.session.bind',{'binding':binding},component='fleet-orchestration',key='manager');manager['cohort_generation']=cohort['cohort_generation']
 refusal('fleet.install.delivery.collect',{'operation_id':op},'FLEET_INSTALL_STALE_OWNER')
 changed=dict(value,runner_result_digest=fixture.sha(b'unrelated terminal'))
 refusal('fleet.install.adopt',adoption(changed),'FLEET_INSTALL_RECONCILIATION_REQUIRED','fleet-install','manager')
 adopted=c['ok']('fleet.install.adopt',adoption(),component='fleet-install',key='manager')
 if adopted['state']!='ADMITTED':raise AssertionError(adopted)
 ready=c['ok']('fleet.install.delivery.collect',{'operation_id':op})
 if ready['state']!='READY':raise AssertionError(ready)
 retained=f.sql('SELECT admission,admission_digest,expires_at::text,state,receipt_digest FROM hyperfide.fleet_environment_installs WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3',scope+[op])[0]
 if retained['admission']!=a or retained['admission_digest']!=a['admission_digest']:raise AssertionError('Immutable admission changed')
 evidence=ROOT/'build/fleet/integration/private'/('late-collection-'+op+'.json');evidence.parent.mkdir(parents=True,exist_ok=True)
 fixture.write(evidence,{'scope':'isolated component actual native, not live provider','original_admission':a,'terminal_job':terminal,'adoption':adopted,'install':retained,'ready':ready})
 c['checks'].extend(checks+['actual native terminal','late authenticated collection'])
 print(json.dumps({'status':'PASS','scope':'isolated PG/TLS controlled-SDK actual native terminal adoption and late collection; not live provider qualification','checks':checks+['actual native SUCCEEDED within original lease','explicit current-cohort adoption','late READY collector preserves original admission'],'evidence_path':str(evidence.relative_to(ROOT)),'evidence_digest':fixture.sha(evidence.read_bytes()),'operation_id':op,'native_result_digest':terminal['result_digest'],'receipt_digest':retained['receipt_digest']}),flush=True)
 return 0

def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
 components=fixture.archive.components
 fixture.archive.components=lambda ids:components([*ids,'fleet-orchestration'])
 profiles=fixture.load('late_collection_profile_input',ROOT/'tests/hyperfide/cases/tasks/3_4.py')
 stack=fixture.stackmod.SubmissionStack
 class ComposedStack(stack):
  def __init__(self,*args,**kwargs):
   setup=kwargs['before_start']
   def composed(f):
    setup(f);original_credentials=f.env.get('HF_CREDENTIAL_CONFIG_FILE');directory=f.path/'unused-native-profile-input';directory.mkdir(mode=0o700)
    profiles.native_profiles(types.SimpleNamespace(path=directory,ids=f.ids,env=f.env,sql=f.sql))
    f.env['HF_CREDENTIAL_CONFIG_FILE']=original_credentials
   kwargs['before_start']=composed;super().__init__(*args,**kwargs)
 fixture.stackmod.SubmissionStack=ComposedStack
 fixture.runtime_module.BASELINE_FILES['postinstall.mjs']=b'console.log("actual late-collection dependency lifecycle complete");\n'
 original=fixture.authority.seed_initial_admission;insert=fixture.authority.insert
 def declared_insert(f,table,value,json_columns=()):
  if table=='fleet_delegations':value={**value,'budget':{**value['budget'],'allowed_actions':['fleet.install.admit','fleet.install.adopt']}}
  return insert(f,table,value,json_columns)
 def declared_lease(f,manager,a):
  a['expires_at']=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=35)).isoformat(timespec='milliseconds').replace('+00:00','Z');a.pop('admission_digest');a['admission_digest']=fixture.sha(a)
  return original(f,manager,a)
 fixture.authority.insert=declared_insert;fixture.authority.seed_initial_admission=declared_lease
 return fixture.main(scenario=scenario)
if __name__=='__main__':raise SystemExit(main())
