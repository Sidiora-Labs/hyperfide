#!/usr/bin/env python3
"""Actual PG epoch rows and signed historical inputs; no native or READY qualification."""
import copy,importlib.util,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4];SUPPORT=ROOT/'tests/hyperfide/support'
def load(name,p):
 s=importlib.util.spec_from_file_location(name,p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
fixture=load('allocation_epoch_metadata_fixture',ROOT/'tests/hyperfide/cases/source_control/fleet_install_expired_failed_epoch.py');q=load('allocation_epoch_actual_oracle',SUPPORT/'fleet_live_qualification.py');original=fixture.extension

def extension(f,decision,n):
 original(f,decision,n)
 database=f.sql('SELECT current_database() AS database_name,(pg_control_system()).system_identifier::text')[0];target={**database,'database_url_env':'HF_EPOCH_ORACLE_DATABASE_URL','organisation_id':f.ids['organisation'],'run_id':f.ids['run']}
 previous=os.environ.get('HF_EPOCH_ORACLE_DATABASE_URL');os.environ['HF_EPOCH_ORACLE_DATABASE_URL']=f.url
 try:snapshot=q.snapshot(target)
 finally:
  if previous is None:os.environ.pop('HF_EPOCH_ORACLE_DATABASE_URL',None)
  else:os.environ['HF_EPOCH_ORACLE_DATABASE_URL']=previous
 rows=snapshot['rows'];edges=[x for x in rows['fleet_install_recoveries'] if x.get('allocation_epoch_operation_id')]
 assert len(edges)==1,edges
 edge=edges[0];current=q.one(rows['fleet_environment_installs'],'operation_id',edge['operation_id']);old=q.one(rows['fleet_environment_installs'],'operation_id',edge['predecessor_install_operation_id']);failed=q.one(rows['runner_remote_jobs'],'operation_id',old['operation_id'])
 q.verified_failed_allocation_epoch(rows,current,old,edge,failed)
 def changed_old_boot(r,e):
  job=q.one(r['runner_remote_jobs'],'operation_id',old['operation_id']);job['plan']['binding']['boot_id']=fixture.uid();job['plan_digest']=q.digest(job['plan']);e['runner_plan_digest']=job['plan_digest']
 mutations={
 'wrong-old-boot':changed_old_boot,
 'wrong-epoch':lambda r,e:e.update(allocation_epoch_operation_id=old['operation_id']),
 'unreleased-allocation':lambda r,e:q.one(r['resource_job_allocations'],'id',failed['plan']['allocation']['allocation_id']).update(state='ACTIVE'),
 'unreleased-vector':lambda r,e:q.one(r['reservations'],'id',failed['reservation_id']).update(state='ALLOCATED'),
 'unexpired-vector':lambda r,e:q.one(r['reservations'],'id',failed['reservation_id']).update(expires_at='2099-01-01T00:00:00Z'),
 'physical-vector':lambda r,e:q.one(r['capacity_accounts'],'id',q.one(r['reservations'],'id',failed['reservation_id'])['capacity_account_id']).update(capacity_class='PHYSICAL'),
 'wrong-artifact':lambda r,e:q.one([a for a in r['runner_result_artifacts'] if a['role']=='native_receipt'],'operation_id',failed['operation_id']).update(content_digest=q.digest(b'changed capture')),
 'reused-target':lambda r,e:q.one(r['fleet_install_delivery_executions'],'operation_id',current['operation_id'])['target_binding'].update(allocation_id=failed['plan']['allocation']['allocation_id']),
 'wrong-boot':lambda r,e:q.one(r['fleet_install_delivery_executions'],'operation_id',current['operation_id'])['target_binding'].update(boot_id=fixture.uid()),
 }
 for label,mutate in mutations.items():
  altered=copy.deepcopy(rows);changed=q.one(altered['fleet_install_recoveries'],'operation_id',edge['operation_id']);mutate(altered,changed)
  try:q.verified_failed_allocation_epoch(altered,q.one(altered['fleet_environment_installs'],'operation_id',current['operation_id']),q.one(altered['fleet_environment_installs'],'operation_id',old['operation_id']),changed,q.one(altered['runner_remote_jobs'],'operation_id',old['operation_id']))
  except q.Refused:pass
  else:raise AssertionError('Accepted changed '+label)
 out=ROOT/'build/fleet/integration/private/allocation-epoch-oracle-actual-snapshot.json';out.parent.mkdir(parents=True,exist_ok=True);out.write_bytes(q.canonical(snapshot));out.chmod(0o600)
 print(json.dumps({'status':'PASS','scope':'actual PG allocation epoch rows with explicit signed historical FAILED input; native execution and READY not claimed','snapshot':str(out.relative_to(ROOT)),'snapshot_digest':q.digest(out.read_bytes()),'checks':['actual snapshot retains 0735 epoch and fresh target','closed exact four-dimensional logical vector','actual signed historical FAILED artifact binding',*mutations.keys()]}),flush=True)

def main():
 if not os.environ.get('DATABASE_URL'):return subprocess.run([sys.executable,str(SUPPORT/'withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 fixture.extension=extension
 return fixture.main()
if __name__=='__main__':raise SystemExit(main())
