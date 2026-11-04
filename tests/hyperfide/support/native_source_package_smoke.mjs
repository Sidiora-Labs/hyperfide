import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID,randomBytes,generateKeyPairSync,sign} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {createSourceS3Fixture} from '../cases/source_control/fixtures/objects/backend.mjs';
import {createNativeAcceptanceFixture} from './native_source_acceptance_fixture.mjs';
const release=path.resolve(process.env.HF_SOURCE_PACKAGE_ROOT);
const load=name=>import(pathToFileURL(path.join(release,'services/dist',name+'.js')));
const [{createResourceContainer},{MigrationCoordinator},{SourceControlClient},{NativeWorkspaceClient},{NativeObjectCache},{SourceWorkspaceJournal},{SparseSourceMaterializer},{NativeWorkspaceCheckpoint},{createLocalGitDestination}]=await Promise.all([
 load('storage/runtime'),load('storage/durability'),import(pathToFileURL(path.join(release,'sdk/index.js'))),
 ...['client','cache','journal','materializer','checkpoint'].map(name=>import(pathToFileURL(path.join(release,'host',name+'.js')))),load('source_control/git/transport'),
]);
async function startPackagedSource(env){
 const child=spawn(path.join(release,'bin/source-control'),[],{cwd:release,env:{...env,PATH:path.join(release,'bin')+':/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=chunk.toString();});
 const ended=new Promise(resolve=>child.once('close',resolve));
 const address=await new Promise((resolve,reject)=>{
  let pending='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('Packaged service readiness timed out: '+stderr));},30000);
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);reject(Error('Packaged service exited '+code+': '+stderr));});
  child.stdout.on('data',chunk=>{pending+=chunk.toString();for(;;){const end=pending.indexOf('\n');if(end<0)break;const line=pending.slice(0,end);pending=pending.slice(end+1);try{const event=JSON.parse(line);if(event.event==='source-control.ready'){clearTimeout(timer);resolve(event.address);}}catch{}}});
 });
 return {address,async close(){if(child.exitCode!==null)return;child.kill('SIGTERM');let timer;try{await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},10000);})]);}finally{clearTimeout(timer);}}};
}
const request=createRequire(path.join(release,'services/package.json'));
const {Pool}=request('pg');
const db=process.env.DATABASE_URL;
assert(new URL(db).searchParams.get('host')?.startsWith('/tmp/hyperfide/hf-withpg-'),'Owned PostgreSQL required');
const authorityDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'hf-package-authority-')),deployment=randomUUID();
await fs.chmod(authorityDirectory,0o700);
const resources=createResourceContainer({role:'control',env:{...process.env,HYPERFIDE_MIGRATION_DATABASE_URL:db,HYPERFIDE_DEPLOYMENT_ID:deployment,HYPERFIDE_AUTHORITY_JOURNAL_DIR:authorityDirectory},signal:new AbortController().signal});
const legacy=await fs.mkdtemp(path.join(os.tmpdir(),'hf-package-legacy-'));
const seedPool=new Pool({connectionString:db});
try{
 for(const name of await fs.readdir(path.join(release,'services/migrations'))){
  if(/^\d{4}-.*\.sql$/.test(name)&&Number(name.slice(0,4))<736)await fs.copyFile(path.join(release,'services/migrations',name),path.join(legacy,name));
 }
 await new MigrationCoordinator(resources,legacy).apply({timeoutMs:30000});
 const organisation=randomUUID(),project=randomUUID(),repository=randomUUID(),oid='1'.repeat(40);
 await resources.gateway.withPrimaryTransaction({timeoutMs:10000},async tx=>{
  await tx.query('INSERT INTO hyperfide.organisations(id,name) VALUES($1,$2)',[organisation,'Packaged legacy organisation']);
  await tx.query('INSERT INTO hyperfide.projects(organisation_id,id,name) VALUES($1,$2,$3)',[organisation,project,'Packaged legacy project']);
  await tx.query('INSERT INTO hyperfide.repositories(organisation_id,id,project_id,name,url) VALUES($1,$2,$3,$4,$5)',[organisation,repository,project,'legacy','https://example.invalid/legacy.git']);
  await tx.query('INSERT INTO hyperfide.source_objects(organisation_id,repository_id,object_id) VALUES($1,$2,$3)',[organisation,repository,oid]);
 });
 const before=(await seedPool.query('SELECT to_jsonb(s) AS data FROM hyperfide.source_objects s WHERE organisation_id=$1',[organisation])).rows;
 const upgrade=await new MigrationCoordinator(resources).apply({timeoutMs:30000});assert(upgrade.applied.length>0);
 assert.deepEqual((await seedPool.query('SELECT to_jsonb(s) AS data FROM hyperfide.source_objects s WHERE organisation_id=$1',[organisation])).rows,before);
 assert.equal((await new MigrationCoordinator(resources).apply({timeoutMs:30000})).applied.length,0);
 const [{AuthorityStore,lookupAuthorityActivation,assertExternalAuthorityCurrent},{FileExternalAuthorityJournal},{hash}]=await Promise.all([load('storage/durability'),load('storage/authority_journal'),load('transport/protocol')]);
 const identity=(await seedPool.query('SELECT current_database() AS database_name,(pg_control_system()).system_identifier::text AS system_identifier,pg_postmaster_start_time()::text AS postmaster,pg_is_in_recovery() AS recovery')).rows[0];
 assert.equal(identity.recovery,false);
 assert.equal(Number((await seedPool.query('SELECT count(*) AS n FROM hyperfide.authority_epochs WHERE deployment_id=$1',[deployment])).rows[0].n),0);
 assert.equal((await fs.readdir(authorityDirectory)).length,0);
 const journal=new FileExternalAuthorityJournal(authorityDirectory,input=>lookupAuthorityActivation(resources,input));
 await new AuthorityStore(resources,deployment,journal).activate({operation_id:randomUUID(),expected_previous_epoch:null},{isolate:async input=>{
  assert.equal(input.deployment_id,deployment);assert.equal(input.source_epoch,null);
  const now=Date.now(),receipt={deployment_id:deployment,operation_id:input.operation_id,source_epoch:null,fence_id:randomUUID(),isolated_writer:'owned-package-database:'+identity.system_identifier+':'+identity.postmaster,observed_at:new Date(now).toISOString(),expires_at:new Date(now+25000).toISOString(),evidence_digest:hash(JSON.stringify({kind:'OWNED_FRESH_PACKAGE_DATABASE',identity}))};
  await fs.writeFile(path.join(authorityDirectory,'package-writer-observation.json'),JSON.stringify(receipt),{mode:0o600});return receipt;
 }});
 await assertExternalAuthorityCurrent(resources,journal,{deployment_id:deployment});
}finally{await seedPool.end();await resources.close();await fs.rm(legacy,{recursive:true,force:true});}
const pool=new Pool({connectionString:db}),backend=await createSourceS3Fixture(),temporary=await fs.mkdtemp(path.join(os.tmpdir(),'hf-packaged-source-'));
let server,acceptedFixture;
try{
 const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()};
 const principal=randomUUID(),credential=randomUUID(),capability=randomUUID();
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const actions=['source.capabilities','source.objects.put','source.objects.read','source.trees.patch','source.trees.entries','source.trees.lookup','source.revisions.create','source.revisions.read','source.workspaces.open','source.workspaces.detail','source.workspaces.checkpoint','source.operations.read'];
 await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(scope),'package-v1']);
 await pool.query('INSERT INTO hyperfide.source_repositories(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version,durability_profile) VALUES($1,$2,$3,1,$4,$5)',[...Object.values(scope),'package-v1','single-region-verified-s3-v1']);
 await pool.query("INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'automation',1,'package','package','key',clock_timestamp()+interval '15 minutes')",[...Object.values(scope),credential,principal]);
 await pool.query("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,'package-v1',$7,ARRAY[''],clock_timestamp()+interval '15 minutes')",[...Object.values(scope),capability,principal,credential,actions]);
 const configuration=path.join(temporary,'listener.json');
 await fs.writeFile(configuration,JSON.stringify({host:'127.0.0.1',port:0,allowLoopbackHTTP:true,trust:{issuer:'package',audience:'package',keys:{key:publicKey.export({format:'pem',type:'spki'}).toString()}}}),{mode:0o600});
 const env={DATABASE_URL:db,HYPERFIDE_DEPLOYMENT_ID:deployment,HYPERFIDE_AUTHORITY_JOURNAL_DIR:authorityDirectory,HF_SOURCE_CONTROL_CONFIG:configuration,HF_SOURCE_S3_ENDPOINT:backend.config.endpoint,HF_SOURCE_S3_REGION:backend.config.region,HF_SOURCE_S3_BUCKET:backend.config.bucket,HF_SOURCE_S3_ACCESS_KEY_ID:backend.config.accessKey,HF_SOURCE_S3_SECRET_ACCESS_KEY:backend.config.secretKey,HF_SOURCE_ALLOW_LOOPBACK_HTTP:'1',HF_SOURCE_CURSOR_KEY:randomBytes(32).toString('base64url'),HF_SOURCE_CACHE_BYTES:'16777216',HF_SOURCE_CACHE_ENTRIES:'1024',HF_SOURCE_MAX_FILE_BYTES:'8388608',HF_SOURCE_MATERIALIZED_BYTES:'33554432',HF_SOURCE_DIRTY_BYTES:'8388608'};
 server=await startPackagedSource(env);
 const header=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'key',typ:'HF-SOURCE-1'})).toString('base64url'),now=Math.floor(Date.now()/1000);
 const payload=Buffer.from(JSON.stringify({schema_version:1,iss:'package',aud:'package',sub:principal,credential_id:credential,credential_version:'1',principal_kind:'automation',scope,iat:now,nbf:now,exp:now+290,capability_id:capability})).toString('base64url');
 const token=header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),privateKey).toString('base64url');
 const sdk=new SourceControlClient({endpoint:server.address+'/api/v1/source-control',scope,token});
 assert((await sdk.capabilities()).protocol_versions.includes(1));
 const client=new NativeWorkspaceClient({call:(action,input,options)=>sdk.call(action,input,options)},scope);
 const file=await client.putFile(Buffer.from('packaged source\n'));
 const empty=await sdk.call('source.objects.put',{kind:'tree-leaf',payload_base64:Buffer.from('[1,"",[]]').toString('base64')});
 const tree=await sdk.call('source.trees.patch',{tree_id:empty.object_id,patches:[{path:'main.txt',operation:'put',kind:'file',mode:'100644',object_id:file}]});
 const revisionOperation=randomUUID();
 const revision=await sdk.call('source.revisions.create',{change_id:randomUUID(),root_tree_id:tree.root_tree_id,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Packaged smoke',email:'package@example.invalid'},message:'Package source',timestamp:new Date().toISOString()}},{operation_id:revisionOperation,idempotency_key:revisionOperation});
 const apiOnly=await client.open({base_revision_id:revision.revision_id,mode:'API_ONLY',read_paths:['main.txt'],write_paths:[]});
 assert.equal(apiOnly.mode,'API_ONLY');
 const workspace=await client.open({base_revision_id:revision.revision_id,mode:'SPARSE',read_paths:['main.txt'],write_paths:['main.txt']});
 const local=path.join(temporary,'workspace'),journal=new SourceWorkspaceJournal(path.join(temporary,'journal')),cache=new NativeObjectCache(path.join(temporary,'cache'),{max_bytes:8388608,max_entries:128,max_object_bytes:8388608});
 const materializer=new SparseSourceMaterializer(client,cache,journal,local);
 assert.equal((await materializer.materialize(workspace,['main.txt'])).state,'READY');
 assert.equal(await fs.readFile(path.join(local,'main.txt'),'utf8'),'packaged source\n');
 await fs.writeFile(path.join(local,'main.txt'),'packaged changed\n');await journal.mark('main.txt');
 const checkpoint=await new NativeWorkspaceCheckpoint(client,journal,local,materializer).checkpoint(workspace);
 assert.notEqual(checkpoint.revision_id,revision.revision_id);
 assert.equal((await sdk.revision(checkpoint.revision_id)).revision_id,checkpoint.revision_id);
 assert(execFileSync(path.join(release,'bin/hyperfide'),['source','--help'],{encoding:'utf8'}).includes('source invoke'));
 assert(execFileSync(path.join(release,'bin/hyperfide-native'),['--component','26.1','--action','branding.identity.describe'],{input:'{}',encoding:'utf8'}).includes('Hyperfide'));
 const acceptanceScope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},remote=path.join(temporary,'remote.git');
 execFileSync(path.join(release,'bin/git'),['init','--bare',remote],{stdio:'ignore'});
 const destination=createLocalGitDestination({scope:acceptanceScope,id:'package-remote',repository_identity:'owned-package-remote',path:remote,allowed_refs:['refs/heads/main']});
 const {SOURCE_ACTIONS}=await load('source_control/contracts');
 const acceptanceActions=SOURCE_ACTIONS.filter(action=>['source.objects.','source.trees.','source.revisions.','source.operations.','source.domains.','source.candidates.','source.acceptance.','source.assurance.','source.publications.'].some(prefix=>action.startsWith(prefix)));
 acceptedFixture=await createNativeAcceptanceFixture({actions:acceptanceActions,moduleRoot:path.join(release,'services/dist/source_control'),sdkRoot:path.join(release,'sdk'),pool,migrate:false,scope:acceptanceScope,serviceOptions:{publication:{destinations:[destination]}}});
 const candidateRevision=await acceptedFixture.createRevision({text:'candidate: packaged acceptance\n',parent_revision_ids:[]}),candidate=await acceptedFixture.createCandidate(candidateRevision,{domain:await acceptedFixture.createDomain(candidateRevision)}),qualified=await acceptedFixture.qualify(candidate),accepted=await acceptedFixture.accept(candidate,qualified);
 const publicationOperation=randomUUID();
 const publication=await acceptedFixture.client.createPublication({acceptance_id:accepted.acceptance_id,destination_id:'package-remote',target_ref:'refs/heads/main',expected_old_oid:null},{operation_id:publicationOperation,idempotency_key:publicationOperation});
 const published=await acceptedFixture.client.resumePublication(publication.operation_id);
 assert.equal(published.status,'PUBLISHED');
 assert.equal((await acceptedFixture.client.publication(publication.operation_id)).status,'PUBLISHED');
 const readback=execFileSync(path.join(release,'bin/git'),['--git-dir',remote,'show','refs/heads/main:main.txt'],{encoding:'utf8'});
 assert.equal(readback,'candidate: packaged acceptance\n');
 console.log(JSON.stringify({status:'PASS',profile:'owned PostgreSQL and SigV4 object backend; extracted packaged service/SDK/host/native/CLI',checks:['packaged migration upgrades preserve legacy Git source rows and replay once','packaged service migration and startup','API-only source client','sparse materialization and durable checkpoint','packaged native CLI and component dispatch','independent candidate qualification and acceptance','Git publication status and independent content readback'],backend_requests:backend.requests.length+acceptedFixture.backend.requests.length}));
}finally{await acceptedFixture?.close();await server?.close();await backend.close();await pool.end();await fs.rm(temporary,{recursive:true,force:true});await fs.rm(authorityDirectory,{recursive:true,force:true});}
