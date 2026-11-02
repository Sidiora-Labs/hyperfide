#!/usr/bin/env python3
"""Source authorization, taskless authentication and pinned transfer grants on owned PostgreSQL."""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[4]
PROGRAM = r'''
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire,stripTypeScriptTypes} from 'node:module';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.argv[1],out=path.join(root,'build/source-control/1.3'),runtime=path.join(out,'runtime');
const dsn=new URL(process.env.DATABASE_URL);assert.ok(dsn.searchParams.get('host')?.startsWith('/tmp/hyperfide/hf-withpg-'),'owned PostgreSQL required');
const require=createRequire(path.join(root,'core/control-plane/package.json')),pg=require('pg');
await mkdir(runtime,{recursive:true});await writeFile(path.join(runtime,'package.json'),'{"type":"module"}\n');
for(const name of ['source_control/contracts','source_control/capabilities','source_control/authentication','source_control/transfer_grants','source_control/audit','source_control/object_catalog','transport/protocol','policy/programme']){
 const source=await readFile(path.join(root,'core/control-plane/src',name+'.ts'),'utf8');
 const emitted=stripTypeScriptTypes(source,{mode:'transform'});
 const target=path.join(runtime,name+'.js');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,emitted);
}
const load=name=>import(pathToFileURL(path.join(runtime,'source_control',name+'.js')));
const auth=await load('authentication'),caps=await load('capabilities'),transfers=await load('transfer_grants'),audit=await load('audit'),storage=await load('object_catalog');
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
const checks=[];async function check(name,body){await body();checks.push(name);}
async function tx(body){await client.query('BEGIN');try{const value=await body(client);await client.query('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}}
async function refused(code,body){await assert.rejects(body,e=>e.code===code);}
function rejected(code,body){assert.throws(body,e=>e.code===code);}
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},other={...scope,security_domain_id:randomUUID()};
const principalId=randomUUID(),credentialId=randomUUID(),capabilityId=randomUUID(),objectId='sha256:'+createHash('sha256').update('independent protected object fixture').digest('hex'),incarnation=randomUUID();
const pair=generateKeyPairSync('ed25519'),trust={issuer:'https://source-issuer.invalid',audience:'hyperfide-source',keys:{test:pair.publicKey},max_ttl_seconds:300};
const second=Math.floor(Date.now()/1000),claims={schema_version:1,iss:trust.issuer,aud:trust.audience,sub:principalId,credential_id:credentialId,credential_version:'1',principal_kind:'automation',scope,iat:second,nbf:second,exp:second+300,capability_id:capabilityId};
function token(payload=claims,header={alg:'EdDSA',kid:'test',typ:'HF-SOURCE-1'}){const a=Buffer.from(JSON.stringify(header)).toString('base64url'),b=Buffer.from(JSON.stringify(payload)).toString('base64url');return a+'.'+b+'.'+sign(null,Buffer.from(a+'.'+b),pair.privateKey).toString('base64url');}
const principal=auth.verifySourcePrincipalToken(token(),trust,scope);
const expiration=new Date(Date.now()+240000).toISOString();
const config={key_id:'transfer-1',signing_key:Buffer.alloc(32,0x42),endpoint:'https://source.invalid/transfers',allowed_endpoints:['https://source.invalid'],maximum_lifetime_seconds:120};
let authorized,issued;
try{
 await client.query('CREATE SCHEMA hyperfide');
 for(const file of ['0736-source-control-storage.sql','0738-source-control-capabilities.sql'])await client.query(await readFile(path.join(root,'core/control-plane/migrations',file),'utf8'));
 await client.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,\'source-v1\')',[scope.organisation_id,scope.repository_id,scope.security_domain_id]);
 await client.query('INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,\'automation\',1,$6,$7,\'test\',$8)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,credentialId,principalId,trust.issuer,trust.audience,expiration]);
 await client.query('INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,\'automation\',1,\'source-v1\',$7,$8,$9)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,capabilityId,principalId,credentialId,['source.objects.read','source.objects.put','source.queries.diff','source.audit.read'],[''],expiration]);
 await client.query('INSERT INTO hyperfide.source_native_objects(organisation_id,repository_id,security_domain_id,object_id,kind,size_bytes,state,current_incarnation) VALUES($1,$2,$3,$4,\'blob\',0,\'VERIFIED\',$5)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,objectId,incarnation]);
 await client.query('INSERT INTO hyperfide.source_object_placements(organisation_id,repository_id,security_domain_id,object_id,incarnation_id,generation,storage_key,state) VALUES($1,$2,$3,$4,$5,1,\'owned-fixture/source-object\',\'VERIFIED\')',[scope.organisation_id,scope.repository_id,scope.security_domain_id,objectId,incarnation]);
 await check('signed-taskless-principal-uses-current-server-credential-without-run',async()=>{authorized=await tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,mutation:false}));assert.equal(authorized.principal_id,principalId);assert.equal(authorized.authority_epoch,'1');assert.equal(authorized.workspace,undefined);});
 await check('signature-algorithm-issuer-audience-scope-and-expiry-boundaries',async()=>{
  for(const payload of [{...claims,iss:'https://other.invalid'},{...claims,aud:'other'},{...claims,exp:second},{...claims,exp:second+901},{...claims,nbf:second+60},{...claims,credential_version:'9999999999999999999'}])rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(payload),trust,scope));
  rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(claims,{alg:'HS256',kid:'test',typ:'HF-SOURCE-1'}),trust,scope));
  rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(token(),trust,other));
  const wire=token(),parts=wire.split('.');parts[1]=Buffer.from(JSON.stringify({...claims,sub:randomUUID()})).toString('base64url');rejected('UNAUTHENTICATED',()=>auth.verifySourcePrincipalToken(parts.join('.'),trust,scope));
 });
 await check('cross-domain-object-guesses-produce-the-same-authorization-refusal',async()=>{for(const object_id of [objectId,'sha256:'+'0'.repeat(64)])await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope:other,action:'source.objects.read',object_id,mutation:false})));});
 await check('read-transfer-retains-exact-incarnation-through-grant-expiry',async()=>{
  issued=await tx(db=>transfers.issueSourceTransferGrant(db,authorized,{object_id:objectId,incarnation_id:incarnation,method:'GET',expires_at:new Date(Date.now()+60000).toISOString()},config));
  const pins=(await client.query('SELECT object_id,incarnation_id,expires_at FROM hyperfide.source_object_pins WHERE owner_kind=\'READ\' AND owner_id=$1',[issued.grant.grant_id])).rows;
  assert.equal(pins.length,1);assert.equal(pins[0].object_id,objectId);assert.equal(pins[0].incarnation_id,incarnation);assert.ok(new Date(pins[0].expires_at).getTime()>=Date.parse(issued.grant.expires_at));await tx(db=>transfers.assertSourceTransferRetained(db,issued.grant));
 });
 const request={scope,method:'GET',object_id:objectId,incarnation_id:incarnation,storage_key:'owned-fixture/source-object',url:issued.url};
 await check('transfer-signature-binds-method-key-object-domain-incarnation-and-endpoint',async()=>{
  assert.equal(transfers.verifySourceTransferGrant(issued.token,config,request).grant_id,issued.grant.grant_id);
  for(const changed of [{method:'PUT'},{storage_key:'other/key'},{object_id:'sha256:'+'1'.repeat(64)},{incarnation_id:randomUUID()},{scope:other},{url:'https://evil.invalid/transfers/'+issued.grant.grant_id}])rejected('INVALID_TRANSFER_GRANT',()=>transfers.verifySourceTransferGrant(issued.token,config,{...request,...changed}));
  rejected('INVALID_TRANSFER_GRANT',()=>transfers.verifySourceTransferGrant(issued.token,config,request,Date.parse(issued.grant.expires_at)));
  rejected('CONFIGURATION_INVALID',()=>transfers.verifySourceTransferGrant(issued.token,{...config,endpoint:'http://source.invalid/transfers'},request));
 });
 await check('put-transfers-require-authenticated-upload-owner-and-open-placement',async()=>{
  const catalog=new storage.PostgresSourceObjectCatalog({transaction:tx}),uploadObject='sha256:'+createHash('sha256').update('upload ownership fixture').digest('hex');
  const owned=await catalog.begin(scope,{operation_id:randomUUID(),object_id:uploadObject,kind:'blob',size_bytes:'0',owner_principal_id:principalId});
  const foreign=await catalog.begin(scope,{operation_id:randomUUID(),object_id:uploadObject,kind:'blob',size_bytes:'0',owner_principal_id:randomUUID()});
  const input={object_id:uploadObject,incarnation_id:owned.incarnation_id,method:'PUT',expires_at:new Date(Date.now()+60000).toISOString()};
  await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.issueSourceTransferGrant(db,authorized,{...input,upload_id:foreign.upload_id},config)));
  const put=await tx(db=>transfers.issueSourceTransferGrant(db,authorized,{...input,upload_id:owned.upload_id},config));await tx(db=>transfers.assertSourceTransferRetained(db,put.grant));
  await client.query('UPDATE hyperfide.source_object_uploads SET status=\'VERIFIED\' WHERE upload_id=$1',[owned.upload_id]);
  await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.assertSourceTransferRetained(db,put.grant)));
 });
 await check('revocation-rejects-warm-cache-and-new-grants-with-bounded-issued-grant-residual',async()=>{
  const cache=new Map([[objectId,Buffer.from('known bytes')]]);assert.ok(cache.has(objectId));await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=clock_timestamp() WHERE id=$1',[capabilityId]);
  await refused('SCOPE_DENIED',()=>tx(db=>authorized.assertCurrent(db)));
  await refused('SCOPE_DENIED',()=>tx(db=>transfers.issueSourceTransferGrant(db,authorized,{object_id:objectId,incarnation_id:incarnation,method:'GET',expires_at:new Date(Date.now()+30000).toISOString()},config)));
  assert.equal(transfers.verifySourceTransferGrant(issued.token,config,request).grant_id,issued.grant.grant_id);await tx(db=>transfers.assertSourceTransferRetained(db,issued.grant));
  await client.query('UPDATE hyperfide.source_capabilities SET revoked_at=NULL WHERE id=$1',[capabilityId]);
 });
 await check('scoped-prefixes-cannot-authorize-guessed-objects-with-client-path-claims',async()=>{
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['src']]);
  await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,paths:['src/a.ts'],mutation:false})));
  await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.queries.diff',paths:['private/a.ts'],mutation:false})));
  const allowed=await tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.queries.diff',paths:['src/a.ts'],mutation:false}));assert.deepEqual(allowed.path_prefixes,['src']);
  await client.query('UPDATE hyperfide.source_capabilities SET path_prefixes=$2 WHERE id=$1',[capabilityId,['']]);
 });
 await check('signed-capability-selection-cannot-be-changed-by-request',async()=>{await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal,scope,action:'source.objects.read',object_id:objectId,mutation:false,capability_id:randomUUID()})));});
 await check('worker-mutation-flag-cannot-bypass-managed-generation-fences',async()=>{
  const workerCapability=randomUUID(),binding={workspace_id:randomUUID(),generation:'4',task_id:randomUUID(),attempt_id:randomUUID(),attempt_generation:'7'};
  await client.query('UPDATE hyperfide.source_principal_credentials SET principal_kind=\'worker\' WHERE credential_id=$1',[credentialId]);
  await client.query('INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,managed_binding,expires_at) VALUES($1,$2,$3,$4,$5,$6,\'worker\',1,\'source-v1\',$7,$8,$9,$10)',[scope.organisation_id,scope.repository_id,scope.security_domain_id,workerCapability,principalId,credentialId,['source.objects.put'],[''],binding,expiration]);
  const worker=auth.verifySourcePrincipalToken(token({...claims,principal_kind:'worker',capability_id:workerCapability}),trust,scope);
  const authority={authority_epoch:'1',policy_version:'source-v1',generation:'4',workspace:{workspace_id:binding.workspace_id,workspace_generation:'4'},managed:{task_id:binding.task_id,attempt_id:binding.attempt_id,attempt_generation:'7'}};
  for(const input of [{},{authority:{...authority,managed:{...authority.managed,attempt_generation:'6'}}},{authority}])await refused('SCOPE_DENIED',()=>tx(db=>caps.authorizeSource(db,{principal:worker,scope,action:'source.objects.put',mutation:false,...input})));
  await client.query('UPDATE hyperfide.source_principal_credentials SET principal_kind=\'automation\' WHERE credential_id=$1',[credentialId]);
 });
 await check('server-policy-epoch-change-fences-previous-capability',async()=>{await client.query('UPDATE hyperfide.source_authority_domains SET authority_epoch=2');await refused('SCOPE_DENIED',()=>tx(db=>authorized.assertCurrent(db)));await client.query('UPDATE hyperfide.source_authority_domains SET authority_epoch=1');});
 await check('credential-revocation-is-checked-after-cryptographic-authentication',async()=>{await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=clock_timestamp()');const authenticated=auth.verifySourcePrincipalToken(token(),trust,scope);await refused('UNAUTHENTICATED',()=>tx(db=>caps.authorizeSource(db,{principal:authenticated,scope,action:'source.objects.read',mutation:false})));await client.query('UPDATE hyperfide.source_principal_credentials SET revoked_at=NULL');});
 await check('audit-records-allowlist-fields-and-remain-immutable',async()=>{
  const record=audit.sourceAuditRecord(authorized,{action:'source.objects.read',operation_id:randomUUID(),request_digest:'sha256:'+'2'.repeat(64),result:'SUCCEEDED',source_ids:[objectId],secret:'must-not-enter-audit'});
  assert.ok(!JSON.stringify(record).includes('must-not-enter-audit'));await tx(db=>audit.appendSourceAudit(db,record));const rows=await tx(db=>audit.readSourceAudit(db,authorized));assert.equal(rows.length,1);assert.equal(rows[0].id,record.id);
  await refused('INVALID_AUDIT_RECORD',()=>tx(db=>audit.appendSourceAudit(db,{...record,id:randomUUID(),transfer_token:'private'})));
  await assert.rejects(()=>client.query('UPDATE hyperfide.source_audit SET record=\'{}\''),e=>e.code==='23514');
 });
 await check('missing-retention-pin-refuses-transfer-despite-valid-signature',async()=>{await client.query('DELETE FROM hyperfide.source_object_pins WHERE owner_id=$1',[issued.grant.grant_id]);await refused('INVALID_TRANSFER_GRANT',()=>tx(db=>transfers.assertSourceTransferRetained(db,issued.grant)));});
 const receipt={schema_version:1,task:'1.3',status:'PASS',backend:'owned-postgresql',assertions:checks,scope:'Authentication, authorization and retained transfer grant component paths; no S3 network result claimed'};await writeFile(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt));
}finally{await client.end();}
'''


def main():
    node = '/root/.nvm/versions/node/v24.22.0/bin/node'
    if not Path(node).is_file():
        node = 'node'
    env = dict(os.environ)
    env.pop('DATABASE_URL', None)
    return subprocess.run([sys.executable, str(ROOT / 'tests/hyperfide/support/withpg.py'), '--', node, '--input-type=module', '-e', PROGRAM, str(ROOT)], cwd=ROOT, env=env).returncode


if __name__ == '__main__':
    sys.exit(main())
