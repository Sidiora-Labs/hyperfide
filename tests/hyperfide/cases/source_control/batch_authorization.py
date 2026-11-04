#!/usr/bin/env python3
"""Compare direct and batched native identity and role authorization over TLS."""
import importlib.util
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import uuid
ROOT=Path(__file__).resolve().parents[4]
def main():
    if not os.environ.get('DATABASE_URL'):
        return subprocess.run([sys.executable,str(ROOT/'tests/hyperfide/support/withpg.py'),'--',sys.executable,str(Path(__file__).resolve())],cwd=ROOT).returncode
    spec=importlib.util.spec_from_file_location('identity_fixture',ROOT/'tests/hyperfide/support/identity_fixture.py');identity=importlib.util.module_from_spec(spec);spec.loader.exec_module(identity)
    backend=subprocess.Popen(['node','--input-type=module','-e',"import {createSourceS3Fixture} from './tests/hyperfide/cases/source_control/fixtures/objects/backend.mjs';const b=await createSourceS3Fixture();console.log(JSON.stringify(b.config));process.once('SIGTERM',async()=>{await b.close();process.exit(0)});"],cwd=ROOT,stdout=subprocess.PIPE,text=True)
    fixture=None
    try:
        if not select.select([backend.stdout],[],[],15)[0]:raise RuntimeError('Object backend unavailable')
        storage=json.loads(backend.stdout.readline())
        env={'HF_SOURCE_S3_ENDPOINT':storage['endpoint'],'HF_SOURCE_S3_REGION':storage['region'],'HF_SOURCE_S3_BUCKET':storage['bucket'],'HF_SOURCE_S3_ACCESS_KEY_ID':storage['accessKey'],'HF_SOURCE_S3_SECRET_ACCESS_KEY':storage['secretKey'],'HF_SOURCE_ALLOW_LOOPBACK_HTTP':'1','HF_SOURCE_CURSOR_KEY':'c2lnbmVkLXNvdXJjZS10cmFuc3BvcnQtZml4dHVyZS1rZXk','HF_SOURCE_CACHE_BYTES':'16777216','HF_SOURCE_CACHE_ENTRIES':'1024','HF_SOURCE_MAX_FILE_BYTES':'8388608','HF_SOURCE_MATERIALIZED_BYTES':'67108864','HF_SOURCE_DIRTY_BYTES':'16777216'}
        scope={'organisation_id':None,'repository_id':str(uuid.uuid4()),'security_domain_id':str(uuid.uuid4())}
        def setup(f):
            scope['organisation_id']=f.ids['organisation']
            policy=f.path/'batch-policy.json'
            policy.write_text(json.dumps({'schema_version':1,'rules':[{'role':'OPERATOR','actions':[a for a in f.actions if a!='source.trees.entries'],'repositories':[scope['repository_id']],'artifact_prefixes':[],'git_refs':[],'model_destinations':[],'model_profiles':[]}]}));policy.chmod(0o600)
            f.env['HF_AUTHORIZATION_CONFIG_FILE']=str(policy)
            f.sql('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[*scope.values(),'batch-auth-v1'])
            f.sql("INSERT INTO hyperfide.source_repositories(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version,durability_profile) VALUES($1,$2,$3,1,$4,$5)",[*scope.values(),'batch-auth-v1','single-region-verified-s3-v1'])
            f.sql("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$5,'automation',1,$6,$7,ARRAY[''],clock_timestamp()+interval '15 minutes')",[*scope.values(),str(uuid.uuid4()),f.ids['operator'],'batch-auth-v1',['source.queries.batch','source.objects.put','source.objects.inspect','source.revisions.create','source.revisions.read','source.trees.entries']])
        fixture=identity.IdentityFixture(extra_components=['source-control','14.4'],extra_env=env,extra_setup=setup,credential_actions=['source.queries.batch','source.objects.put','source.objects.inspect','source.revisions.create','source.trees.entries'])
        inputs=fixture.path/'batch-input.json';inputs.write_text(json.dumps({'config':{'schema_version':1,'endpoint':fixture.origin+'/api/v1/source-control','scope':scope,'credential_id':fixture.ids['operator'],'ca_file':str(fixture.ca),'key_file':str(fixture.keys['operator']['path'])}}));inputs.chmod(0o600)
        return subprocess.run(['node','--import','tsx',str(ROOT/'tests/hyperfide/support/native_source_batch_authorization.mjs')],cwd=ROOT,env={**fixture.env,'SOURCE_BATCH_AUTH_INPUT':str(inputs)},timeout=120).returncode
    finally:
        if fixture:fixture.close()
        backend.terminate()
        try:backend.wait(timeout=10)
        except subprocess.TimeoutExpired:backend.kill();backend.wait()
if __name__=='__main__':raise SystemExit(main())
