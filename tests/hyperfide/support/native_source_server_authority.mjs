import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,generateKeyPairSync,sign,createHash} from 'node:crypto';
import pg from '../../../core/control-plane/node_modules/pg/lib/index.js';
import {SourceControlClient} from '../../../sdk/source-control/src/client.ts';
import {createResourceContainer} from '../../../core/control-plane/dist/storage/runtime.js';
import {AuthorityStore,lookupAuthorityActivation} from '../../../core/control-plane/dist/storage/durability.js';
import {FileExternalAuthorityJournal} from '../../../core/control-plane/dist/storage/authority_journal.js';
const input=JSON.parse(await fs.readFile(process.env.SOURCE_SERVER_AUTHORITY_INPUT,'utf8'));
const pgClient=async name=>{for(const directory of [process.env.HYPERFIDE_PG_BIN,'/usr/lib/postgresql/18/bin','/usr/bin']){if(!directory)continue;const filename=path.join(directory,name);try{await fs.access(filename);return filename;}catch{}}throw new Error('PostgreSQL client binary unavailable: '+name);};
const directory=path.dirname(process.env.SOURCE_SERVER_AUTHORITY_INPUT),execute=promisify(execFile),pool=new pg.Pool({connectionString:input.admin_url}),children=new Set();
const scope={organisation_id:randomUUID(),repository_id:randomUUID(),security_domain_id:randomUUID()},principal=randomUUID(),credential=randomUUID(),capability=randomUUID();
const {privateKey,publicKey}=generateKeyPairSync('ed25519'),issuer='standalone-authority-test',audience='source';
const configuration=path.join(directory,'standalone.json');
await fs.writeFile(configuration,JSON.stringify({host:'127.0.0.1',port:0,allowLoopbackHTTP:true,trust:{issuer,audience,max_ttl_seconds:900,keys:{fixture:publicKey.export({type:'spki',format:'pem'})}}}),{mode:0o600});
const envFor=url=>({...process.env,DATABASE_URL:url,HYPERFIDE_CONTROL_PRIMARY_DATABASE_URL:url,HF_SOURCE_CONTROL_CONFIG:configuration,HYPERFIDE_DEPLOYMENT_ID:input.deployment,HYPERFIDE_AUTHORITY_JOURNAL_DIR:input.journal});
const jwt=()=>{const now=Math.floor(Date.now()/1000),a=Buffer.from(JSON.stringify({alg:'EdDSA',kid:'fixture',typ:'HF-SOURCE-1'})).toString('base64url'),b=Buffer.from(JSON.stringify({schema_version:1,iss:issuer,aud:audience,sub:principal,credential_id:credential,credential_version:'1',principal_kind:'automation',scope,iat:now,nbf:now,exp:now+880,capability_id:capability})).toString('base64url');return a+'.'+b+'.'+sign(null,Buffer.from(a+'.'+b),privateKey).toString('base64url');};
const token=jwt();
async function stop(child){if(!child)return;if(child.exitCode!==null||child.signalCode!==null){children.delete(child);return;}child.kill('SIGTERM');await new Promise(resolve=>{const t=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(t);resolve();});});children.delete(child);}
async function launch(env){const child=spawn(process.execPath,[path.resolve('core/control-plane/dist/source_control/server.js')],{env,stdio:['ignore','pipe','pipe']});children.add(child);let output='';return new Promise(resolve=>{const timer=setTimeout(()=>{void stop(child);resolve({child,error:'STARTUP_TIMEOUT'});},20000);const consume=chunk=>{output+=chunk;for(const line of output.split('\n')){try{const row=JSON.parse(line);if(row.event==='source-control.ready'){clearTimeout(timer);resolve({child,address:row.address});}if(row.event==='source-control.failed'){clearTimeout(timer);resolve({child,error:row.code});}}catch{}}};child.stdout.on('data',consume);child.stderr.on('data',consume);child.once('exit',()=>{clearTimeout(timer);resolve({child,error:'STARTUP_EXIT'});});});}
const checks=[],outcomes=[];let restoredName,resources;
try {
 await pool.query('INSERT INTO hyperfide.source_repositories(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version,durability_profile) VALUES($1,$2,$3,1,$4,$5)',[...Object.values(scope),'standalone-v1','single-region-verified-s3-v1']);
 await pool.query('INSERT INTO hyperfide.source_authority_domains(organisation_id,repository_id,security_domain_id,authority_epoch,policy_version) VALUES($1,$2,$3,1,$4)',[...Object.values(scope),'standalone-v1']);
 await pool.query("INSERT INTO hyperfide.source_principal_credentials(organisation_id,repository_id,security_domain_id,credential_id,principal_id,principal_kind,credential_version,issuer,audience,signing_key_id,expires_at) VALUES($1,$2,$3,$4,$5,'automation',1,$6,$7,'fixture',clock_timestamp()+interval '30 minutes')",[...Object.values(scope),credential,principal,issuer,audience]);
 await pool.query("INSERT INTO hyperfide.source_capabilities(organisation_id,repository_id,security_domain_id,id,principal_id,credential_id,principal_kind,authority_epoch,policy_version,actions,path_prefixes,expires_at) VALUES($1,$2,$3,$4,$5,$6,'automation',1,$7,$8,ARRAY[''],clock_timestamp()+interval '30 minutes')",[...Object.values(scope),capability,principal,credential,'standalone-v1',['source.objects.put','source.objects.read']]);
 const live=await launch(envFor(input.admin_url));assert(live.address,'Current accepted external authority must start the actual listener');
 const client=new SourceControlClient({endpoint:live.address+'/api/v1/source-control',scope,token});
 const put=()=>client.call('source.objects.put',{kind:'blob',payload_base64:Buffer.from('authority exact bytes').toString('base64')});
 const object=await put();assert.equal(Buffer.from((await client.object(object.object_id)).payload_base64,'base64').toString(),'authority exact bytes');checks.push('standalone production entrypoint accepts current independent authority and authenticates exact source bytes');
 const journalFile=path.join(input.journal,input.deployment+'.authority.json'),held=journalFile+'.held';await fs.rename(journalFile,held);
 const deniedOperation=randomUUID();let denied=false;try{await client.call('source.objects.put',{kind:'blob',payload_base64:Buffer.from('must not write without journal').toString('base64')},{operation_id:deniedOperation});}catch(error){denied=error.code==='EXTERNAL_AUTHORITY_UNAVAILABLE';}finally{await fs.rename(held,journalFile);}
 const deniedRows=(await pool.query('SELECT count(*)::integer AS count FROM hyperfide.source_object_uploads WHERE operation_id=$1',[deniedOperation])).rows[0].count;denied=denied&&deniedRows===0;
 outcomes.push({check:'running listener rechecks external journal before every source metadata transaction',passed:denied});
 const backup=path.join(directory,'source-before-rotation.dump');await execute(await pgClient('pg_dump'),['--dbname',input.admin_url,'--format=custom','--file',backup],{maxBuffer:1024*1024});
 await stop(live.child);for(const pid of [input.old_component_pid,live.child.pid])assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
 resources=createResourceContainer({role:'control',env:envFor(input.admin_url),signal:new AbortController().signal});
 const journal=new FileExternalAuthorityJournal(input.journal,value=>lookupAuthorityActivation(resources,value)),authority=new AuthorityStore(resources,input.deployment,journal);
 const next=await authority.activate({operation_id:randomUUID(),expected_previous_epoch:input.epoch},{isolate:async request=>{const observation={stopped_pids:[input.old_component_pid,live.child.pid]};for(const pid of observation.stopped_pids)assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');const now=Date.now();return {deployment_id:request.deployment_id,operation_id:request.operation_id,source_epoch:request.source_epoch,fence_id:randomUUID(),isolated_writer:'owned-stopped-listeners',observed_at:new Date(now).toISOString(),expires_at:new Date(now+25000).toISOString(),evidence_digest:'sha256:'+createHash('sha256').update(JSON.stringify(observation)).digest('hex')};}});
 assert.notEqual(next.epoch,input.epoch);await resources.close();resources=null;
 restoredName='hf_source_restore_'+randomUUID().replaceAll('-','');await pool.query('CREATE DATABASE "'+restoredName+'"');const restoredURL=new URL(input.admin_url);restoredURL.pathname='/'+restoredName;
 await execute(await pgClient('pg_restore'),['--dbname',restoredURL.toString(),'--no-owner',backup],{maxBuffer:1024*1024});
 const restoredPool=new pg.Pool({connectionString:restoredURL.toString()});
 try{assert.equal((await restoredPool.query("SELECT epoch::text FROM hyperfide.authority_epochs WHERE deployment_id=$1 AND state='ACTIVE'",[input.deployment])).rows[0].epoch,input.epoch);assert.equal((await restoredPool.query('SELECT count(*)::integer AS count FROM hyperfide.source_principal_credentials WHERE credential_id=$1 AND expires_at>clock_timestamp() AND revoked_at IS NULL',[credential])).rows[0].count,1);assert.equal((await restoredPool.query('SELECT count(*)::integer AS count FROM hyperfide.source_capabilities WHERE id=$1 AND expires_at>clock_timestamp() AND revoked_at IS NULL',[capability])).rows[0].count,1);}finally{await restoredPool.end();}
 const restored=await launch(envFor(restoredURL.toString()));let fenced=restored.error==='RESTORED_AUTHORITY_STALE';if(restored.address){const stale=new SourceControlClient({endpoint:restored.address+'/api/v1/source-control',scope,token});try{await stale.call('source.objects.put',{kind:'blob',payload_base64:Buffer.from('stale restored credential write').toString('base64')});}catch(error){fenced=error.code==='RESTORED_AUTHORITY_STALE';}}
 outcomes.push({check:'restored prior database with still-valid JWT and source capability cannot reopen against independently advanced journal',passed:fenced});await stop(restored.child);
 const noConfig=envFor(input.admin_url);delete noConfig.HYPERFIDE_AUTHORITY_JOURNAL_DIR;const missing=await launch(noConfig);outcomes.push({check:'standalone startup refuses missing protected external journal configuration',passed:missing.error==='EXTERNAL_JOURNAL_REQUIRED'});await stop(missing.child);
 const noState=await launch({...envFor(input.admin_url),HYPERFIDE_AUTHORITY_JOURNAL_DIR:path.join(directory,'absent-journal')});let absent=false;try{await fs.stat(path.join(directory,'absent-journal'));}catch(error){absent=error.code==='ENOENT';}outcomes.push({check:'standalone startup refuses absent independent authority state without creating a journal',passed:!!noState.error&&absent});await stop(noState.child);
 const racing=await launch(envFor(input.admin_url));assert(racing.address);
 const raceClient=new SourceControlClient({endpoint:racing.address+'/api/v1/source-control',scope,token}),raceOperation=randomUUID(),blocker=await pool.connect();
 try{
  await blocker.query('BEGIN ISOLATION LEVEL SERIALIZABLE');await blocker.query("SELECT epoch FROM hyperfide.authority_epochs WHERE deployment_id=$1 AND state='ACTIVE' FOR UPDATE",[input.deployment]);
  const pending=raceClient.call('source.objects.put',{kind:'blob',payload_base64:Buffer.from('must not cross changed admission').toString('base64')},{operation_id:raceOperation}).then(value=>({value}),error=>({error}));
  let blocked=false;for(let i=0;i<100;i++){blocked=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%authority_epochs%' AND pid<>pg_backend_pid()")).rows.length>0;if(blocked)break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert(blocked,'Real source admission must wait behind the independent authority lock');
  await blocker.query("UPDATE hyperfide.authority_epochs SET state='REVOKED' WHERE deployment_id=$1 AND state='ACTIVE'",[input.deployment]);await blocker.query('COMMIT');
  const result=await pending;
  const writes=(await pool.query('SELECT count(*)::integer AS count FROM hyperfide.source_object_uploads WHERE operation_id=$1',[raceOperation])).rows[0].count;
  outcomes.push({check:'authority changed behind a real transaction lock returns typed stale authority and creates no source upload',passed:result.error?.code==='RESTORED_AUTHORITY_STALE'&&writes===0,observed_code:result.error?.code??'ACCEPTED',upload_rows:writes});
 }finally{await blocker.query('ROLLBACK');blocker.release();await stop(racing.child);}
 assert.deepEqual(outcomes.map(value=>value.passed),outcomes.map(()=>true),JSON.stringify(outcomes));checks.push(...outcomes.map(x=>x.check));
 const output=path.resolve(process.env.HYPERFIDE_SOURCE_EVIDENCE_DIR??'build/source-control/server-authority');await fs.mkdir(output,{recursive:true});const receipt={status:'PASS',checks,profile:'actual standalone entrypoint, JWT, PostgreSQL dump/restore and independent file journal',previous_epoch:input.epoch,current_epoch:next.epoch};await fs.writeFile(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
}finally{for(const child of children)await stop(child);await resources?.close();if(restoredName)await pool.query('DROP DATABASE IF EXISTS "'+restoredName+'" WITH (FORCE)');await pool.end();}
