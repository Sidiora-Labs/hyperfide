import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const runtimeRoot=process.env.HF_COMPLETION_QUEUE_RUNTIME_ROOT?pathToFileURL(path.resolve(process.env.HF_COMPLETION_QUEUE_RUNTIME_ROOT)+path.sep):new URL('../../../../core/control-plane/',import.meta.url);
const {createResourceContainer}=await import(new URL('dist/storage/runtime.js',runtimeRoot));
const {nextFleetCompletion}=await import(new URL('dist/runner/fleet_completion.js',runtimeRoot));
const fleetCompletionNativeOperation=identity=>{const h=sha(canonical(identity)).slice(7);return h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};

const require=createRequire(new URL('../../../../core/control-plane/package.json',import.meta.url)),{Client}=require('pg');
let input='';for await(const part of process.stdin)input+=part;
const {ids:i}=JSON.parse(input);
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
const sha=value=>'sha256:'+createHash('sha256').update(typeof value==='string'||value instanceof Uint8Array?value:canonical(value)).digest('hex');
const pin=sha('DECLARED_COMPLETION_METADATA_NOT_RUNTIME_EVIDENCE'),checks=[];
const check=(id,value)=>{if(!value)throw Error(id);checks.push({id,status:'PASS'});};
const client=new Client({connectionString:process.env.DATABASE_URL});await client.connect();
const resources=createResourceContainer({role:'control',env:process.env,signal:new AbortController().signal});
let serial=0;
async function seed(body){await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');try{const result=await body();await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}}
async function insert(table,row,json=[]){const keys=Object.keys(row),values=keys.map(k=>json.includes(k)?JSON.stringify(row[k]):row[k]);await client.query('INSERT INTO hyperfide.'+table+'('+keys.join(',')+') VALUES('+keys.map((k,n)=>'$'+(n+1)+(json.includes(k)?'::jsonb':'')).join(',')+')',values);}
async function scenario(){
 const run=randomUUID(),feature=randomUUID(),task=randomUUID(),operator=randomUUID(),coordinator=randomUUID(),sandbox=randomUUID(),runnerCredential=randomUUID(),quota='queue-'+randomUUID();
 await insert('runs',{organisation_id:i.organisation,id:run,project_id:i.project,spec_revision_id:i.spec,policy_digest:pin,authority_epoch:i.epoch,state:'RUNNING'});
 await insert('sandboxes',{organisation_id:i.organisation,id:sandbox,pool_id:i.pool,native_sandbox_id:'queue-'+sandbox,observed_state:'RUNNING',preparation_digest:pin});
 const boot=(await client.query('SELECT boot_id FROM hyperfide.sandbox_boots WHERE organisation_id=$1 AND sandbox_id=$2',[i.organisation,sandbox])).rows[0].boot_id;
 await insert('feature_packages',{organisation_id:i.organisation,run_id:run,id:feature,package_key:'queue',wave:1});
 await insert('tasks',{organisation_id:i.organisation,run_id:run,id:task,task_key:'queue',feature_package_id:feature,spec_revision_id:i.spec,criteria_digest:pin,definition:{fixture:'DECLARED_HISTORY'},wave:1},['definition']);
 const pair=generateKeyPairSync('ed25519'),credential=randomUUID();
 for(const [id,role]of [[credential,'PROVISIONER'],[operator,'OPERATOR'],[coordinator,'COORDINATOR'],[runnerCredential,'RUNNER']])await insert('identity_principals',{credential_id:id,organisation_id:i.organisation,run_id:run,actor_id:randomUUID(),role,public_key_b64:(role==='PROVISIONER'?pair.publicKey:generateKeyPairSync('ed25519').publicKey).export({format:'jwk'}).x,deployment_epoch:i.epoch,allowed_actions:['identity.describe','runner.control.issue','provider.remote.execute-bound'],...(role==='RUNNER'?{sandbox_id:sandbox,boot_id:boot,boot_generation:1}:{}),expires_at:'2099-01-01T00:00:00Z'});
 await insert('agent_admission_accounts',{organisation_id:i.organisation,run_id:run,quota_key:quota,policy_digest:pin,max_concurrent:1000});
 return {run,feature,task,operator,coordinator,sandbox,boot,runnerCredential,quota,credential,key:pair.privateKey,index:0,principal:(await client.query('SELECT * FROM hyperfide.identity_principals WHERE credential_id=$1',[credential])).rows[0]};
}
async function completed(s,{exit=0,state='EXITED',reported=false,issuer=s.operator,registry_launch=false}={}){
 const n=++s.index,slot=randomUUID(),attempt=randomUUID(),session=randomUUID(),runner=randomUUID(),start=randomUUID(),launch=randomUUID(),control=randomUUID(),event=randomUUID(),admission=randomUUID();
 const scope={organisation_id:i.organisation,run_id:s.run},timestamp='2026-01-01 00:00:00.'+String(n).padStart(6,'0')+'+00';
 await insert('worker_slots',{organisation_id:i.organisation,id:slot,sandbox_id:s.sandbox,slot_key:'queue-'+slot,boot_generation:1,capacity_kind:'AGENT',state:'DRAINING'});
 await insert('attempts',{...scope,id:attempt,task_id:s.task,generation:n,authority_epoch:i.epoch,input_packet_digest:pin,execution_state:'FAILED',compute_authority:'RELEASED',sandbox_id:s.sandbox,slot_id:slot,sandbox_boot_generation:1});
 await insert('agent_sessions',{...scope,id:session,role:'WORKER',connector:'fixture',account_key:'queue',native_session_id:session,slot_id:slot,sandbox_id:s.sandbox,sandbox_boot_generation:1,attempt_id:attempt,state:'STOPPED'});
 await insert('outbox_events',{...scope,id:event,aggregate_type:'attempt.instructions',aggregate_id:attempt,aggregate_version:1,event_type:'instruction.start',payload:{fixture:'DECLARED_HISTORY'}},['payload']);
 await insert('agent_admission_reservations',{...scope,id:admission,quota_key:s.quota,session_id:session,payload_digest:pin,policy_digest:pin,state:'RELEASED'});
 await insert('scheduler_dispatches',{...scope,id:start,request_id:start,task_id:s.task,attempt_id:attempt,attempt_generation:n,authority_epoch:i.epoch,sandbox_id:s.sandbox,slot_id:slot,sandbox_boot_generation:1,payload_digest:pin,state:'COMPLETED',event_id:event});
 await insert('native_launch_plans',{...scope,command_id:start,launch_id:launch,agent_session_id:session,slot_id:slot,attempt_id:attempt,attempt_generation:n,connector:'claude',connector_plan_digest:pin,admission_reservation_id:admission,reservation_attempt:1,admission_policy_digest:pin,run_policy_digest:pin,qualification_receipt_digest:pin,packet_digest:pin,payload_digest:pin,plan:{fixture:'DECLARED_HISTORY'}},['plan']);
 await insert('runner_registry',{...scope,session_id:runner,credential_id:s.runnerCredential,sandbox_id:s.sandbox,boot_generation:1,boot_id:s.boot,slot_id:slot,launch_id:registry_launch?launch:null,state_dir:'/srv/queue/'+launch,runner_binary:'/srv/queue/native',workspace_path:'/srv/queue/'+launch+'/source',home_path:'/srv/queue/'+launch+'/home',tmp_path:'/srv/queue/'+launch+'/tmp',runner_binary_digest:pin,boot_preparation_digest:pin,preparation_digest:pin,readiness_digest:pin,source_digest:pin,source_object_id:'1'.repeat(40),source_tree_id:'2'.repeat(40),slot_generation:1,uid:62000+serial,gid:62000+serial,observation_digest:pin,state:'CURRENT'});
 serial++;
 const result={command_id:start,launch_id:launch,request_digest:pin,native:{foreground_owner:true,terminal_observed:true,state,exit_code:exit}};
 await insert('fleet_worker_launches',{...scope,command_id:start,launch_id:launch,runner_session_id:runner,executor_credential_id:s.credential,authority_epoch:i.epoch,request:{fixture:'DECLARED_HISTORY'},request_digest:pin,state:'COMPLETED',result,result_digest:sha(result),result_signature:sign(null,Buffer.from(canonical(result)),s.key).toString('base64url'),completed_at:timestamp},['request','result']);
 await insert('runner_control_commands',{...scope,command_id:control,action:'runner.stop',launch_id:launch,slot_id:slot,sandbox_id:s.sandbox,boot_id:s.boot,boot_generation:1,attempt_id:attempt,attempt_generation:n,authority_epoch:i.epoch,fence_sequence:1,policy:{grace_ms:0,drain_deadline_ms:1000,on_drain_deadline:'STOP'},required_outputs:[],request_digest:pin,issued_by_credential_id:issuer,issued_at:timestamp,state:reported?'REPORTED':'ISSUED',...(reported?{outcome:'STOPPED',termination:'CONFIRMED',cleanup_complete:true,report:{fixture:'DECLARED_HISTORY'},report_digest:pin}: {})},['policy','required_outputs','report']);
 await insert('runner_workspaces',{...scope,sandbox_id:s.sandbox,boot_generation:1,slot_id:slot,slot_generation:1,state:'LEASED',launch_id:launch,registered_by_credential_id:s.runnerCredential});
 return {s,n,slot,attempt,session,runner,start,launch,control,result};
}
const operation=(v,phase='STOP')=>fleetCompletionNativeOperation({kind:'FLEET_COMPLETION_NATIVE_V1',phase,organisation_id:i.organisation,run_id:v.s.run,launch_id:v.launch,command_id:v.control});
async function unresolved(v,phase='STOP'){await insert('provider_remote_operations',{organisation_id:i.organisation,run_id:v.s.run,id:operation(v,phase),session_id:v.runner,sandbox_id:v.s.sandbox,boot_generation:1,request_digest:pin,runner_binding_evidence_digest:pin,operation:{fixture:'DECLARED_UNRESOLVED_METADATA'},state:'UNKNOWN'},['operation']);}
const next=(s,selected)=>resources.gateway.withPrimaryTransaction({timeoutMs:10000},tx=>nextFleetCompletion(tx,s.principal,selected));
try{
 const formats=await seed(async()=>{const s=await scenario();return [await completed(s),await completed(s,{exit:1,registry_launch:true}),await completed(s,{exit:-1,state:'STOPPED',registry_launch:true}),await completed(s,{exit:-1,state:'LEASE_EXPIRED',registry_launch:true})];});
 for(const [index,v]of formats.entries()){const target=await next(v.s,{command_id:v.control,launch_id:v.launch,session_id:v.runner});check(['nullable-registry-launch','failed-exit','stopped-minus-one','expired-minus-one'][index],target?.phase==='STOP'&&target.launch_id===v.launch&&target.command_id===v.control&&target.binding.launch_id===v.launch);}
 const invalid=await seed(async()=>completed(await scenario(),{exit:-1,state:'RUNNING'}));let denied=false;try{await next(invalid.s,{command_id:invalid.control,launch_id:invalid.launch,session_id:invalid.runner});}catch(error){denied=error.code==='FLEET_COMPLETION_RESULT_INVALID';}check('invalid-negative-exit-refused',denied);
 const blocked=await seed(async()=>{const s=await scenario();return {s,old:await completed(s,{reported:true}),later:await completed(s,{exit:2})};});
 check('unarchived-reported-row-does-not-hide-later-stop',(await next(blocked.s))?.launch_id===blocked.later.launch);
 const queue=await seed(async()=>{const s=await scenario(),unknown=[],eligible=[];for(let n=0;n<101;n++){const v=await completed(s);await unresolved(v);unknown.push(v);}for(let n=0;n<130;n++)eligible.push(await completed(s));return {s,unknown,eligible};});
 check('first-hundred-retained-operations-not-reexecuted',await next(queue.s)===null);
 const selected=[];
 for(let n=0;n<130;n++){const target=await next(queue.s);check('sustained-fifo-'+n,target?.launch_id===queue.eligible[n].launch);selected.push(target.launch_id);await seed(async()=>{await unresolved(queue.eligible[n]);await completed(queue.s);});}
 check('sustained-arrivals-do-not-skip-existing-work',new Set(selected).size===130&&selected.every((v,n)=>v===queue.eligible[n].launch));
 const signature=await seed(async()=>{const v=await completed(await scenario());await client.query('UPDATE hyperfide.fleet_worker_launches SET result_signature=$4 WHERE organisation_id=$1 AND run_id=$2 AND launch_id=$3',[i.organisation,v.s.run,v.launch,Buffer.alloc(64).toString('base64url')]);return v;});
 denied=false;try{await next(signature.s);}catch(error){denied=error.code==='FLEET_COMPLETION_RESULT_INVALID';}check('real-ed25519-signature-required',denied);
 const release=await seed(async()=>{
  const releaseScenario=await scenario(),v=await completed(releaseScenario,{reported:true,issuer:releaseScenario.coordinator}),scope={organisation_id:i.organisation,run_id:v.s.run},repository=randomUUID(),custody=randomUUID(),archive=randomUUID(),receipt=randomUUID();
  await insert('repositories',{organisation_id:i.organisation,id:repository,project_id:i.project,name:'queue-'+repository,url:'https://example.invalid/declared-queue-metadata'});
  await insert('source_objects',{organisation_id:i.organisation,repository_id:repository,object_id:'3'.repeat(40),object_type:'commit'});
  await insert('run_repositories',{...scope,repository_id:repository,source_object_id:'3'.repeat(40),integration_ref:'refs/heads/fixture'});
  await insert('submission_custodies',{...scope,id:custody,task_id:v.s.task,source_attempt_id:v.attempt,source_generation:v.n,custody_generation:1,authority_epoch:i.epoch,repository_id:repository,source_object_id:'3'.repeat(40),source_manifest_digest:pin,evidence_manifest_digest:pin,criteria_digest:pin});
  for(const id of [archive,receipt])await insert('artifacts',{...scope,id,digest:sha(id),size_bytes:0,storage_backend:'s3-v1',storage_key:'declared-queue-metadata/'+id,status:'COMPLETE',completed_at:'2026-01-01T00:00:00Z'});
  await insert('fleet_source_archive_custodies',{...scope,id:randomUUID(),custody_id:custody,custody_generation:1,task_id:v.s.task,attempt_id:v.attempt,attempt_generation:v.n,sandbox_id:v.s.sandbox,boot_id:v.s.boot,boot_generation:1,slot_id:v.slot,slot_generation:1,session_id:v.session,workspace_id:randomUUID(),launch_id:v.launch,command_id:v.control,producer_operation_id:randomUUID(),archive_artifact_id:archive,capture_receipt_artifact_id:receipt,archive_artifact_digest:sha(archive),capture_receipt_artifact_digest:sha(receipt),archive_digest:pin,archive_size_bytes:1,inventory_digest:pin,baseline_source_revision:'DECLARED_METADATA',source_manifest_digest:pin,binding:{fixture:'DECLARED_HISTORY'},capture_receipt:{fixture:'DECLARED_HISTORY'},registration_operation_id:randomUUID(),registration_payload_digest:pin,captured_at:'2026-01-01T00:00:01Z'},['binding','capture_receipt']);
  await unresolved(v,'RELEASE');return {...v,receipt};
 });
 check('retained-release-not-automatically-reexecuted',await next(release.s)===null);
 const selection={command_id:release.control,launch_id:release.launch,session_id:release.runner},exact=await next(release.s,selection);
 check('manual-coordinator-stop-selected-release',exact?.phase==='RELEASE'&&exact.command_id===release.control&&exact.launch_id===release.launch&&exact.operation_id===operation(release,'RELEASE'));
 for(const field of ['command_id','launch_id','session_id'])check('selected-release-wrong-'+field,await next(release.s,{...selection,[field]:randomUUID()})===null);
 check('selected-release-cross-run-refused',await next(blocked.s,selection)===null);
 await seed(async()=>client.query("UPDATE hyperfide.artifacts SET status='QUARANTINED',state_version=state_version+1 WHERE organisation_id=$1 AND run_id=$2 AND id=$3",[i.organisation,release.s.run,release.receipt]));
 check('selected-release-needs-complete-archive-evidence',await next(release.s,selection)===null);
 const dist=fileURLToPath(new URL('dist/runner/fleet_completion.js',runtimeRoot));
 const report={status:'PASS',scope:'migrated-postgresql-completion-queue-and-signature-contract',runtime_qualification:false,dist_sha256:sha(await fs.readFile(dist)),checks};
 await fs.mkdir('build/fleet/integration',{recursive:true});await fs.writeFile('build/fleet/integration/completion-queue-receipt.json',JSON.stringify(report,null,2)+'\n');
 process.stdout.write(JSON.stringify({status:report.status,scope:report.scope,checks:checks.length})+'\n');
}finally{await resources.close();await client.end();}
