import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
const input=JSON.parse(await new Promise(resolve=>{let text='';process.stdin.on('data',part=>text+=part);process.stdin.on('end',()=>resolve(text));}));
const root=input.module_root,load=name=>import(pathToFileURL(path.join(root,name+'.js')));
const [{createResourceContainer},{MigrationCoordinator,AuthorityStore,lookupAuthorityActivation,assertExternalAuthorityCurrent},{FileExternalAuthorityJournal},{SourceMetadata},{PostgresSourceObjectCatalog},{SourceObjectService,sourceObjectId},{PersistentTree},{S3SourceObjectBackend,sourceS3Configuration},{SourceBackupService},{SourceRecoveryService,parseRecoveryProfile},{canonicalEnvelope,SourceControlError},{SourceCollector},{SourceRoutedObjectCatalog,SourceRoutingService}]=await Promise.all([load('storage/runtime'),load('storage/durability'),load('storage/authority_journal'),load('source_control/metadata'),load('source_control/object_catalog'),load('source_control/objects'),load('source_control/trees'),load('source_control/s3'),load('source_control/backup'),load('source_control/recovery'),load('source_control/contracts'),load('source_control/gc'),load('source_control/routing')]);
const hash=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const config=input.backend_config??sourceS3Configuration(process.env),backend=new S3SourceObjectBackend(config);
const env={HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL:input.database_url,HYPERFIDE_MIGRATION_DATABASE_URL:input.database_url,HYPERFIDE_MIGRATION_JOB:'1',HYPERFIDE_REQUIRE_SYNC_REPLICA:input.synchronous?'1':'0',HYPERFIDE_PG_STATEMENT_TIMEOUT_MS:'15000',HYPERFIDE_PG_CONNECT_TIMEOUT_MS:'3000'};
const resources=createResourceContainer({role:'control',env,signal:new AbortController().signal});
const pool=new pg.Pool({connectionString:input.database_url,max:4});
const metadata=new SourceMetadata(pool,{transaction:body=>resources.gateway.withPrimaryTransaction({timeoutMs:15000,maxRetries:2},body)});
const catalog=new PostgresSourceObjectCatalog({transaction:body=>metadata.transaction(body)}),objects=new SourceObjectService(catalog,backend),trees=new PersistentTree(objects);
const context={scope:input.scope,principal_id:input.principal,authority_epoch:input.source_epoch??'1',expires_at:input.credential_expiry??new Date(Date.now()+3600000).toISOString(),policy_version:'recovery-fixture-v1',assertCurrent:async(tx)=>{const row=(await tx.query('SELECT authority_epoch::text,enabled FROM hyperfide.source_authority_domains WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3',Object.values(input.scope))).rows[0];if(!row||!row.enabled||row.authority_epoch!==(input.source_epoch??'1')){throw new SourceControlError('STALE_AUTHORITY','Old source writer is fenced');}}};
const recoveryBackend=input.hide_abort?{identity:backend.identity,put:backend.put.bind(backend),read:backend.read.bind(backend),delete:backend.delete.bind(backend),abortMultipart:async(...args)=>{await backend.abortMultipart(...args);return 'UNKNOWN';}}:backend;
const journal=new FileExternalAuthorityJournal(input.journal_dir,value=>lookupAuthorityActivation(resources,value)),store=new AuthorityStore(resources,input.deployment_id,journal),backups=new SourceBackupService(metadata,recoveryBackend);
const authority={verify:async request=>{const receipt=await lookupAuthorityActivation(resources,{deployment_id:input.deployment_id,operation_id:request.operation_id,expected_previous_epoch:request.expected_external_epoch,database_predecessor_epoch:request.expected_database_epoch,epoch:request.activated_epoch});const head=await assertExternalAuthorityCurrent(resources,journal,{deployment_id:input.deployment_id});if(head.epoch!==receipt.epoch)throw Error('Stale external activation');return {epoch:receipt.epoch,proof_digest:receipt.evidence_digest,deployment_id:input.deployment_id};}};
const {createLocalGitDestination}=await load('source_control/git/transport'),{SourceGitPublicationService}=await load('source_control/git/export');
const destination=()=>{const value=createLocalGitDestination({scope:input.scope,id:'recovery-remote',repository_identity:'owned-recovery-remote',path:input.remote_git,allowed_refs:['refs/heads/main']});if(input.hide_remote)value.transport={...value.transport,observe:async()=>{throw Error('owned remote unavailable');}};return value;};
const recovery=new SourceRecoveryService(metadata,backups,authority,async(ctx,request)=>{
 const publications=new SourceGitPublicationService(metadata,objects,trees,{destinations:[destination()],acceptance:async()=>{throw Error('Recovery must not reauthorize historical acceptance');},authorizeRevision:async()=>{throw Error('Recovery must not project or republish');}});
 return publications.reconcileRecovery(ctx,request);
});
const fencer={isolate:async request=>{
 const observations=[];
 if(request.source_epoch===null){const observed=(await resources.observe({preferReplica:false},session=>session.query('SELECT system_identifier::text,(SELECT count(*)::integer FROM hyperfide.authority_epochs) AS epochs FROM pg_control_system()'))).value.rows[0];if(observed.epochs!==0)throw Error('Fresh authority has previous epochs');observations.push({kind:'FRESH_OWNED_POSTGRES',system_identifier:observed.system_identifier});}
 for(const previous of input.old_writers??[]){let status;try{execFileSync('runuser',['-u','postgres','--',path.join(input.pg_bin,'pg_ctl'),'-D',previous.directory,'status'],{stdio:'pipe'});status=0;}catch(error){status=error.status;}if(status!==3)throw Error('Prior PostgreSQL writer remains alive');
 await new Promise((resolve,reject)=>{const socket=net.connect(previous.socket);socket.once('connect',()=>{socket.destroy();reject(Error('Prior PostgreSQL socket remains reachable'));});socket.once('error',error=>{socket.destroy();['ENOENT','ECONNREFUSED'].includes(error.code)?resolve():reject(error);});});observations.push({directory:previous.directory,status});}
 if(request.source_epoch!==null&&!observations.length)throw Error('Prior writer evidence is required');
 const now=Date.now();return {deployment_id:request.deployment_id,operation_id:request.operation_id,fence_id:randomUUID(),source_epoch:request.source_epoch,isolated_writer:observations.length?hash(JSON.stringify(observations)):'fresh-owned-cluster',observed_at:new Date(now).toISOString(),expires_at:new Date(now+25000).toISOString(),evidence_digest:hash(JSON.stringify(observations))};
}};
try{
 let result;
 if(input.mode==='setup'){
  await new MigrationCoordinator(resources,input.migrations).apply({timeoutMs:30000});
  const activated=await store.activate({operation_id:randomUUID(),expected_previous_epoch:null},fencer);
  await metadata.registerRepository(input.scope,{authority_epoch:'1',policy_version:'recovery-fixture-v1',durability_profile:'owned-sync-pg-s3-v1'});
  await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(input.scope),'recovery-fixture-v1']);
  result={external_epoch:activated.epoch,backend:backend.identity};
 }else if(input.mode==='probe'){
  const bytes=canonicalEnvelope('blob',Buffer.from('native-source-recovery-probe')),id=hash(bytes),key='source/v1/'+randomUUID()+'/blob/'+id.slice(7,9)+'/'+id.slice(7)+'/'+randomUUID();
  const put=await backend.put(key,bytes),read=await backend.read(key,bytes.length),conditional=await backend.put(key,Buffer.from('different'));
  if(read.state!=='PRESENT'||!read.bytes.equals(bytes)||conditional!=='EXISTS')throw Error('Backend capability probe failed');
  const removed=await backend.delete(key,id,bytes.length);if(removed!=='ABSENT')throw Error('Backend delete probe remains unknown');
  const durability=(await pool.query("SELECT current_setting('server_version') AS server_version,current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS commit,(SELECT count(*)::integer FROM pg_stat_replication WHERE state='streaming' AND sync_state IN ('sync','quorum')) AS replicas")).rows[0];result={backend:backend.identity,evidence_digest:hash(JSON.stringify({put,conditional,removed,object_id:id})),metadata_evidence:hash(JSON.stringify(durability)),postgres_version:durability.server_version,migrations:(await pool.query('SELECT version,name,checksum FROM hyperfide.schema_migrations ORDER BY version')).rows,region:config.region};
 }else if(input.mode==='multipart-stage'){
  const bytes=Buffer.from('incomplete multipart recovery'),payload=canonicalEnvelope('blob',bytes),upload=await catalog.begin(input.scope,{operation_id:randomUUID(),object_id:sourceObjectId('blob',bytes),kind:'blob',size_bytes:String(payload.length)}),started=await backend.initiateMultipart(upload.storage_key);if(started.state!=='ACKNOWLEDGED')throw Error('Actual multipart initiation failed');const part=await backend.uploadPart(upload.storage_key,started.upload_id,1,payload);if(part.state!=='ACKNOWLEDGED')throw Error('Actual multipart part failed');await pool.query('UPDATE hyperfide.source_object_uploads SET backend_upload_id=$5 WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND upload_id=$4',[...Object.values(input.scope),upload.upload_id,started.upload_id]);result={upload_id:upload.upload_id,backend_upload_id:started.upload_id,storage_key:upload.storage_key};
 }else if(input.mode==='multipart-absent'){
  let refused=false;try{await backend.uploadPart(input.multipart.storage_key,input.multipart.backend_upload_id,1,Buffer.from('must not survive abort'));}catch(error){if(error.code!=='OBJECT_BACKEND_REJECTED')throw error;refused=true;}if(!refused)throw Error('Captured multipart upload survived reconciliation');result={aborted:true};
 }else if(input.mode==='unlisted-upload'){const payload=Buffer.from('late unacknowledged upload');result=await catalog.begin(input.scope,{operation_id:randomUUID(),object_id:sourceObjectId('blob',payload),kind:'blob',size_bytes:String(canonicalEnvelope('blob',payload).length)});
 }else if(input.mode==='publication-stage'){
  execFileSync('git',['init','--bare',input.remote_git],{stdio:'pipe'});
  const selected=destination(),actual=selected.transport;let hideReadback=false;selected.transport={...actual,push:async request=>{await actual.push(request);hideReadback=true;throw Error('lost issued push acknowledgment');},observe:async(...args)=>{if(hideReadback){hideReadback=false;throw Error('lost immediate publication readback');}return actual.observe(...args);}};
  const {createNativeAcceptanceFixture}=await import('./native_source_acceptance_fixture.mjs');
  const fixture=await createNativeAcceptanceFixture({pool,migrate:false,existingRepository:true,sourcePolicy:'recovery-fixture-v1',scope:input.scope,moduleRoot:path.join(root,'source_control'),sdkRoot:input.sdk_root,serviceOptions:{backend,publication:{destinations:[selected]}},actions:['source.revisions.create','source.revisions.read','source.objects.put','source.objects.read','source.domains.create','source.assurance.custody.create','source.assurance.publish','source.candidates.create','source.candidates.qualify','source.acceptance.accept','source.acceptance.read','source.candidates.read','source.domains.read','source.publications.create','source.publications.resume','source.publications.read']});
  try{const checked=await fixture.createRevision({text:'candidate: recovery publication\n',parent_revision_ids:[]}),candidate=await fixture.createCandidate(checked,{domain:await fixture.createDomain(checked)}),accepted=await fixture.accept(candidate),operation=randomUUID();const created=await fixture.mutation('source.publications.create',{acceptance_id:accepted.acceptance_id,destination_id:selected.id,target_ref:'refs/heads/main',expected_old_oid:null},{operation_id:operation,idempotency_key:operation});const issued=await fixture.client.resumePublication(operation);if(issued.status!=='OUTCOME_UNKNOWN')throw Error('Lost publication acknowledgment was not retained: '+issued.status);
   const remote=execFileSync('git',['--git-dir='+input.remote_git,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim();if('git:sha1:'+remote!==issued.git_oid)throw Error('Actual Git remote differs from issued source');const evidence=(await pool.query("SELECT object_id FROM hyperfide.source_object_pins WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND owner_id LIKE 'native-evidence:%' ORDER BY object_id LIMIT 1",Object.values(input.scope))).rows[0];if(!evidence)throw Error('Independent checker did not retain evidence');result={evidence_object_id:evidence.object_id,operation_id:operation,principal_id:fixture.roles.author.principal_id,git_oid:issued.git_oid,acceptance_id:accepted.acceptance_id,acceptance_digest:accepted.result_digest,revisions:[fixture.base.revision_id,checked.revision_id]};
  }finally{await fixture.close();}
 }else if(input.mode==='profile')result=parseRecoveryProfile(input.profile);
 else if(input.mode==='write'||input.mode==='stage'){
  const bytes=Buffer.from(input.text??'recovery fixture source\n');
  if(input.phase==='before-verification'||input.phase==='after-upload'){
   const payload=canonicalEnvelope('blob',bytes),upload=await catalog.begin(input.scope,{operation_id:input.operation_id,object_id:sourceObjectId('blob',bytes),kind:'blob',size_bytes:String(payload.length)});if(input.phase==='after-upload')await backend.put(upload.storage_key,payload);process.stdout.write(JSON.stringify({phase:input.phase,upload_id:upload.upload_id})+'\n');setInterval(()=>{},1000);await new Promise(()=>{});
  }
  const file=input.root_tree_id?null:await objects.putFile(input.scope,bytes),tree=input.root_tree_id??(await trees.fromEntries(input.scope,[{name:'main.txt',kind:'file',mode:'100644',object_id:file.object_id}])).root_tree_id;
  if(input.phase==='after-verification'){process.stdout.write(JSON.stringify({phase:input.phase,root_tree_id:tree})+'\n');setInterval(()=>{},1000);await new Promise(()=>{});}
  result=await metadata.createRevision(context,{operation_id:input.operation_id,idempotency_key:input.operation_id,change_id:input.change_id,root_tree_id:input.root_tree_id??tree,parent_revision_ids:input.parents??[],predecessor_revision_ids:[],provenance:{author:{name:'Recovery fixture',email:'recovery@example.invalid'},message:'durable source',timestamp:'2026-11-03T00:00:00.000Z'}});
  if(input.phase==='after-commit'){process.stdout.write(JSON.stringify({phase:input.phase,result})+'\n');setInterval(()=>{},1000);await new Promise(()=>{});}
 }else if(input.mode==='backup')result=await backups.create(context,input.backup);
 else if(input.mode==='backup-read')result=await backups.read(context,input.backup_id);
 else if(input.mode==='legacy-manifest'){
  const id=randomUUID(),original=(await pool.query('SELECT manifest FROM hyperfide.source_backups WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4',[...Object.values(input.scope),input.backup_id])).rows[0].manifest,legacy={...original,backup_id:id,schema_version:1};delete legacy.retained_roots;legacy.pending={...legacy.pending,publications:legacy.pending.publications.map(({principal_id,...publication})=>publication)};
  await pool.query("INSERT INTO hyperfide.source_backups(organisation_id,repository_id,security_domain_id,backup_id,profile,profile_digest,source_epoch,manifest,manifest_digest,expires_at,state) SELECT organisation_id,repository_id,security_domain_id,$5,profile,profile_digest,source_epoch,$6,$7,expires_at,'CAPTURED' FROM hyperfide.source_backups WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4",[...Object.values(input.scope),input.backup_id,id,legacy,(await load('source_control/metadata')).sourceDigest(legacy)]);
  try{await backups.verify(context,{backup_id:id,limit:1});throw Error('Legacy manifest unexpectedly verified');}catch(error){if(error.code!=='BACKUP_FORMAT_UNSUPPORTED')throw error;result={code:error.code};}
 }

 else if(input.mode==='verify'){for(let attempt=0;attempt<1000;attempt++){result=await backups.verify(context,{backup_id:input.backup_id,limit:128});if(result.state!=='VERIFYING')break;}}
 else if(input.mode==='effect-inventory'){const publication=(await pool.query('SELECT status,git_oid FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND principal_id=$4 AND operation_id=$5',[...Object.values(input.scope),input.publication.principal_id,input.publication.operation_id])).rows[0];const accepted=(await pool.query('SELECT receipt FROM hyperfide.source_native_acceptances WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND acceptance_id=$4',[...Object.values(input.scope),input.publication.acceptance_id])).rows[0];result={publication,acceptance_digest:accepted?.receipt.result_digest,remote:'git:sha1:'+execFileSync('git',['--git-dir='+input.remote_git,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim()};}
 else if(input.mode==='inventory')result=(await pool.query('SELECT revision_id,root_tree_id FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY revision_id',Object.values(input.scope))).rows;
 else if(input.mode==='restore'){
  const activated=await store.activateRestored({operation_id:input.operation_id,expected_external_epoch:input.external_epoch,expected_database_epoch:input.database_epoch},fencer);
  const request={backup_id:input.backup_id,operation_id:input.operation_id,expected_external_epoch:input.external_epoch,expected_database_epoch:input.database_epoch,activated_epoch:activated.epoch};
  result={activation:activated,request};
 }else if(input.mode==='prepare')result=await recovery.prepare(context,input.request);
 else if(input.mode==='reconcile')result=await recovery.reconcile(context,input.request);
 else if(input.mode==='pending-delete'){
  const object=await objects.put(input.scope,'blob',Buffer.from('pending-delete-'+input.operation_id));
  await pool.query("UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND owner_kind='UPLOAD'",[...Object.values(input.scope),object.object_id]);
  const collector=new SourceCollector({transaction:body=>metadata.transaction(body)},{identity:backend.identity,put:backend.put.bind(backend),read:backend.read.bind(backend),delete:async(...args)=>{await backend.delete(...args);return 'UNKNOWN';}});
  await collector.configure(input.scope,{expected_generation:'0',minimum_age_seconds:0,quarantine_seconds:0,backup_until:'2000-01-01T00:00:00Z',backend_identity:backend.identity,independent_expiration:false});
  const partition=parseInt(object.object_id.slice(7,9),16)%16;await collector.discover(input.scope,{partition,limit:256});result=await collector.collect(input.scope,{partition,limit:256});
 }
 else if(input.mode==='activate')result=await recovery.activate(context,input.request);
 else if(input.mode==='remove-object'||input.mode==='restore-object'){
  const row=(await pool.query('SELECT * FROM hyperfide.source_backup_objects WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND backup_id=$4 AND ($5::text IS NULL OR object_id=$5) ORDER BY object_id LIMIT 1',[...Object.values(input.scope),input.backup_id,input.object_id??null])).rows[0];
  if(input.mode==='remove-object'){const read=await backend.read(row.storage_key,Number(row.size_bytes));if(read.state!=='PRESENT')throw Error('Missing removal fixture object');await fs.writeFile(input.object_copy,read.bytes,{mode:0o600});if(await backend.delete(row.storage_key,row.object_id,Number(row.size_bytes))!=='ABSENT')throw Error('Removal fixture did not establish absence');result={object_id:row.object_id};}
  else{await backend.put(row.storage_key,await fs.readFile(input.object_copy));result={restored:row.object_id};}
 }else if(input.mode==='routing'){
  const routing=new SourceRoutingService(metadata),bytes=Buffer.from('routing source'),id=sourceObjectId('blob',bytes),partition=parseInt(id.slice(7,9),16)%16,db={transaction:body=>metadata.transaction(body)};
  await routing.move(context,{operation_id:randomUUID(),partition,expected_generation:'0',owner_id:'owner-a'});
  const a=new SourceObjectService(new SourceRoutedObjectCatalog(db,'owner-a'),backend),b=new SourceObjectService(new SourceRoutedObjectCatalog(db,'owner-b'),backend);
  const operation=randomUUID(),envelope=canonicalEnvelope('blob',bytes),upload=await a.beginUpload(input.scope,{operation_id:operation,object_id:id,kind:'blob',size_bytes:String(envelope.length),owner_principal_id:input.principal});await backend.put(upload.storage_key,envelope);
  const move={operation_id:randomUUID(),partition,expected_generation:'1',owner_id:'owner-b'},moved=await routing.move(context,move);if((await routing.move(context,move)).generation!==moved.generation)throw Error('Move replay changed generation');
  let refused=false;try{await a.completeUpload(input.scope,upload.upload_id);}catch(error){refused=error.code==='STALE_ROUTE';}if(!refused)throw Error('Obsolete route writer completed upload');
  await b.completeUpload(input.scope,upload.upload_id);if(!(await a.read(input.scope,id)).payload.equals(bytes))throw Error('Immutable read interrupted by route move');result={generation:moved.generation,old_writer_refused:refused};
 }else if(input.mode==='delayed-delete'){
  const bytes=Buffer.from('restore incarnation'),first=await objects.put(input.scope,'blob',bytes),partition=parseInt(first.object_id.slice(7,9),16)%16,db={transaction:body=>metadata.transaction(body)};
  await pool.query("UPDATE hyperfide.source_object_pins SET expires_at=clock_timestamp()-interval '1 second' WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND object_id=$4 AND owner_kind='UPLOAD'",[...Object.values(input.scope),first.object_id]);
  const collector=new SourceCollector(db,backend);await collector.configure(input.scope,{expected_generation:'0',minimum_age_seconds:0,quarantine_seconds:0,backup_until:'2000-01-01T00:00:00Z',backend_identity:backend.identity,independent_expiration:false});await collector.discover(input.scope,{partition,limit:16});
  let release,arrived;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>arrived=resolve);
  const delayed=new SourceCollector(db,{identity:backend.identity,read:backend.read.bind(backend),put:backend.put.bind(backend),delete:async(...args)=>{arrived();await gate;return backend.delete(...args);}});
  const old=delayed.collect(input.scope,{partition,limit:16});await entered;await collector.collect(input.scope,{partition,limit:16});const fresh=await objects.put(input.scope,'blob',bytes);release();await old;
  if(first.incarnation_id===fresh.incarnation_id||!(await objects.read(input.scope,fresh.object_id)).payload.equals(bytes))throw Error('Delayed old deletion damaged fresh incarnation');result={old_incarnation:first.incarnation_id,new_incarnation:fresh.incarnation_id,preserved:true};
 }else if(input.mode==='epoch-race'){
  const {createRevisionInTransaction}=await load('source_control/revisions'),first=await pool.connect(),second=await pool.connect();let revoke;
  try{
   await first.query('BEGIN');await second.query('BEGIN');const pid=(await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   const tree=(await first.query('SELECT root_tree_id FROM hyperfide.source_revisions WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 LIMIT 1',Object.values(input.scope))).rows[0].root_tree_id,operation=randomUUID();
   const receipt=await createRevisionInTransaction(metadata,first,context,{operation_id:operation,idempotency_key:operation,change_id:randomUUID(),root_tree_id:tree,parent_revision_ids:[],predecessor_revision_ids:[],provenance:{author:{name:'Recovery race',email:'race@example.invalid'},message:'rollback-only race',timestamp:'2026-11-03T00:00:00.000Z'}});
   let settled=false;revoke=second.query("UPDATE hyperfide.authority_epochs SET state='REVOKED' WHERE deployment_id=$1 AND state='ACTIVE'",[input.deployment_id]).then(value=>{settled=true;return value;});
   let blocked=false;for(let index=0;index<200&&!settled;index++){blocked=(await pool.query("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1",[pid])).rows[0]?.blocked===true;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,10));}
   if(!blocked)throw Error('External epoch revocation outran active source mutation');
   await first.query('ROLLBACK');await revoke;await second.query('ROLLBACK');
   const retained=(await pool.query('SELECT 1 FROM hyperfide.source_metadata_operations WHERE organisation_id=$1 AND operation_id=$2',[input.scope.organisation_id,operation])).rowCount;
   if(retained)throw Error('Rollback-only contender produced durable work');result={blocked,source_revision_rolled_back:true};
  }finally{await first.query('ROLLBACK');if(revoke)await revoke;await second.query('ROLLBACK');first.release();second.release();}
 }else if(input.mode==='object-gate'){
  const [{verifySourcePrincipalToken},{authorizeSource}]=await Promise.all([load('source_control/authentication'),load('source_control/capabilities')]);
  const credential=randomUUID(),capability=randomUUID(),keys=generateKeyPairSync('ed25519'),now=Math.floor(Date.now()/1000),issuer='recovery-gate-fixture',audience='recovery-gate';
  await pool.query("INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'fixture',clock_timestamp()+interval '5 minutes')",[...Object.values(input.scope),credential,input.principal,issuer,audience]);
  await pool.query("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,'recovery-fixture-v1',ARRAY['source.objects.put'],ARRAY[''],clock_timestamp()+interval '5 minutes')",[...Object.values(input.scope),capability,input.principal,credential]);
  const head=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'HF-SOURCE-1',kid:'fixture'})).toString('base64url'),body=Buffer.from(JSON.stringify({schema_version:1,iss:issuer,aud:audience,sub:input.principal,credential_id:credential,credential_version:'1',principal_kind:'automation',scope:input.scope,iat:now,nbf:now,exp:now+60,capability_id:capability})).toString('base64url'),token=head+'.'+body+'.'+sign(null,Buffer.from(head+'.'+body),keys.privateKey).toString('base64url');
  const principal=verifySourcePrincipalToken(token,{issuer,audience,keys:{fixture:keys.publicKey},max_ttl_seconds:300},input.scope);let code=null;
  try{await metadata.transaction(tx=>authorizeSource(tx,{principal,scope:input.scope,action:'source.objects.put',mutation:true}));}catch(error){code=error.code;}result={code};
 }else if(input.mode==='cleanup'){
  const rows=(await pool.query('SELECT p.storage_key,o.object_id,o.size_bytes FROM hyperfide.source_object_placements p JOIN hyperfide.source_native_objects o USING(organisation_id,repository_id,security_domain_id,object_id) WHERE o.organisation_id=$1 AND o.repository_id=$2 AND o.security_domain_id=$3',Object.values(input.scope))).rows;
  const unresolved=[];const multiparts=(await pool.query('SELECT u.backend_upload_id,p.storage_key FROM hyperfide.source_object_uploads u JOIN hyperfide.source_object_placements p USING(organisation_id,repository_id,security_domain_id,object_id,incarnation_id) WHERE u.organisation_id=$1 AND u.repository_id=$2 AND u.security_domain_id=$3 AND u.backend_upload_id IS NOT NULL',Object.values(input.scope))).rows;for(const multipart of multiparts)if(await backend.abortMultipart(multipart.storage_key,multipart.backend_upload_id)!=='ACKNOWLEDGED')unresolved.push('multipart:'+multipart.backend_upload_id);for(const row of rows)if(await backend.delete(row.storage_key,row.object_id,Number(row.size_bytes))!=='ABSENT')unresolved.push(row.object_id);result={unresolved};
 }else throw Error('Unknown source recovery fixture mode');
 process.stdout.write(JSON.stringify(result)+'\n');
}finally{await pool.end();await resources.close();}
