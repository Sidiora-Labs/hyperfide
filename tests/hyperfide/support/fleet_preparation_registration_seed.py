"""Initial physical registration inputs; allocation, installation and recovery remain production effects."""
from __future__ import annotations
import hashlib,json,os,uuid
from pathlib import Path

def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':')).encode()
def digest(v):return 'sha256:'+hashlib.sha256(v if isinstance(v,bytes) else canonical(v)).hexdigest()
def seed(f,claimed,runtime,inputs,paths,manager_context):
 i=f.ids;token=claimed['token'];scope=[i['organisation'],i['run']]
 def one(sql,args):
  rows=f.sql(sql,args)
  if len(rows)!=1:raise ValueError('Exactly one accepted registration prerequisite required')
  return rows[0]
 def insert(table,v,json_columns=()):
  keys=list(v);args=[json.dumps(v[k]) if k in json_columns else v[k] for k in keys];places=[f'${n}'+('::jsonb' if k in json_columns else '') for n,k in enumerate(keys,1)]
  f.sql('INSERT INTO hyperfide.'+table+'('+','.join(keys)+') VALUES('+','.join(places)+')',args)
 for k in ['state_dir','workspace_path','home_path','tmp_path','worker_source','worker_home','worker_tmp','base_root']:
  if not isinstance(paths[k],str) or not Path(paths[k]).is_absolute() or str(Path(paths[k]).resolve())!=paths[k]:raise ValueError('Exact absolute fixture paths required: '+k)
 for k in ['uid','gid','worker_uid','worker_gid']:
  if not isinstance(paths[k],int) or paths[k]<=0:raise ValueError('Actual nonroot OS identities required')
 if paths['uid']==paths['worker_uid'] or paths['gid']==paths['worker_gid']:raise ValueError('Separate preparation and worker OS identities required')
 for k in ['state_dir','home_path','tmp_path']:
  st=Path(paths[k]).lstat()
  if not Path(paths[k]).is_dir() or Path(paths[k]).is_symlink() or st.st_uid not in [0,paths['uid']]:raise ValueError('Actual private preparation directories required')
 if Path(paths['workspace_path']).exists():raise ValueError('Initial installation target must be absent')
 for name,pin in [('native_path','native_digest'),('recipe_path','recipe_digest')]:
  if digest(Path(runtime[name]).read_bytes())!=runtime[pin]:raise ValueError('Actual runtime input changed')
 principal=one("SELECT actor_id,credential_id FROM hyperfide.identity_principals WHERE credential_id=$1 AND role='RUNNER' AND state='ACTIVE'",[i['runner']]);session=principal['actor_id'];slot=str(uuid.uuid4());worker_session=str(uuid.uuid4())
 physical=one('SELECT s.preparation_digest,p.profile_id FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools p ON p.organisation_id=s.organisation_id AND p.id=s.pool_id WHERE s.organisation_id=$1 AND s.id=$2',[i['organisation'],token['sandbox_id']])
 node_digest=digest(Path(runtime['node_path']).read_bytes());module=Path(runtime['recipe_path']).parent/'fleet_readiness_probe.js';pins=runtime['module_closure']
 if len(pins)!=9 or any(digest(Path(p['path']).read_bytes())!=p['digest'] for p in pins):raise ValueError('Actual fixed verifier closure changed')
 recipe={'node_path':runtime['node_path'],'node_digest':node_digest,'recipe_path':runtime['recipe_path'],'recipe_digest':runtime['recipe_digest'],'native_path':runtime['native_path'],'native_digest':runtime['native_digest'],'base_root':paths['base_root'],'max_stage_bytes':'67108864','readiness_context':paths['readiness_context'],'readiness_kind':'FLEET_MANIFEST_V1','readiness_verifier':{'node_path':runtime['node_path'],'node_digest':node_digest,'module_path':str(module),'module_digest':digest(module.read_bytes()),'module_closure':pins}}
 recipes={'environment.prepare.v1':recipe};policy={'schema_version':1,'policies':[{'organisation_id':i['organisation'],'run_id':i['run'],'authority_epoch':i['epoch'],'base_profiles':[{'profile_id':physical['profile_id'],'preparation_digest':physical['preparation_digest']}],'recipes':recipes}]}
 root=Path('/root/neron/build/fleet/integration/private');root.mkdir(parents=True,exist_ok=True);policy_path=root/('interrupted-install-policy-'+str(uuid.uuid4())+'.json');policy_bytes=canonical(policy);policy_path.write_bytes(policy_bytes);policy_path.chmod(0o600)
 f.env['HF_RUNNER_PREPARATION_RECIPES_FILE']=str(policy_path);f.env['HF_RUNNER_PREPARATION_RECIPES_DIGEST']=digest(policy_bytes)
 insert('worker_slots',dict(organisation_id=i['organisation'],id=slot,sandbox_id=token['sandbox_id'],slot_key='isolated-preparation-'+slot,boot_generation=token['sandbox_boot_generation'],capacity_kind='PREPARATION',state='READY'))
 worker_slot=str(uuid.uuid4())
 insert('worker_slots',dict(organisation_id=i['organisation'],id=worker_slot,sandbox_id=token['sandbox_id'],slot_key='isolated-uninstalled-worker-'+worker_slot,boot_generation=token['sandbox_boot_generation'],capacity_kind='AGENT',state='READY'))
 base=dict(organisation_id=i['organisation'],run_id=i['run'],credential_id=i['runner'],sandbox_id=token['sandbox_id'],boot_generation=token['sandbox_boot_generation'],boot_id=i['boot'],repository_id=i['repository'],runner_binary=runtime['native_path'],runner_binary_digest=runtime['native_digest'],boot_preparation_digest=physical['preparation_digest'],preparation_digest=physical['preparation_digest'],slot_generation=1,observation_digest=digest({'fixture':'initial-physical-metadata','paths':paths}),state='PREPARING')
 prep=dict(base,session_id=session,slot_id=slot,state_dir=paths['state_dir'],workspace_path=paths['workspace_path'],home_path=paths['home_path'],tmp_path=paths['tmp_path'],uid=paths['uid'],gid=paths['gid'],preparation_policy_digest=digest(policy_bytes),preparation_recipes=recipes)
 worker=dict(base,session_id=worker_session,slot_id=worker_slot,state_dir=str(Path(paths['state_dir'])/'worker'),workspace_path=paths['worker_source'],home_path=paths['worker_home'],tmp_path=paths['worker_tmp'],uid=paths['worker_uid'],gid=paths['worker_gid'])
 insert('runner_registry',prep,('preparation_recipes',));insert('runner_registry',worker)
 f.sql("UPDATE hyperfide.identity_runner_status SET preparation_digest=$2,heartbeat_at=clock_timestamp() WHERE credential_id=$1",[i['runner'],physical['preparation_digest']])
 request=dict(request_id=str(uuid.uuid4()),task_id=token['task_id'],package_id=manager_context['package_id'],manager_session_id=manager_context['manager_id'],manager_generation=manager_context['manager_generation'],leader_generation=manager_context['leader_generation'],authority_epoch=i['epoch'],session_id=session,slot_id=slot,slot_generation='1',sandbox_id=token['sandbox_id'],boot_id=i['boot'],boot_generation=str(token['sandbox_boot_generation']),deadline_ms=300000)
 return {'session_id':session,'slot_id':slot,'slot_generation':'1','preparation':prep,'worker':worker,'allocation_request':request,'recipe':recipe,'policy_path':str(policy_path),'policy_digest':digest(policy_bytes),'fixture_scope':'INITIAL_PHYSICAL_SLOT_METADATA_ONLY_NO_INSTALL_READINESS_JOB_OR_OUTCOME'}
