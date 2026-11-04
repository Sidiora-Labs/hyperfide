import assert from 'node:assert/strict';
import {randomUUID,sign} from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';

const inputs=JSON.parse(await fs.readFile(process.env.NATIVE_PROFILE_INPUT,'utf8')),i=inputs.ids;
const root=path.dirname(process.env.SOURCE_CONTROL_MODULE_ROOT),load=name=>import(pathToFileURL(path.join(root,name+'.js')));
const [{createResourceContainer},{AuthorityStore,lookupAuthorityActivation},{FileExternalAuthorityJournal},identityModule,protocol,{validateManifestMetadata}]=await Promise.all([load('storage/runtime'),load('storage/durability'),load('storage/authority_journal'),load('identity/enrollment'),load('transport/protocol'),load('preparation/manifests')]);
const signal=new AbortController().signal,resources=createResourceContainer({role:'control',env:process.env,signal});
const journal=new FileExternalAuthorityJournal(process.env.HYPERFIDE_AUTHORITY_JOURNAL_DIR,value=>lookupAuthorityActivation(resources,value));
const authority=new AuthorityStore(resources,process.env.HYPERFIDE_DEPLOYMENT_ID,journal);
const identity=await identityModule.createComponent({env:process.env,resources,signal,dependencies:{require(name,capability){assert.equal(name,'4.4');assert.equal(capability,'storage.authority.v1');return authority;}}});
const f=await createNativeAcceptanceFixture({migrate:false,scope:{organisation_id:i.organisation,repository_id:i.repository,security_domain_id:randomUUID()},serviceOptions:{transaction:body=>resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},body)}});
const signRequest=async(key,component,action,input,operation=randomUUID())=>{
  const payload=Buffer.from(JSON.stringify({run_id:i.run,component,action,input,expected_version:null,authority:null}));
  const body=Buffer.from(JSON.stringify({protocol_version:1,operation_id:operation,idempotency_key:operation,payload_digest:protocol.hash(payload),correlation_id:operation,causation_id:null,payload_b64:payload.toString('base64url')}));
  const proof={id:i[key],time:String(Math.floor(Date.now()/1000)),nonce:randomUUID()};
  const signature=sign(null,protocol.signingBytes(inputs.origin,'/v1/invoke',proof,body),await fs.readFile(inputs.keys[key])).toString('base64url');
  return {body,headers:{'Content-Type':'application/json','HF-Credential-Id':proof.id,'HF-Request-Time':proof.time,'HF-Request-Nonce':proof.nonce,'HF-Request-Signature':signature}};
};
const call=async(component,action,input)=>{
  const request=await signRequest('operator',component,action,input),ca=await fs.readFile(inputs.ca);
  return new Promise((resolve,reject)=>{const req=https.request(inputs.origin+'/v1/invoke',{method:'POST',ca,headers:request.headers},response=>{const chunks=[];response.on('data',part=>chunks.push(part));response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks))}));});req.on('error',reject);req.end(request.body);});
};
try{
  for(const name of ['leader','operator'])await f.pool.query('INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$5,\'automation\',1,$6,$7,$8,clock_timestamp()+interval \'20 minutes\')',[f.scope.organisation_id,f.scope.repository_id,f.scope.security_domain_id,randomUUID(),i[name],f.sourcePolicy,['source.fleet.bind-run','source.fleet.read','source.revisions.read'],['']]);
  const file=await f.service.objects.putFile(f.scope,Buffer.from('native profile source\n'));
  const tree=await f.service.trees.fromEntries(f.scope,[{name:'main.txt',kind:'file',mode:'100644',object_id:file.object_id}]);
  const revision=await f.createRevision({root_tree_id:tree.root_tree_id,parent_revision_ids:[]});
  const operation=randomUUID(),request={protocol_version:1,scope:f.scope,operation_id:operation,idempotency_key:operation,action:'source.fleet.bind-run',input:{run_id:i.run,revision_id:revision.revision_id,leader_generation:'1'}};
  const signed=await signRequest('leader','source-control',request.action,request,request.operation_id);
  const invocation=await identity.capabilities['identity.authority'].authenticate(signed.body,Object.entries(signed.headers).flat(),signal);
  await f.service.api.invoke(request.action,request,invocation);
  const initial=JSON.parse(await fs.readFile(inputs.config_file,'utf8'));
  const candidate=async(change={})=>{
    const manifest=structuredClone(inputs.manifest),profileId=randomUUID();
    manifest.profile.profile_id=profileId;
    manifest.profile.repositories=[{id:f.scope.repository_id,url:'https://native-source.example.test/api/v1/source-control',commit:revision.revision_id,source_backend:'native',security_domain_id:f.scope.security_domain_id,submodules:[],lfs:false,...change}];
    delete manifest.digest;manifest.digest=f.sourceDigest(manifest);validateManifestMetadata(manifest);
    const config=structuredClone(initial);config.pools[0].profile_id=profileId;config.pools[0].preparation_digest=manifest.digest;
    await fs.writeFile(inputs.config_file,JSON.stringify(config),{mode:0o600});
    return {profile_id:profileId,runtime_platform:'linux-amd64',manifest};
  };
  const valid=await candidate(),first=await call('8.2','provider.profiles.register',valid);
  if(inputs.expect_old){
    assert.equal(first.body.error?.code,'PROFILE_SOURCE_MISMATCH',JSON.stringify(first));
    console.log(JSON.stringify({status:'RED_REPRODUCED',code:first.body.error.code,boundary:'actual signed profile registration against admitted native source'}));
  }else{
    assert.equal(first.body.ok,true,JSON.stringify(first));assert.equal(first.body.result.created,true);
    const replay=await call('8.2','provider.profiles.register',valid);assert.equal(replay.body.result.created,false);
    const before=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.environment_profiles WHERE organisation_id=$1',[i.organisation])).rows[0].n;
    for(const change of [{commit:'sha256:'+'d'.repeat(64)},{security_domain_id:randomUUID()}]){
      const refused=await call('8.2','provider.profiles.register',await candidate(change));
      assert.equal(refused.body.error?.code,'FLEET_SOURCE_MISMATCH',JSON.stringify(refused));
    }
    const after=(await f.pool.query('SELECT count(*)::int AS n FROM hyperfide.environment_profiles WHERE organisation_id=$1',[i.organisation])).rows[0].n;assert.equal(after,before);
    const stored=(await f.pool.query('SELECT manifest FROM hyperfide.environment_profiles WHERE organisation_id=$1 AND id=$2',[i.organisation,valid.profile_id])).rows[0];
    assert.equal(stored.manifest.profile.repositories[0].commit,revision.revision_id);
    assert.equal(stored.manifest.profile.repositories[0].security_domain_id,f.scope.security_domain_id);
    console.log(JSON.stringify({status:'PASS',checks:['native admitted profile registration','exact registration replay','wrong native source rejected without insertion','wrong native security domain rejected without insertion'],boundary:'actual signed HTTPS, PostgreSQL and native source admission',provider_calls:0}));
  }
}finally{await f.close();await resources.close();}
