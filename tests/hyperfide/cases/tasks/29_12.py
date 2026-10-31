#!/usr/bin/env python3
"""V-069 greenfield first epoch through the shipped release fence driver, a proven-empty deployment and an off-box signed permit.
The Railway admin API is a recorded read-only test transport; this is component evidence, not live provider qualification."""
import datetime,hashlib,importlib.util,json,os,shutil,subprocess,sys,tempfile,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
# The migration job's authority grants come from the shipped control policy, never from the test; a policy that
# drops them must make the activation and adoption probes fail.
SHIPPED_AUTHORITY=[a for a in json.loads((ROOT/'deploy/hyperfide/policies/control.example.json').read_text())['allowed_actions'] if a.startswith('storage.authority.')]
spec=importlib.util.spec_from_file_location('bootstrap_29_12',ROOT/'tests/hyperfide/cases/tasks/29_11.py')
legacy=importlib.util.module_from_spec(spec);spec.loader.exec_module(legacy)
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture
canonical,private,outcome,sign,signing_input,envelope=legacy.canonical,legacy.private,legacy.outcome,legacy.sign,legacy.signing_input,legacy.envelope
IDS=['greenfield.topology-consistent','greenfield.payload-scoped','greenfield.seal-verified','greenfield.legacy-writer-refused','greenfield.resources-refused','greenfield.legacy-permit-refused','greenfield.history-refused','greenfield.run-present-refused','greenfield.database-sandbox-present-refused','greenfield.provider-sandbox-present-refused','greenfield.no-epoch-before-activation','greenfield.control-refused-before-activation','greenfield.activated','greenfield.single-bootstrap-epoch','greenfield.rows-minted-in-epoch','greenfield.evidence-retained','greenfield.inventory-read-only','greenfield.control-adopts','greenfield.provisioner-adopts','greenfield.dispatch-adopts','greenfield.followers-no-mint','greenfield.control-starts','greenfield.first-operator-issued','greenfield.no-signing-key-read','greenfield.legacy-unchanged']
ACTIONS=['identity.describe']
RECORDER=r"""
import fs from 'node:fs';
// Test-only recorded Railway admin transport: answers only the read-only inventory
// query from a local record and refuses every other request.
const record=process.env.HF29_12_RECORD,occupied=process.env.HF29_12_OCCUPIED;
globalThis.fetch=async(input,init={})=>{
 const url=String(input instanceof Request?input.url:input);
 if(url!=='https://backboard.railway.com/graphql/v2'||init.method!=='POST')throw new TypeError('recorded transport refuses '+url);
 const body=JSON.parse(String(init.body)),operation=/^(?:mutation|query)\s+([A-Za-z0-9_]+)/.exec(body.query)?.[1]??'anonymous';
 fs.appendFileSync(record,JSON.stringify({operation,mutation:/^\s*mutation/.test(body.query),variables:body.variables,authorization:init.headers?.Authorization??null})+'\n',{mode:0o600});
 if(operation!=='RailwayInventory')return new Response('{}',{status:403});
 const edges=fs.existsSync(occupied)?[{node:{id:'greenfield-stray-sandbox',status:'RUNNING',networkIsolation:null,environmentId:'fixture-env',region:'fixture-region',idleTimeoutMinutes:null,createdAt:new Date().toISOString(),domains:[]}}]:[];
 return Response.json({data:{sandboxes:{edges,pageInfo:{hasNextPage:false,endCursor:null}}}});
};
"""

def main():
 if sys.argv[1:]:raise SystemExit('unsupported argument')
 base=Path(os.environ.get('HYPERFIDE_CAMPAIGN_DIR','/tmp/hyperfide/task29.12'));base.mkdir(parents=True,exist_ok=True)
 f=None;o={};log=[];complete=False;folder=Path(tempfile.mkdtemp(prefix='hf-greenfield-'))
 def run(argv,env,cwd=None,timeout=120,**kw):
  p=subprocess.run([str(a) for a in argv],cwd=cwd,env=env,text=True,capture_output=True,timeout=timeout,**kw)
  log.append({'argv':[str(a) for a in argv],'exit_code':p.returncode,'stdout':p.stdout[-4000:],'stderr':p.stderr[-4000:]})
  return p
 try:
  f=IdentityFixture(extra_actions=SHIPPED_AUTHORITY)
  owner_sql=lambda sql,values=():f.sql(sql,list(values),serial=False)
  folder.chmod(0o755)
  # Release-layout copy: root-owned files without group or world write, traversable by the follower uids.
  release=folder/'release';(release/'runtime').mkdir(parents=True);(release/'deploy/hyperfide').mkdir(parents=True);(release/'services').mkdir()
  shutil.copyfile(shutil.which('node'),release/'runtime/node');(release/'runtime/node').chmod(0o755)
  for name in ['dist','components','migrations','node_modules']:shutil.copytree(ROOT/'core/control-plane'/name,release/'services'/name,symlinks=True)
  shutil.copyfile(ROOT/'core/control-plane/package.json',release/'services/package.json')
  for name in ['migrate.mjs','bootstrap-fence.mjs']:shutil.copyfile(ROOT/'deploy/hyperfide'/name,release/'deploy/hyperfide'/name);(release/'deploy/hyperfide'/name).chmod(0o644)
  node=str(release/'runtime/node');fence=[node,str(release/'deploy/hyperfide/bootstrap-fence.mjs')]
  control=folder/'control';control.mkdir(mode=0o700)
  for name in ['leader','fences','preparation','source','operator']:(control/name).mkdir(mode=0o700)
  recorder=control/'recorded-railway.mjs';private(recorder,RECORDER)
  railway=control/'railway.json';private(railway,json.dumps({'schema_version':1,'mode':'live','endpoint':'https://backboard.railway.com/graphql/v2','environment_id':'fixture-env','region':'fixture-region','account_id':'fixture-account','token_env':'HF_RAILWAY_TOKEN','auth_type':'bearer','preparation_root':str(control/'preparation'),'request_timeout_ms':5000,'exec_ws_endpoint':None}))
  key_id='greenfield-operator';key=Path(f.keys['operator']['path']);verifier=control/'verifier.json'
  private(verifier,json.dumps({'schema_version':1,'issuers':[{'key_id':key_id,'public_key_b64':f.keys['operator']['public_key_b64']}]}))
  policy=control/'policy.json';shutil.copyfile(f.policy,policy);policy.chmod(0o600)
  source=control/'source/intent.kvx';source.write_text('[meta]\nslug="greenfield-first-epoch"\n[req.1]\nac_1="Greenfield first epoch"\n[acceptance.1]\nreq="1.1"\n[task.1]\nwave=1\nreqs=["1.1"]\nacceptance_ids=["1"]\nstatus="pending"\n')
  oid=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
  record=control/'railway-calls.jsonl';occupied=control/'occupied'
  common={**f.env,'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(control/'leader'),'HYPERFIDE_MIGRATION_DATABASE_URL':f.url,'HF_RAILWAY_CONFIG':str(railway),'HF_RAILWAY_TOKEN':'recorded-transport-'+uuid.uuid4().hex,
   'HYPERFIDE_EXTERNAL_FENCE_JOURNAL_DIR':str(control/'fences'),'HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE':str(verifier),'HYPERFIDE_BOOTSTRAP_SOURCE_ROOT':str(control/'source'),'HF29_12_RECORD':str(record),'HF29_12_OCCUPIED':str(occupied)}
  for k in ['HF_LEGACY_WRITER_CONFIG_FILE','HYPERFIDE_POOL_CONFIG','HYPERFIDE_WRITER_ISOLATION_CONFIG','HYPERFIDE_ISOLATION_PERMIT_FILE','HYPERFIDE_GREENFIELD_INTENT_FILE']:common.pop(k,None)
  limits={'SANDBOX':'100','PROVISIONING':'10','CPU_MILLIS':'1000000','MEMORY_BYTES':'107374182400','DISK_BYTES':'1073741824000'}
  def scenario(name,deployment,org,project,run_id):
   d=control/name;d.mkdir(mode=0o700);pool=str(uuid.uuid4())
   private(d/'pools.json',json.dumps({'schema_version':1,'organisation_id':org,'revision':'29.12-greenfield-'+name,'accounts':[{'provider':'railway','account_key':'fixture-account','approved_limits':limits,'planning_limits':limits}],
    'pools':[{'id':pool,'provider':'railway','account_key':'fixture-account','environment_key':'fixture-env','region':'fixture-region','profile_id':None,'preparation_digest':f.preparation,'approved_limits':limits,'planning_limits':limits,'create_policy':{'seed_reference':'fixture-seed','network':'ISOLATED','stdin_required':False}}],'maximum_operation_ms':10000}))
   repo=str(uuid.uuid4())
   metadata={'organisation':{'id':org,'name':'greenfield'},'project':{'id':project,'name':'greenfield'},'repositories':[{'id':repo,'name':'greenfield','url':'https://example.invalid/greenfield.git','object_format':'sha1','checkout_root':str(ROOT),'source_objects':[{'object_id':oid,'object_type':'commit'}]}]}
   accepted={'run_id':run_id,'source':{'relative_path':source.name,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'size_bytes':str(source.stat().st_size)},'repositories':[{'repository_id':repo,'source_object_id':oid,'integration_ref':'refs/heads/greenfield'}],'allowed_actions':ACTIONS,'closure_policy':{'required_evidence':['fixture.compile'],'required_review_roles':['VERIFIER'],'publication':'AFTER_QUALIFICATION'},'provenance':None}
   private(d/'intent.json',json.dumps({'schema_version':1,'scope':{'organisation_id':org,'project_id':project,'run_id':run_id,'allowed_actions':ACTIONS},'metadata':metadata,'accepted_intent':accepted}))
   isolation={'schema_version':1,'scope':'GREENFIELD','deployment_id':deployment,'organisation_id':org,'run_id':run_id,'source_epoch':None,'topology_digest':'sha256:'+'0'*64,'evidence_scope':'LIVE_PROVIDER','maximum_operation_ms':20000,'proof_max_age_ms':20000,'resources':[]}
   env={**common,'HYPERFIDE_DEPLOYMENT_ID':deployment,'HYPERFIDE_POOL_CONFIG':str(d/'pools.json'),'HYPERFIDE_GREENFIELD_INTENT_FILE':str(d/'intent.json'),'HYPERFIDE_WRITER_ISOLATION_CONFIG':str(d/'isolation.json'),'HYPERFIDE_ISOLATION_PERMIT_FILE':str(d/'permit.json')}
   private(d/'isolation.json',json.dumps(isolation))
   first=outcome(run(fence+['--topology'],env,cwd=release));isolation['topology_digest']=first.get('topology_digest','');private(d/'isolation.json',json.dumps(isolation))
   second=outcome(run(fence+['--topology'],env,cwd=release))
   return {'dir':d,'env':env,'pool':pool,'isolation':isolation,'first':first,'second':second,'deployment':deployment,'org':org,'project':project,'run':run_id,'metadata':metadata,'accepted':accepted,'digest':second.get('topology_digest')}
  def permit(s,operation,name='permit'):
   out=s['dir']/(name+'-out');out.mkdir(mode=0o700)
   payload=outcome(run(fence+['--permit-payload','--operation-id',operation,'--key-id',key_id,'--ttl-seconds','600','--output-dir',out],s['env'],cwd=release))
   # Off-box operator signature over the printed signing input.
   sig=control/'operator'/(name+'-'+operation);sig.mkdir(mode=0o700)
   (sig/'permit.sig').write_bytes(sign(key,(out/'permit.signing-input').read_bytes(),sig))
   sealed=outcome(run(fence+['--seal-permit','--operation-id',operation,'--key-id',key_id,'--payload',out/'permit.payload','--signature',sig/'permit.sig','--output',s['env']['HYPERFIDE_ISOLATION_PERMIT_FILE']],s['env'],cwd=release))
   verified=outcome(run(fence+['--verify-permit','--operation-id',operation],s['env'],cwd=release))
   return payload,out,sig,sealed,verified
  migrate=[node,'--import',recorder.as_uri(),str(release/'deploy/hyperfide/migrate.mjs'),'--release-root',str(release),'--policy-file',str(policy),'--spec-revision','fixture-identity-v1','--activate-authority','--fence-driver','deploy/hyperfide/bootstrap-fence.mjs','--operation-id']
  epochs=lambda deployment:owner_sql('SELECT epoch::text AS epoch,activation_kind,state,fence_id::text AS fence_id,xmin::text AS xid FROM hyperfide.authority_epochs WHERE deployment_id=$1',[deployment])
  calls=lambda:[json.loads(l) for l in record.read_text().splitlines()] if record.exists() else []
  def refused(name,env,operation,code,deployment,history=0):
   p=run(migrate+[operation],env,cwd=release);v=outcome(p);o[name+'-response']=v
   return p.returncode==1 and v.get('ok') is False and v.get('error',{}).get('code')==code and len(epochs(deployment))==history and not (control/'leader'/(deployment+'.authority.json')).exists()

  g=scenario('greenfield',str(uuid.uuid4()),str(uuid.uuid4()),str(uuid.uuid4()),str(uuid.uuid4()));D=g['digest'];t=g['second'].get('topology',{})
  o['topology-consistent']=g['first'].get('consistent') is False and g['second'].get('consistent') is True and D==g['first'].get('topology_digest') and t.get('scope')=='GREENFIELD' and t.get('resources')==[] and t.get('required_writer_ids')==[] and t.get('legacy_status')=='NONE' and t.get('source_epoch') is None and [x['pool_id'] for x in t.get('provider_scopes',[])]==[g['pool']] and t.get('organisation_id')==g['org'] and t.get('project_id')==g['project'] and t.get('run_id')==g['run']
  operation=str(uuid.uuid4());payload_result,out,sig,sealed,verified=permit(g,operation)
  payload=(out/'permit.payload').read_bytes();claims=json.loads(payload)
  o['payload-scoped']=payload_result.get('ok') is True and canonical(claims).encode()==payload and claims['scope']=='GREENFIELD' and claims['resources']==[] and claims['source_epoch'] is None and claims['topology_digest']==D and claims['operation_id']==operation and claims['deployment_id']==g['deployment'] and claims['organisation_id']==g['org'] and claims['run_id']==g['run'] and (out/'permit.signing-input').read_bytes()==signing_input(key_id,payload)
  good=Path(g['env']['HYPERFIDE_ISOLATION_PERMIT_FILE']).read_bytes()
  o['seal-verified']=sealed.get('ok') is True and verified.get('ok') is True and verified.get('topology_digest')==D and good==envelope(key_id,payload,(sig/'permit.sig').read_bytes())

  # A greenfield permit or configuration never covers a legacy writer, a writer resource or a legacy writer permit.
  writer_config=control/'legacy.json';private(writer_config,json.dumps({'schema_version':1,'deployment_id':g['deployment'],'source_epoch':None,'workspace_root':str(control),'data_roots':['source'],'legacy_writer_id':'writer','expected_pid_namespace':os.readlink('/proc/self/ns/pid'),'expected_mount_namespace':os.readlink('/proc/self/ns/mnt')}))
  writer_env={**g['env'],'HF_LEGACY_WRITER_CONFIG_FILE':str(writer_config)}
  top=outcome(run(fence+['--topology'],writer_env,cwd=release))
  o['legacy-writer-refused']=top.get('error',{}).get('code')=='ISOLATION_PERMIT_SCOPE' and refused('legacy-writer',writer_env,operation,'ISOLATION_PERMIT_SCOPE',g['deployment'])
  with_resource={**g['isolation'],'resources':[{'reference_key':'writer'}]};resource_file=g['dir']/'isolation-resource.json';private(resource_file,json.dumps(with_resource))
  resource_env={**g['env'],'HYPERFIDE_WRITER_ISOLATION_CONFIG':str(resource_file)}
  top=outcome(run(fence+['--topology'],resource_env,cwd=release))
  o['resources-refused']=top.get('error',{}).get('code')=='ISOLATION_PERMIT_SCOPE' and refused('resources',resource_env,operation,'ISOLATION_PERMIT_SCOPE',g['deployment'])
  writer_claims={k:v for k,v in claims.items() if k!='scope'};writer_claims.update(resources=[{'reference_key':'writer','topology_digest':D}],nonce=str(uuid.uuid4()))
  body=canonical(writer_claims).encode();legacy_sig=control/'operator'/'legacy-permit';legacy_sig.mkdir(mode=0o700)
  legacy_permit=g['dir']/'legacy-permit.json';private(legacy_permit,envelope(key_id,body,sign(key,signing_input(key_id,body),legacy_sig)))
  legacy_env={**g['env'],'HYPERFIDE_ISOLATION_PERMIT_FILE':str(legacy_permit)}
  check=outcome(run(fence+['--verify-permit','--operation-id',operation],legacy_env,cwd=release))
  o['legacy-permit-refused']=check.get('error',{}).get('code')=='ISOLATION_PERMIT_SCOPE' and refused('legacy-permit',legacy_env,operation,'ISOLATION_PERMIT_SCOPE',g['deployment'])

  # History: the fixture deployment already holds an epoch.
  h=scenario('history',f.ids['deployment'],str(uuid.uuid4()),str(uuid.uuid4()),str(uuid.uuid4()));op=str(uuid.uuid4());permit(h,op,'history')
  o['history-refused']=h['second'].get('consistent') is True and refused('history',h['env'],op,'ISOLATION_PERMIT_SCOPE',h['deployment'],history=1)
  # Rows: the fixture organisation already has a run, a pool and a sandbox.
  r=scenario('run',str(uuid.uuid4()),f.ids['organisation'],str(uuid.uuid4()),str(uuid.uuid4()));op=str(uuid.uuid4());permit(r,op,'run')
  o['run-present-refused']=refused('run',r['env'],op,'GREENFIELD_NOT_EMPTY',r['deployment']) and not record.exists()
  sandbox_org=str(uuid.uuid4());sandbox_pool=str(uuid.uuid4())
  owner_sql("INSERT INTO hyperfide.organisations(id,name) VALUES($1,'greenfield-sandbox')",[sandbox_org])
  owner_sql("INSERT INTO hyperfide.provider_pools(organisation_id,id,provider,account_key,environment_key,region) VALUES($1,$2,'fixture','fixture','fixture','fixture')",[sandbox_org,sandbox_pool])
  owner_sql("INSERT INTO hyperfide.sandboxes(organisation_id,id,pool_id,native_sandbox_id,observed_state,preparation_digest) VALUES($1,$2,$3,'greenfield-db-sandbox','RUNNING',$4)",[sandbox_org,str(uuid.uuid4()),sandbox_pool,f.preparation])
  s=scenario('sandbox',str(uuid.uuid4()),sandbox_org,str(uuid.uuid4()),str(uuid.uuid4()));op=str(uuid.uuid4());permit(s,op,'sandbox')
  o['database-sandbox-present-refused']=refused('database-sandbox',s['env'],op,'GREENFIELD_NOT_EMPTY',s['deployment']) and owner_sql('SELECT count(*)::text AS n FROM hyperfide.runs WHERE organisation_id=$1',[sandbox_org])==[{'n':'0'}] and not record.exists()
  # Provider: the configured pool still holds a sandbox the database does not know.
  occupied.write_text('occupied\n');op=str(uuid.uuid4());occ={**g,'env':{**g['env'],'HYPERFIDE_ISOLATION_PERMIT_FILE':str(g['dir']/'occupied-permit.json')}};permit(occ,op,'occupied')
  try:o['provider-sandbox-present-refused']=refused('provider-sandbox',occ['env'],op,'GREENFIELD_NOT_EMPTY',g['deployment']) and [c['operation'] for c in calls()]==['RailwayInventory']
  finally:occupied.unlink()
  o['no-epoch-before-activation']=epochs(g['deployment'])==[] and owner_sql('SELECT (SELECT count(*) FROM hyperfide.organisations WHERE id=$1)::text AS orgs,(SELECT count(*) FROM hyperfide.runs WHERE organisation_id=$1)::text AS runs',[g['org']])==[{'orgs':'0','runs':'0'}]

  # Control on the greenfield deployment: no principals to seed, and no authority yet.
  identity=control/'identity.json';identity.write_text(json.dumps({'schema_version':1,'origin':f.origin,'clock_skew_seconds':30,'grant_ttl_seconds':300,'credential_ttl_seconds':3600,'principals':[]}));identity.chmod(0o600)
  f.stop();f.env.update({'HYPERFIDE_DEPLOYMENT_ID':g['deployment'],'HYPERFIDE_AUTHORITY_JOURNAL_DIR':str(control/'leader'),'HF_IDENTITY_CONFIG_FILE':str(identity)})
  try:f.start();o['control-before-activation']='started'
  except AssertionError as e:o['control-before-activation']=str(e)[:1500]
  finally:
   if f.child:
    if f.child.poll() is None and o['control-before-activation']=='started':f.stop()
    elif f.child.poll() is None:f.child.kill();f.child.communicate()
    f.child=None
  o['control-refused-before-activation']=o['control-before-activation']!='started' and epochs(g['deployment'])==[]

  # The exact permitted operation activates: emptiness is proven again inside the fence and the rows are minted in the epoch transaction.
  private(Path(g['env']['HYPERFIDE_ISOLATION_PERMIT_FILE']),good)
  before=len(calls())
  p=run(migrate+[operation],g['env'],cwd=release);v=outcome(p);o['activation-response']=v
  o['activated']=p.returncode==0 and v.get('ok') is True and v.get('receipt',{}).get('replayed') is False and v.get('authority_activated') is True
  rows=epochs(g['deployment']);epoch=rows[0]['epoch'] if rows else None;o['epoch']=epoch
  o['single-bootstrap-epoch']=len(rows)==1 and rows[0]['activation_kind']=='BOOTSTRAP' and rows[0]['state']=='ACTIVE' and epoch==v.get('receipt',{}).get('epoch') and rows[0]['fence_id']==operation
  minted=owner_sql('SELECT r.id::text AS run,r.authority_epoch::text AS epoch,r.xmin::text AS xid,p.id::text AS project,o.id::text AS org FROM hyperfide.runs r JOIN hyperfide.projects p ON p.organisation_id=r.organisation_id AND p.id=r.project_id JOIN hyperfide.organisations o ON o.id=r.organisation_id WHERE r.organisation_id=$1',[g['org']])
  o['minted-rows']=minted
  o['rows-minted-in-epoch']=bool(rows) and minted==[{'run':g['run'],'epoch':epoch,'xid':rows[0]['xid'],'project':g['project'],'org':g['org']}] and owner_sql('SELECT count(*)::text AS n FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2',[g['org'],g['run']])==[{'n':'1'}]
  journal=json.loads((control/'fences'/(operation+'.json')).read_text());retained=journal.get('completion_receipts',[{}])[-1];evidence=json.loads(retained.get('evidence_json','null') or 'null');receipt=json.loads(retained.get('json','{}'))
  o['evidence']=evidence
  o['evidence-retained']=isinstance(evidence,dict) and 'sha256:'+hashlib.sha256(retained['evidence_json'].encode()).hexdigest()==receipt.get('evidence_digest') and evidence['scope']=='GREENFIELD' and evidence['topology_digest']==D and evidence['resource_count']==0 and evidence['required_writer_ids']==[] and evidence['legacy_status']=='NONE' and evidence['database']['authority_history']==0 and set(evidence['database']['counts'].values())=={0} and [(x['scope']['pool_id'],x['transport'],x['enumeration_complete'],x['items']) for x in evidence['provider_inventories']]==[(g['pool'],'AVAILABLE',True,[])] and receipt.get('isolated_writer')=='topology:'+D[7:]
  o['recorded-calls']=calls()
  o['inventory-read-only']=len(calls())==before+1 and all(c['operation']=='RailwayInventory' and c['mutation'] is False and c['variables'].get('environmentId')=='fixture-env' and c['authorization']=='Bearer '+g['env']['HF_RAILWAY_TOKEN'] for c in calls())

  # Followers adopt the committed journal document under their own uids and never mint.
  document=control/'leader'/(g['deployment']+'.authority.json')
  for n,role in enumerate(['control','provisioner','dispatch'],start=61001):
   home=folder/('follower-'+role);home.mkdir(mode=0o700);os.chown(home,n,n);journal_dir=home/'journal';journal_dir.mkdir(mode=0o700);os.chown(journal_dir,n,n)
   copy=home/'authority.json';shutil.copyfile(document,copy);copy.chmod(0o600);os.chown(copy,n,n)
   own_policy=home/'policy.json';shutil.copyfile(f.policy,own_policy);own_policy.chmod(0o600);os.chown(own_policy,n,n)
   follower={k:v for k,v in g['env'].items() if not k.startswith(('HF_RAILWAY','HYPERFIDE_ISOLATION','HYPERFIDE_EXTERNAL_FENCE','HYPERFIDE_GREENFIELD','HYPERFIDE_POOL','HYPERFIDE_WRITER','HYPERFIDE_BOOTSTRAP','HF29_12'))};follower['HYPERFIDE_AUTHORITY_JOURNAL_DIR']=str(journal_dir)
   q=run([node,str(release/'deploy/hyperfide/migrate.mjs'),'--release-root',str(release),'--policy-file',str(own_policy),'--spec-revision','fixture-identity-v1','--adopt-authority','--journal-document',str(copy),'--operation-id',operation],follower,cwd=release,user=n,group=n,extra_groups=[])
   a=outcome(q);o[role+'-adoption-response']=a
   probe=run([node,'--input-type=module','-e',legacy.ROLE_PROBE.replace('HF29_11_ROLE','HF29_12_ROLE')],{**follower,'HF29_12_ROLE':role},cwd=release,user=n,group=n,extra_groups=[])
   current=outcome(probe)
   o[role+'-adopts']=q.returncode==0 and a.get('ok') is True and epoch is not None and a.get('receipt',{}).get('epoch')==epoch and a.get('authority_activated') is True and probe.returncode==0 and current.get('epoch')==epoch and current.get('uid')==n
  o['followers-no-mint']=owner_sql('SELECT activation_kind FROM hyperfide.authority_epochs WHERE deployment_id=$1',[g['deployment']])==[{'activation_kind':'BOOTSTRAP'}] and len(owner_sql('SELECT 1 FROM hyperfide.runs WHERE organisation_id=$1',[g['org']]))==1

  # Control now starts on the greenfield deployment and the first OPERATOR is issued against the minted intent.
  try:f.start();o['control-starts']=True
  except AssertionError as e:o['control-start-error']=str(e)[:1500];f.child=None
  credential={'credential_id':str(uuid.uuid4()),'actor_id':str(uuid.uuid4()),'public_key_b64':f.keys['operator']['public_key_b64'],'allowed_actions':ACTIONS,'expires_at':(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=30)).isoformat(timespec='milliseconds').replace('+00:00','Z')}
  issue=control/'first-operator.json';private(issue,json.dumps({'schema_version':1,'scope':{'organisation_id':g['org'],'project_id':g['project'],'run_id':g['run'],'authority_epoch':epoch,'allowed_actions':ACTIONS},'metadata':g['metadata'],'accepted_intent':g['accepted'],'credential':credential}))
  issue_env={k:v for k,v in f.env.items()};issue_env.update(HYPERFIDE_MODE='distributed',HYPERFIDE_BOOTSTRAP_SOURCE_ROOT=str(control/'source'),HYPERFIDE_BOOTSTRAP_MAX_TTL_MS='3600000')
  p=run(['node',ROOT/'core/control-plane/dist/bootstrap.js','--input',issue],issue_env,cwd=ROOT)
  lines=(p.stdout if p.returncode==0 else p.stderr).splitlines()
  try:answer=json.loads(lines[-1]) if lines else {}
  except ValueError:answer={}
  o['first-operator-response']=answer;res=answer.get('result',{})
  o['first-operator-issued']=p.returncode==0 and res.get('credential',{}).get('role')=='OPERATOR' and res.get('credential',{}).get('credential_id')==credential['credential_id'] and res.get('credential',{}).get('replayed') is False and res.get('private_key_created') is False and owner_sql("SELECT role,deployment_epoch::text AS epoch FROM hyperfide.identity_principals WHERE credential_id=$1",[credential['credential_id']])==[{'role':'OPERATOR','epoch':epoch}]

  # Release commands receive no signing key: neither their arguments nor their environment name it, and the shipped driver has no issuing path.
  shipped=[(release/'deploy/hyperfide/bootstrap-fence.mjs').read_text(),(release/'services/dist/recovery/bootstrap_fence.js').read_text()]
  release_runs=[x for x in log if x['argv'][0]==node]
  o['no-signing-key-read']=all(str(key) not in v for e in [common,g['env'],f.env] for v in e.values()) and bool(release_runs) and all(str(key) not in json.dumps(x['argv']) for x in release_runs) and all('issueIsolationPermit' not in s and 'private_key_file' not in s for s in shipped)

  # The legacy 29.11 writer path is unchanged: its registered case still passes on this source.
  legacy_dir=base/'legacy-29.11';legacy_dir.mkdir(exist_ok=True)
  q=run([sys.executable,ROOT/'tests/hyperfide/cases/tasks/29_11.py'],{**os.environ,'HYPERFIDE_CAMPAIGN_DIR':str(legacy_dir)},cwd=ROOT,timeout=540)
  lines=[json.loads(l) for l in q.stdout.splitlines() if l.startswith('{')]
  o['legacy-results']=[x for x in lines if x.get('type')=='assertion' and x.get('actual') is not True]
  o['legacy-unchanged']=q.returncode==0 and len([x for x in lines if x.get('type')=='assertion'])==len(legacy.IDS) and o['legacy-results']==[] and any(x.get('type')=='cleanup' and x.get('complete') is True for x in lines)
 except Exception as e:o['error']=repr(e)
 finally:
  if f:
   database,role=f.database,f.runtime_role
   try:f.close()
   except Exception as e:o['cleanup-error']=repr(e)
   state=f.sql('SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) AS db,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) AS role',[database,role],admin=True)[0]
   complete=not state['db'] and not state['role']
  shutil.rmtree(folder,ignore_errors=True);complete=complete and not folder.exists()
 (base/'greenfield-processes.json').write_text(json.dumps(log,indent=2,default=str)+'\n')
 (base/'greenfield-observations.json').write_text(json.dumps(o,indent=2,default=str)+'\n')
 for name in IDS:print(json.dumps({'type':'assertion','id':name,'expected':True,'actual':o.get(name.removeprefix('greenfield.')) is True}),flush=True)
 print(json.dumps({'type':'cleanup','complete':complete,'resources':[]}),flush=True)
 if 'error' in o:print(o['error'],file=sys.stderr)
 return 0 if complete and all(o.get(n.removeprefix('greenfield.')) is True for n in IDS) else 1
if __name__=='__main__':raise SystemExit(main())
