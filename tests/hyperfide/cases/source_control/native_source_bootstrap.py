#!/usr/bin/env python3
"""Protected native scope issuance through the real signed bootstrap producer."""
import copy, datetime, hashlib, json, os, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[4]
sys.path.insert(0,str(ROOT/'tests/hyperfide/support'))
from identity_fixture import IdentityFixture,uid,sha
from fleet_prerequisite_fixture import component_closure

def main():
 if not os.environ.get('DATABASE_URL'):
  return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
 f=None;checks=[]
 try:
  with tempfile.TemporaryDirectory(prefix='hf-native-bootstrap-') as directory:
   root=Path(directory);source=root/'intent.kvx';exe=str(Path(sys.executable).resolve());check={'argv':[exe,'-c','print(42)'],'executable_digest':sha(Path(exe).read_bytes()),'timeout_ms':600000,'required_artifacts':['proof.json'],'input_keys':['source']}
   source.write_text('[meta]\nslug="native-bootstrap"\n[req.1]\nac_1="Native source authority"\n[acceptance.1]\nreq="1.1"\nchecks=["actual-check"]\n[task.1]\nwave=1\nreqs=["1.1"]\nacceptance_ids=["1"]\nverify_cmd="printf source"\nartifacts=["proof.json"]\n[proof]\nrubric_digest='+json.dumps(sha(b'rubric'))+'\n[proof.check.actual-check]\n'+''.join(k+'='+json.dumps(v)+'\n' for k,v in check.items()))
   f=IdentityFixture(extra_components=component_closure(['spec-revisions']),extra_env={'HF_SPEC_ALLOWED_ROOT':directory})
   ids={k:uid() for k in ['org','project','repo','run','credential','actor','domain']}
   actions=['source.capabilities','source.capabilities.manage','source.objects.put','source.objects.read','source.revisions.create','source.revisions.read']
   expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=15)).isoformat(timespec='milliseconds').replace('+00:00','Z')
   oid=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
   scope={'organisation_id':ids['org'],'project_id':ids['project'],'run_id':ids['run'],'authority_epoch':f.ids['epoch'],'allowed_actions':actions}
   accepted={'run_id':ids['run'],'source':{'relative_path':source.name,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'size_bytes':str(source.stat().st_size)},'repositories':[{'repository_id':ids['repo'],'source_object_id':oid,'integration_ref':'refs/heads/native'}],'allowed_actions':actions,'closure_policy':{'required_evidence':['actual-check'],'required_review_roles':['VERIFIER'],'publication':'AFTER_QUALIFICATION'},'provenance':None}
   initial={'schema_version':1,'scope':scope,'metadata':{'organisation':{'id':ids['org'],'name':'native-bootstrap'},'project':{'id':ids['project'],'name':'native-bootstrap'},'repositories':[{'id':ids['repo'],'name':'native-bootstrap','url':'https://example.invalid/native.git','object_format':'sha1','checkout_root':str(ROOT),'source_objects':[{'object_id':oid,'object_type':'commit'}]}]},'accepted_intent':accepted,'credential':{'credential_id':ids['credential'],'actor_id':ids['actor'],'public_key_b64':f.keys['operator']['public_key_b64'],'allowed_actions':actions,'expires_at':expiry}}
   env=dict(f.env,HYPERFIDE_MODE='distributed',HYPERFIDE_BOOTSTRAP_SOURCE_ROOT=str(root),HYPERFIDE_BOOTSTRAP_MAX_TTL_MS='3600000');inputfile=root/'input.json'
   def call(body,mode=None):
    inputfile.write_text(json.dumps(body));inputfile.chmod(0o600)
    p=subprocess.run(['node',str(ROOT/'core/control-plane/dist/bootstrap.js'),*([mode] if mode else []),'--input',str(inputfile)],cwd=ROOT,env=env,capture_output=True,text=True,timeout=50)
    lines=(p.stdout if p.returncode==0 else p.stderr).splitlines();return p,json.loads(lines[-1]) if lines else {}
   p,issued=call(initial)
   if p.returncode:raise AssertionError('Accepted intent bootstrap failed: '+p.stderr[:1200])
   revision=issued['result']['accepted_intent']['revision_digest']
   cap_expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=5)).isoformat(timespec='milliseconds').replace('+00:00','Z')
   approval={'kind':'NATIVE_SOURCE_BOOTSTRAP_V1','approval_id':uid(),'scope':{'organisation_id':ids['org'],'repository_id':ids['repo'],'security_domain_id':ids['domain']},'run_id':ids['run'],'authority_epoch':f.ids['epoch'],'credential_id':ids['credential'],'accepted_revision_digest':revision,'policy_version':'native-bootstrap-v1','durability_profile':'single-region-verified-s3-v1','actions':actions,'path_prefixes':[''],'expires_at':cap_expiry}
   current_key='operator'
   def signed(a,key=None):return {'schema_version':1,'approval':a,'signature_b64':f.sign(key or current_key,json.dumps(a,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode())}
   def refusal(label,a,code,key=None,mode='--source-scope'):
    p,r=call(signed(a,key),mode)
    if p.returncode!=78 or r.get('error',{}).get('code')!=code:raise AssertionError(label+': '+str(r))
    checks.append(label)
   refusal('wrong-operator-signature',approval,'AUTH_SIGNATURE_INVALID','provisioner')
   wrong=copy.deepcopy(approval);wrong['scope']['repository_id']=uid();refusal('repository-outside-accepted-intent',wrong,'AUTH_SCOPE_DENIED')
   excess=copy.deepcopy(approval);excess['actions'].append('source.graph.query');refusal('capability-outside-accepted-ceiling',excess,'AUTH_SCOPE_DENIED')
   expired=copy.deepcopy(approval);expired['expires_at']='2000-01-01T00:00:00.000Z';refusal('expired-source-capability',expired,'AUTH_EXPIRED')
   p,result=call(signed(approval),'--source-scope')
   if p.returncode:raise AssertionError('Initial native scope failed: '+p.stderr[:1500])
   checks.append('actual-native-scope-and-capability-issuance')
   p,replay=call(signed(approval),'--source-scope')
   if p.returncode or not replay['result']['replayed']:raise AssertionError('Exact native bootstrap replay failed: '+str(replay))
   checks.append('exact-signed-approval-replays-without-new-capability')
   changed=copy.deepcopy(approval);changed['path_prefixes']=['src'];refusal('existing-scope-cannot-be-widened-or-replaced',changed,'BOOTSTRAP_SOURCE_CONFLICT')
   rows=f.sql('SELECT actions,path_prefixes,credential_id::text FROM hyperfide.source_capabilities WHERE id=$1',[approval['approval_id']])
   if len(rows)!=1 or rows[0]['actions']!=actions or rows[0]['path_prefixes']!=[''] or rows[0]['credential_id']!=ids['credential']:raise AssertionError('Exact capability binding differs')
   checks.append('one-capability-retains-exact-operator-actions-and-paths')
   successor=uid();recovery={'schema_version':1,'scope':{'organisation_id':ids['org'],'run_id':ids['run'],'authority_epoch':f.ids['epoch']},'recovery':{'recovery_id':uid(),'previous_credential_id':ids['credential'],'reason':'LOST','credential_id':successor,'actor_id':ids['actor'],'public_key_b64':f.keys['provisioner']['public_key_b64'],'allowed_actions':actions,'expires_at':expiry}}
   p,recovered=call(recovery,'--recover')
   if p.returncode:raise AssertionError('Actual operator recovery failed: '+str(recovered))
   current_key='provisioner'
   renewal={k:copy.deepcopy(approval[k]) for k in ['scope','run_id','authority_epoch','credential_id','accepted_revision_digest','actions','path_prefixes']}
   renewal.update(kind='NATIVE_SOURCE_CAPABILITY_V1',approval_id=uid(),credential_id=successor,capability_id=approval['approval_id'],action='RENEW',expected_expires_at=cap_expiry,expires_at=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(minutes=10)).isoformat(timespec='milliseconds').replace('+00:00','Z'))
   mismatch=copy.deepcopy(renewal);mismatch['path_prefixes']=['src'];refusal('renewal-cannot-change-path-grant',mismatch,'AUTH_SCOPE_DENIED',mode='--source-capability')
   outside=copy.deepcopy(renewal);outside['expires_at']=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(hours=2)).isoformat(timespec='milliseconds').replace('+00:00','Z');refusal('renewal-cannot-outlive-native-operator',outside,'AUTH_EXPIRED',mode='--source-capability')
   p,renewed=call(signed(renewal),'--source-capability')
   if p.returncode or renewed['result']['expires_at']!=renewal['expires_at']:raise AssertionError('Exact source renewal failed: '+str(renewed))
   p,renewed_replay=call(signed(renewal),'--source-capability')
   if p.returncode or not renewed_replay['result']['replayed']:raise AssertionError('Source renewal replay failed')
   owner=f.sql('SELECT credential_id::text,principal_id::text FROM hyperfide.source_capabilities WHERE id=$1',[approval['approval_id']])[0]
   if owner['credential_id']!=successor or owner['principal_id']!=ids['actor']:raise AssertionError('Recovered operator renewal changed logical ownership')
   checks.append('recovered-operator-renews-same-logical-source-owner-and-replays')
   stale=copy.deepcopy(renewal);stale['approval_id']=uid();refusal('stale-source-expiry-refused',stale,'BOOTSTRAP_SOURCE_CONFLICT',mode='--source-capability')
   revoke=copy.deepcopy(renewal);revoke.update(approval_id=uid(),action='REVOKE',expected_expires_at=renewal['expires_at'],expires_at=None)
   p,revoked=call(signed(revoke),'--source-capability')
   if p.returncode or revoked['result']['action']!='REVOKE':raise AssertionError('Source revocation failed: '+str(revoked))
   p,revoke_replay=call(signed(revoke),'--source-capability')
   if p.returncode or not revoke_replay['result']['replayed']:raise AssertionError('Source revocation replay failed')
   checks.append('source-revocation-and-immutable-replay')
   revive=copy.deepcopy(renewal);revive.update(approval_id=uid(),expected_expires_at=renewal['expires_at'],expires_at=expiry);refusal('revoked-source-capability-cannot-be-reactivated',revive,'AUTH_REVOKED',mode='--source-capability')
   f.sql("UPDATE hyperfide.identity_principals SET expires_at=clock_timestamp()-interval '1 second' WHERE credential_id=$1",[successor])
   refusal('expired-operator-cannot-replay-source-renewal',renewal,'AUTH_EXPIRED',mode='--source-capability')
   report={'status':'PASS','scope':'actual accepted-intent and protected signed native bootstrap, PostgreSQL and external epoch journal','checks':checks}
   output=ROOT/'build/source-control/native-bootstrap';output.mkdir(parents=True,exist_ok=True);(output/'receipt.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));return 0
 finally:
  if f:f.close()
if __name__=='__main__':raise SystemExit(main())
