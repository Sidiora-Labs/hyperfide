#!/usr/bin/env python3
"""Apply the actual migration to retained legacy rows in a separate owned PostgreSQL fixture."""
import argparse,importlib.util,json,os,socket,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--baseline-root',required=True);args=parser.parse_args()
 baseline=Path(args.baseline_root).resolve()
 if baseline.parent!=Path('/root/neron/build/fleet') or not baseline.name.startswith('local-runtime-') or not (baseline/'core/control-plane/dist/storage/durability.js').is_file():raise RuntimeError('Explicit immutable local runtime baseline required')
 if (baseline/'core/control-plane/migrations/0733-fleet-install-boot-heads.sql').exists():raise RuntimeError('Baseline must precede0733')
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve()),*sys.argv[1:]],cwd=ROOT).returncode
 sys.path.insert(0,str(baseline/'tests/hyperfide/support'))
 spec=importlib.util.spec_from_file_location('backfill_assignment',baseline/'tests/hyperfide/cases/source_control/fleet_selected_assignment.py');a=importlib.util.module_from_spec(spec);spec.loader.exec_module(a)
 from identity_fixture import uid,sha
 from fleet_prerequisite_fixture import component_closure
 f=a.AssignmentFixture(extra_components=component_closure(['fleet-orchestration','fleet-manager-effects']),extra_setup=a.adoption.native_profiles)
 try:
  i=f.ids;scope={'organisation_id':i['organisation'],'run_id':i['run']};common=[i['organisation'],i['run']]
  cohort=f.ok('fleet.cohort.bind',{'cohort_id':uid(),'host_id':socket.gethostname(),'leader_generation':'1','expected_generation':'0'},component='fleet-orchestration')
  environment='backfill-'+uid();pin=sha(b'CONTROLLED_LEGACY_BACKFILL_INPUT')
  a.insert(f,'fleet_environment_specs',{**scope,'input_digest':pin,'package_digest':pin,'source_config_digest':pin,'source_manifest_digest':pin,'plan_digest':pin,'package_spec':{'controlled_legacy_row':True},'source_config':{'controlled_legacy_row':True},'install_plan':{'controlled_legacy_row':True},'registered_by':i['manager']})
  operations=[uid(),uid()]
  for operation in operations:
   admission={**scope,'operation_id':operation,'environment_id':environment,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1','controlled_legacy_row':True}
   a.insert(f,'fleet_environment_installs',{**scope,'operation_id':operation,'input_digest':pin,'environment_id':environment,'environment_generation':1,'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':1,'authority_epoch':i['epoch'],'package_id':i['package'],'manager_session_id':i['manager'],'manager_generation':2,'leader_generation':1,'cohort_id':cohort['cohort_id'],'cohort_generation':int(cohort['cohort_generation']),'admission':admission,'admission_digest':a.digest(admission),'expires_at':'2000-01-01T00:00:00Z'})
  a.insert(f,'fleet_install_heads',{**scope,'environment_id':environment,'environment_generation':1,'logical_operation_id':operations[0],'current_operation_id':operations[1]})
  originals=f.sql('SELECT to_jsonb(e) AS row FROM hyperfide.fleet_environment_installs e WHERE operation_id=ANY($1::uuid[]) ORDER BY operation_id',[operations])
  legacy=f.sql('SELECT environment_id,environment_generation::text,logical_operation_id::text,current_operation_id::text FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2',common)
  script="""
import{pathToFileURL}from'node:url';const root=process.argv[1],{createResourceContainer}=await import(pathToFileURL(root+'/core/control-plane/dist/storage/runtime.js')),{MigrationCoordinator}=await import(pathToFileURL(root+'/core/control-plane/dist/storage/durability.js'));const signal=new AbortController().signal,env={...process.env,DATABASE_URL:process.argv[2],HYPERFIDE_MIGRATION_DATABASE_URL:process.argv[2]},r=createResourceContainer({role:'control',env,signal});try{console.log(JSON.stringify(await new MigrationCoordinator(r,root+'/core/control-plane/migrations').apply({timeoutMs:30000,signal})))}finally{await r.close()}
"""
  migrated=subprocess.run(['node','--input-type=module','-e',script,str(ROOT),f.url],cwd=ROOT,env=f.env,text=True,capture_output=True,timeout=40);assert migrated.returncode==0,migrated.stderr
  applied=json.loads(migrated.stdout);assert applied['applied']==[733],applied
  actual=f.sql('SELECT environment_id,environment_generation::text,logical_operation_id::text,current_operation_id::text,sandbox_id::text,boot_id::text,boot_generation::text FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2',common)
  assert actual==[{**legacy[0],'sandbox_id':i['sandbox'],'boot_id':i['boot'],'boot_generation':'1'}],actual
  assert f.sql('SELECT to_jsonb(e) AS row FROM hyperfide.fleet_environment_installs e WHERE operation_id=ANY($1::uuid[]) ORDER BY operation_id',[operations])==originals
  replay=subprocess.run(['node','--input-type=module','-e',script,str(ROOT),f.url],cwd=ROOT,env=f.env,text=True,capture_output=True,timeout=40);assert replay.returncode==0 and json.loads(replay.stdout)['applied']==[],replay.stderr
  print(json.dumps({'status':'PASS','scope':'actual MigrationCoordinator backfill/replay on controlled retained legacy rows; no admission/native/provider qualification','baseline':str(baseline),'applied':applied,'head':actual,'original_installs_unchanged':True}));return 0
 finally:f.close()
if __name__=='__main__':raise SystemExit(main())
