#!/usr/bin/env python3
"""Real offline operator signature, versioned admission and immutable reissue on isolated PG."""
import copy,datetime,hashlib,json,os,subprocess,sys,tempfile,uuid,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture,canonical,sha,uid
from fleet_prerequisite_fixture import component_closure
OUT=ROOT/'build/fleet/bootstrap-capabilities'

def main():
 OUT.mkdir(parents=True,exist_ok=True)
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=None;checks=[]
 try:
  with tempfile.TemporaryDirectory(prefix='hf-capability-') as directory:
   f=IdentityFixture(extra_components=component_closure(['spec-revisions']),extra_env={'HF_SPEC_ALLOWED_ROOT':directory})
   root=Path(directory);source=root/'intent.kvx';exe=str(Path(sys.executable).resolve());check={'argv':[exe,'-c','print(42)'],'executable_digest':sha(Path(exe).read_bytes()),'timeout_ms':600000,'required_artifacts':['proof.json'],'input_keys':['source']}
   text='[meta]\nslug="capability-approval"\n[req.1]\nac_1="Real operational approval"\n[acceptance.1]\nreq="1.1"\nchecks=["actual-check"]\n[task.1]\nwave=1\nreqs=["1.1"]\nacceptance_ids=["1"]\nverify_cmd="printf accepted"\nartifacts=["proof.json"]\n[proof]\nrubric_digest='+json.dumps(sha(b'rubric'))+'\n[proof.check.actual-check]\n'+''.join(k+'='+json.dumps(v)+'\n' for k,v in check.items());source.write_text(text)
   ids={k:uid() for k in ['org','project','repo','run','credential','actor']};oid=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip();actions=sorted(['identity.describe','spec.amendment.propose','spec.amendment.admit']);expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=20)).isoformat(timespec='milliseconds').replace('+00:00','Z')
   scope={'organisation_id':ids['org'],'project_id':ids['project'],'run_id':ids['run'],'authority_epoch':f.ids['epoch'],'allowed_actions':actions}
   accepted={'run_id':ids['run'],'source':{'relative_path':source.name,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'size_bytes':str(source.stat().st_size)},'repositories':[{'repository_id':ids['repo'],'source_object_id':oid,'integration_ref':'refs/heads/capability'}],'allowed_actions':actions,'closure_policy':{'required_evidence':['actual-check'],'required_review_roles':['VERIFIER'],'publication':'AFTER_QUALIFICATION'},'provenance':None}
   initial={'schema_version':1,'scope':scope,'metadata':{'organisation':{'id':ids['org'],'name':'capability'},'project':{'id':ids['project'],'name':'capability'},'repositories':[{'id':ids['repo'],'name':'capability','url':'https://example.invalid/capability.git','object_format':'sha1','checkout_root':str(ROOT),'source_objects':[{'object_id':oid,'object_type':'commit'}]}]},'accepted_intent':accepted,'credential':{'credential_id':ids['credential'],'actor_id':ids['actor'],'public_key_b64':f.keys['operator']['public_key_b64'],'allowed_actions':actions,'expires_at':expiry}}
   env=dict(f.env,HYPERFIDE_MODE='distributed',HYPERFIDE_BOOTSTRAP_SOURCE_ROOT=str(root),HYPERFIDE_BOOTSTRAP_MAX_TTL_MS='3600000');inputfile=root/'input.json'
   def call(body,mode=None):
    inputfile.write_text(json.dumps(body));inputfile.chmod(0o600);p=subprocess.run(['node',str(ROOT/'core/control-plane/dist/bootstrap.js'),*([mode] if mode else []),'--input',str(inputfile)],cwd=ROOT,env=env,capture_output=True,text=True,timeout=50);lines=(p.stdout if p.returncode==0 else p.stderr).splitlines();return p,json.loads(lines[-1]) if lines else {}
   p,first=call(initial)
   if p.returncode:raise AssertionError('Initial actual issuer failed: '+p.stderr[:1500])
   checks.append('actual-initial-issuance');row=f.sql('SELECT r.spec_revision_id,r.spec_generation::text,r.state_version::text,s.revision_digest FROM hyperfide.runs r JOIN hyperfide.spec_revisions s ON s.organisation_id=r.organisation_id AND s.id=r.spec_revision_id WHERE r.organisation_id=$1 AND r.id=$2',[ids['org'],ids['run']])[0];task=f.sql('SELECT id::text,criteria_digest FROM hyperfide.tasks WHERE organisation_id=$1 AND run_id=$2',[ids['org'],ids['run']])[0]
   target=sorted(actions+['outbox.consumer.register']);replacement=copy.deepcopy(accepted);replacement['allowed_actions']=target
   derive="import{prepareAcceptedIntent}from'./core/control-plane/dist/spec/import.js';let s='';for await(const c of process.stdin)s+=c;const x=JSON.parse(s);const p=await prepareAcceptedIntent(x.scope,x.replacement);console.log(JSON.stringify({specId:p.specId}));"
   prepared=json.loads(subprocess.check_output(['node','--input-type=module','-e',derive],cwd=ROOT,env=env,input=json.dumps({'scope':dict(scope,root=str(root),allowed_actions=target),'replacement':replacement}),text=True))
   policy={'schema_version':1,'criteria_digest':task['criteria_digest'],'spec_revision_id':prepared['specId'],'spec_generation':str(int(row['spec_generation'])+1),'repository_id':ids['repo'],'source_object_id':oid,'rubric_digest':sha(b'rubric'),'checks':[dict(id='actual-check',**check)],'clauses':[{'id':'1.1','mode':'EXECUTABLE','acceptance_ids':['1'],'checks':['actual-check']}],'inputs':{k:sha(k.encode()) for k in ['source','dependency','toolchain','configuration','graph','contract']},'contract_digests':[]}
   approval={'kind':'BOOTSTRAP_CAPABILITY_APPROVAL_V1','approval_id':uid(),'organisation_id':ids['org'],'run_id':ids['run'],'authority_epoch':f.ids['epoch'],'previous_credential_id':ids['credential'],'previous_revision_digest':row['revision_digest'],'spec_generation':row['spec_generation'],'state_version':row['state_version'],'approved_actions':target,'amendment':{'run_id':ids['run'],'base_spec_revision_id':row['spec_revision_id'],'base_spec_generation':row['spec_generation'],'state_version':row['state_version'],'purpose':'INTENT_CHANGE','reason':'Approve actual consumer registration','replacement':replacement},'revalidate_task_ids':[task['id']],'proof_policies':[{'task_key':'1','policy':policy}],'justification':'Explicit operational scope approval','credential':{'credential_id':uid(),'actor_id':ids['actor'],'public_key_b64':f.keys['provisioner']['public_key_b64'],'expires_at':expiry}}
   def signed(a,key='operator'):return {'schema_version':1,'approval':a,'signature_b64':f.sign(key,json.dumps(a,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())}
   def refusal(name,a,code,key='operator'):
    p,r=call(signed(a,key),'--amend-capabilities')
    if p.returncode!=78 or r.get('error',{}).get('code')!=code:raise AssertionError(name+': '+str(r))
    checks.append(name)
   refusal('wrong-operator-key',approval,'AUTH_SIGNATURE_INVALID','provisioner')
   stale=copy.deepcopy(approval);stale['state_version']='99';refusal('stale-base',stale,'BOOTSTRAP_ACCEPTANCE_MISMATCH')
   excess=copy.deepcopy(approval);excess['amendment']['replacement']['allowed_actions']=target+['outbox.claim'];refusal('unapproved-action',excess,'AUTH_SCOPE_DENIED')
   p,result=call(signed(approval),'--amend-capabilities')
   if p.returncode:raise AssertionError('Actual amendment/reissue failed: '+p.stderr[:2500])
   checks.append('actual-versioned-amendment-and-reissue');p,replay=call(signed(approval),'--amend-capabilities')
   if p.returncode or not replay.get('result',{}).get('replayed'):raise AssertionError('Exact approval replay failed '+str(replay))
   checks.append('immutable-idempotent-replay')
   rows=f.sql('SELECT credential_id::text,state,allowed_actions FROM hyperfide.identity_principals WHERE credential_id=ANY($1::uuid[]) ORDER BY credential_id',[[ids['credential'],approval['credential']['credential_id']]])
   if not any(r['credential_id']==ids['credential'] and r['state']=='REVOKED' and r['allowed_actions']==actions for r in rows) or not any(r['credential_id']==approval['credential']['credential_id'] and r['state']=='ACTIVE' and r['allowed_actions']==target for r in rows):raise AssertionError('Issuer changed immutable grants or failed fencing')
   checks.append('predecessor-revoked-successor-scoped')
   old=f.sql('SELECT accepted_revision_digest FROM hyperfide.identity_bootstrap_issuances WHERE organisation_id=$1 AND run_id=$2',[ids['org'],ids['run']])[0]
   if old['accepted_revision_digest']!=row['revision_digest']:raise AssertionError('Original issuance overwritten')
   history=f.sql('SELECT count(*)::int n FROM hyperfide.run_spec_revisions WHERE organisation_id=$1 AND run_id=$2',[ids['org'],ids['run']])[0]
   if history['n']!=2:raise AssertionError('Accepted history missing')
   checks.append('original-issuance-and-accepted-history-preserved')
   current=f.sql('SELECT r.spec_revision_id,r.spec_generation::text,r.state_version::text,s.revision_digest,s.source_digest FROM hyperfide.runs r JOIN hyperfide.spec_revisions s ON s.organisation_id=r.organisation_id AND s.id=r.spec_revision_id WHERE r.organisation_id=$1 AND r.id=$2',[ids['org'],ids['run']])[0]
   next_source=root/'intent-next.kvx';next_source.write_text(text+'\n[notes]\npurpose="Explicit reviewed source transition"\n');next_replacement=copy.deepcopy(replacement);next_replacement['source']={'relative_path':next_source.name,'sha256':hashlib.sha256(next_source.read_bytes()).hexdigest(),'size_bytes':str(next_source.stat().st_size)}
   next_approval=copy.deepcopy(approval);next_approval.update(kind='BOOTSTRAP_INTENT_APPROVAL_V1',approval_id=uid(),previous_credential_id=approval['credential']['credential_id'],previous_revision_digest=current['revision_digest'],previous_source_digest=current['source_digest'],approved_source_digest=sha(next_source.read_bytes()),spec_generation=current['spec_generation'],state_version=current['state_version'],proof_policies=[])
   next_approval['credential'].update(credential_id=uid(),public_key_b64=f.keys['operator']['public_key_b64']);next_approval['amendment'].update(base_spec_revision_id=current['spec_revision_id'],base_spec_generation=current['spec_generation'],state_version=current['state_version'],replacement=next_replacement)
   mismatch=copy.deepcopy(next_approval);mismatch['approved_source_digest']=sha(b'unapproved')
   p,r=call(signed(mismatch,'provisioner'),'--amend-intent')
   if p.returncode!=78 or r.get('error',{}).get('code')!='AUTH_SCOPE_DENIED':raise AssertionError('Unsigned source transition accepted: '+str(r))
   checks.append('unapproved-source-bytes-refused')
   p,r=call(signed(next_approval,'provisioner'),'--amend-intent')
   if p.returncode:raise AssertionError('Explicit source transition failed: '+p.stderr[:2500])
   checks.append('explicit-signed-source-transition-with-proof-carry')
   # Genuine server transaction delay crosses a signed short expiry after insertion.
   near=copy.deepcopy(next_approval);now=f.sql('SELECT r.spec_revision_id,r.spec_generation::text,r.state_version::text,s.revision_digest,s.source_digest FROM hyperfide.runs r JOIN hyperfide.spec_revisions s ON s.organisation_id=r.organisation_id AND s.id=r.spec_revision_id WHERE r.organisation_id=$1 AND r.id=$2',[ids['org'],ids['run']])[0]
   near.update(approval_id=uid(),previous_credential_id=next_approval['credential']['credential_id'],previous_revision_digest=now['revision_digest'],previous_source_digest=now['source_digest'],spec_generation=now['spec_generation'],state_version=now['state_version'])
   near['amendment'].update(base_spec_revision_id=now['spec_revision_id'],base_spec_generation=now['spec_generation'],state_version=now['state_version']);near['credential'].update(credential_id=uid(),expires_at=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=3)).isoformat(timespec='milliseconds').replace('+00:00','Z'))
   near_source=root/'near-expiry.kvx';near_source.write_text(next_source.read_text()+'\n[near]\nreason="Expiry boundary"\n');near['approved_source_digest']=sha(near_source.read_bytes());near['amendment']['replacement']['source']={'relative_path':near_source.name,'sha256':hashlib.sha256(near_source.read_bytes()).hexdigest(),'size_bytes':str(near_source.stat().st_size)}
   lockjs="import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');await c.query('LOCK TABLE hyperfide.identity_bootstrap_capability_approvals IN SHARE MODE');process.stdout.write('LOCKED\\n');for await(const x of process.stdin){break;}await c.query('COMMIT');await c.end();"
   locker=subprocess.Popen(['node','--input-type=module','-e',lockjs],cwd=ROOT/'core/control-plane',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   if locker.stdout.readline().strip()!='LOCKED':raise AssertionError('Actual PG table lock unavailable')
   inputfile.write_text(json.dumps(signed(near)));inputfile.chmod(0o600);pending=subprocess.Popen(['node',str(ROOT/'core/control-plane/dist/bootstrap.js'),'--amend-intent','--input',str(inputfile)],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
   try:
    until=time.monotonic()+5;blocked=False
    while time.monotonic()<until:
     blocked=bool(f.sql("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO hyperfide.identity_bootstrap_capability_approvals%'") )
     if blocked:break
     time.sleep(0.05)
    if not blocked:raise AssertionError('Approval INSERT did not encounter actual PG contention')
    while f.sql('SELECT clock_timestamp()<$1::timestamptz AS before',[near['credential']['expires_at']])[0]['before']:time.sleep(0.05)
   finally:
    locker.stdin.write('release\n');locker.stdin.flush();locker.communicate(timeout=10)
   stdout,stderr=pending.communicate(timeout=20);p=pending;r=json.loads((stdout if p.returncode==0 else stderr).splitlines()[-1])
   if p.returncode!=78 or r.get('error',{}).get('code')!='AUTH_EXPIRED':raise AssertionError('Near-expiry successor not refused '+str(r))
   if f.sql('SELECT count(*)::int n FROM hyperfide.identity_principals WHERE credential_id=$1',[near['credential']['credential_id']])[0]['n']!=0:raise AssertionError('Expired successor escaped rollback')
   after_expiry=f.sql('SELECT r.state_version::text,s.revision_digest,p.state FROM hyperfide.runs r JOIN hyperfide.spec_revisions s ON s.organisation_id=r.organisation_id AND s.id=r.spec_revision_id JOIN hyperfide.identity_principals p ON p.credential_id=$3 WHERE r.organisation_id=$1 AND r.id=$2',[ids['org'],ids['run'],near['previous_credential_id']])[0]
   if after_expiry['state_version']!=now['state_version'] or after_expiry['revision_digest']!=now['revision_digest'] or after_expiry['state']!='ACTIVE':raise AssertionError('Expiry refusal changed accepted state or predecessor authority')
   checks.append('successor-expiry-after-real-pg-delay-rolls-back')
   def online_append(filename):
    current=f.sql('SELECT r.spec_revision_id,r.spec_generation::text,r.state_version::text FROM hyperfide.runs r WHERE organisation_id=$1 AND id=$2',[ids['org'],ids['run']])[0]
    content=next_source.read_text()+'\n[extra.'+filename.replace('.','_')+']\nintent="Reviewed online replan"\n';extra=root/filename;extra.write_text(content);rep=copy.deepcopy(next_replacement);rep['source']={'relative_path':filename,'sha256':hashlib.sha256(extra.read_bytes()).hexdigest(),'size_bytes':str(extra.stat().st_size)}
    request={'run_id':ids['run'],'base_spec_revision_id':current['spec_revision_id'],'base_spec_generation':current['spec_generation'],'state_version':current['state_version'],'purpose':'INTENT_CHANGE','reason':'Explicit online accepted intent history','replacement':rep}
    def invoke(action,value):
     op=f.operation('spec-revisions',action,value,run=ids['run']);status,answer=f.request(op,key='operator',credential=next_approval['credential']['credential_id'])
     if not answer.get('ok'):raise AssertionError('Real online amendment refused '+str(answer))
     return answer['result']
    proposal=invoke('spec.amendment.propose',request);invoke('spec.amendment.admit',{'run_id':ids['run'],'amendment_id':proposal['amendment_id'],'proposal_digest':proposal['proposal_digest'],'revalidate_task_ids':[task['id']],'proof_policies':[],'justification':'Explicit online accepted transition'})
   online_append('online-one.kvx')
   recovery={'schema_version':1,'scope':{'organisation_id':ids['org'],'run_id':ids['run'],'authority_epoch':f.ids['epoch']},'recovery':{'recovery_id':uid(),'previous_credential_id':next_approval['credential']['credential_id'],'reason':'LOST','credential_id':uid(),'actor_id':ids['actor'],'public_key_b64':f.keys['operator']['public_key_b64'],'allowed_actions':target,'expires_at':expiry}}
   p,recovered=call(recovery,'--recover')
   if p.returncode:raise AssertionError('Recovery after online accepted amendment refused '+p.stderr[:1000])
   checks.append('recovery-after-real-online-amendment')
   next_approval['credential']['credential_id']=recovery['recovery']['credential_id'];online_append('online-two.kvx')
   p,replayed=call(recovery,'--recover')
   if p.returncode or replayed['result']['recovery']['accepted_revision_digest']!=recovered['result']['recovery']['accepted_revision_digest']:raise AssertionError('Recovery replay rewrote historical accepted revision')
   checks.append('recovery-replay-retains-historical-revision')


  report={'status':'PASS','checks':checks};(OUT/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return 0
 finally:
  if f:f.close()
if __name__=='__main__':raise SystemExit(main())
