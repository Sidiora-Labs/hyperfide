"""Typed provider termination evidence checks; these fixtures do not claim a live cloud fault."""
import base64,copy,json,sys,tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'support'))
import fleet_live_qualification as q
class Evidence:
 def __init__(self,root):self.root=Path(root)
 def put(self,name,value):
  raw=q.canonical(value);p=self.root/name;p.write_bytes(raw);p.chmod(0o600);return {'path':name,'digest':q.digest(raw)}
 def provider(self,name,status,scope,observed,replica):
  deployment={'id':'deployment','projectId':scope['project_id'],'serviceId':scope['service_id'],'environmentId':scope['environment_id'],'instances':[{'id':replica,'status':status}]}
  body={'data':{'deployment':deployment}};raw=q.canonical(body)
  value={'schema_version':1,'kind':'RAILWAY_DEPLOYMENT_INSTANCE_OBSERVATION_V1','driver_digest':'sha256:'+'a'*64,'origin':scope['api_origin'],'observed_at':observed,'request':{'query':'query($id:String!){deployment(id:$id){id projectId serviceId environmentId instances{id status}}}','variables':{'id':'deployment'}},'response':{'http_status':200,'body':body,'body_base64':base64.b64encode(raw).decode(),'body_digest':q.digest(raw)}}
  return self.put(name,value)
 def fixture(self):
  scope={'provider':'railway','api_origin':'https://backboard.railway.app','project_id':'project','environment_id':'environment','service_id':'service','main_uid':22001}
  target={'fault_drivers':{'supervisor_box_loss':{'provider_scope':scope,'provider_collector_digest':'sha256:'+'a'*64}}}
  old={'pid':24,'start_time_ticks':'100','uid':22001,'gid':22001,'kernel_boot_id':'kernel','railway_replica_id':'old','railway_deployment_id':'deployment','observed_at':'2026-11-01T03:00:00.000Z'}
  new={**old,'start_time_ticks':'200','railway_replica_id':'new','observed_at':'2026-11-01T03:00:02.000Z'}
  def measure(identity):return {'exit_code':0,'body':{k:v for k,v in identity.items() if k not in ('pid','start_time_ticks','uid','gid')}|{'process':{k:identity[k] for k in ('pid','start_time_ticks','uid','gid')}}}
  proof={'kind':'RAILWAY_INSTANCE_TERMINATION_V1','identity':old,'old_measurement':self.put('old.json',measure(old)),'new_measurement':self.put('new.json',measure(new)),'before_provider':self.provider('before.json','RUNNING',scope,'2026-11-01T03:00:00.500Z','old'),'after_old_provider':self.provider('removed.json','REMOVED',scope,'2026-11-01T03:00:03.000Z','old'),'after_new_provider':self.provider('replacement.json','RUNNING',scope,'2026-11-01T03:00:03.500Z','new'),'restart_receipt':self.put('restart.json',{'schema_version':1,'action':'railway.deployment.restart','state':'ACKNOWLEDGED','exit_code':0,'launch_id':'launch','local_operation_id':'00000000-0000-4000-8000-000000000001','scope':{k:scope[k] for k in ('project_id','environment_id','service_id')},'requested_at':'2026-11-01T03:00:01.000Z'})}
  return {'old_identity':old,'new_identity':new,'old_process_absence':proof},{'launch_id':'launch','fault_event_id':'00000000-0000-4000-8000-000000000001','fault_observed_at':'2026-11-01T03:00:03.000Z'},target
 def change_provider(self,proof,key,change):
  ref=proof[key];value=json.loads((self.root/ref['path']).read_bytes());change(value)
  body=value['response']['body'];raw=q.canonical(body);value['response']['body_base64']=base64.b64encode(raw).decode();value['response']['body_digest']=q.digest(raw);proof[key]=self.put(ref['path'],value)
def main():
 cases=[('changed_pid_only',lambda e,p,c,t:p.__setitem__('old_process_absence',{}),'PROVIDER_TERMINATION_SCOPE_REQUIRED'),('ack_only',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r['response']['body']['data']['deployment']['instances'][0].__setitem__('status','RUNNING')),'EXACT_PROVIDER_INSTANCE_STATE_REQUIRED'),('wrong_instance',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r['response']['body']['data']['deployment']['instances'][0].__setitem__('id','other')),'EXACT_PROVIDER_INSTANCE_STATE_REQUIRED'),('wrong_scope',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r['response']['body']['data']['deployment'].__setitem__('serviceId','other')),'PROVIDER_INSTANCE_SCOPE_MISMATCH'),('stale_removal',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r.__setitem__('observed_at','2026-11-01T02:59:59.000Z')),'PROVIDER_TERMINATION_ORDER_REQUIRED'),('unterminated',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r['response']['body']['data']['deployment']['instances'][0].__setitem__('status','REMOVING')),'EXACT_PROVIDER_INSTANCE_STATE_REQUIRED'),('wrong_query_binding',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r['request']['variables'].__setitem__('id','other')),'AUTHENTICATED_PROVIDER_INSTANCE_READ_REQUIRED'),('wrong_collector',lambda e,p,c,t:e.change_provider(p['old_process_absence'],'after_old_provider',lambda r:r.__setitem__('driver_digest','sha256:'+'b'*64)),'AUTHENTICATED_PROVIDER_INSTANCE_READ_REQUIRED')]
 with tempfile.TemporaryDirectory(prefix='hf-provider-absence-') as root:
  e=Evidence(root);p,c,t=e.fixture();bounds=q.railway_instance_absence(p,c,t,root);assert bounds
  q.provider_recovery_timeline({'created_at':'2026-11-01T02:59:58Z'},{'created_at':'2026-11-01T03:00:04Z'},bounds)
  manager_target=copy.deepcopy(t);manager_target['fault_drivers']['manager_replacement']=copy.deepcopy(t['fault_drivers']['supervisor_box_loss']);assert q.railway_instance_absence(p,c,manager_target,root,'manager_replacement')
  try:q.provider_recovery_timeline({'created_at':'2026-11-01T02:59:58Z'},{'created_at':'2026-11-01T03:00:00.800Z'},bounds)
  except q.Refused as error:assert str(error)=='PROVIDER_RECOVERY_OBSERVATION_ORDER_REQUIRED'
  else:raise AssertionError('pre-fault recovery observation accepted')
  for name,change,code in cases:
   p,c,t=e.fixture();change(e,p,c,t)
   try:q.railway_instance_absence(p,c,t,root)
   except q.Refused as error:assert str(error)==code,(name,str(error),code)
   else:raise AssertionError(name+' unexpectedly accepted')
  # Request/row binding is tested with declared artifact metadata; signature and S3 execution are not claimed here.
  p,c,t=e.fixture();t.update(organisation_id='org',run_id='run');c.update(case='supervisor_box_loss',organisation_id='org',run_id='run',authority_epoch='epoch',source_object_id='a'*40,before_observation_id='before',after_observation_id='after',coding_command_id='command',process_observations=p)
  core={'schema_version':1,'kind':'FLEET_PROVIDER_FAULT_PROOF_V1',**c,'evidence_blobs':{}}
  for ref in p['old_process_absence'].values():
   if isinstance(ref,dict) and 'path' in ref:core['evidence_blobs'][ref['path']]=base64.b64encode((Path(root)/ref['path']).read_bytes()).decode()
  raw=q.canonical(core);payload={'component':'15.2','action':'artifact.object.put','input':{'organisation_id':'org','run_id':'run','digest':q.digest(raw),'size_bytes':str(len(raw)),'data_base64':base64.b64encode(raw).decode()}};envelope={'payload_b64':base64.urlsafe_b64encode(q.canonical(payload)).decode().rstrip('=')}
  capture={**c,'physical_proof':core,'body_base64':base64.b64encode(q.canonical(envelope)).decode(),'response':{'body':{'result':{'outcome':'SUCCEEDED','availability':'VERIFIED','artifact':{'artifact_id':'object'}}}}}
  rows={'artifacts':[{'id':'object','organisation_id':'org','run_id':'run','status':'COMPLETE','completed_at':'2026-11-01T03:00:04Z','storage_backend':'s3-v1','digest':q.digest(raw),'size_bytes':str(len(raw))}]}
  assert q.provider_fault_custody(capture,rows,t,root)
  for name,change in [('missing_artifact',lambda cap,data:data.__setitem__('artifacts',[])),('pending_artifact',lambda cap,data:data['artifacts'][0].__setitem__('status','PENDING')),('changed_core',lambda cap,data:cap['physical_proof'].__setitem__('launch_id','different')),('wrong_backend',lambda cap,data:data['artifacts'][0].__setitem__('storage_backend','memory'))]:
   cap,data=copy.deepcopy(capture),copy.deepcopy(rows);change(cap,data)
   try:q.provider_fault_custody(cap,data,t,root)
   except q.Refused:pass
   else:raise AssertionError(name+' unexpectedly accepted')
 print(json.dumps({'passed':len(cases)+9,'scope':'typed-evidence-and-request-binding-only','live_cloud_fault':False,'live_s3_execution':False}))
if __name__=='__main__':main()
