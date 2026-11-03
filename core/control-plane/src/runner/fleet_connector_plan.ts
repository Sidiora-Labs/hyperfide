import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import type {ComponentContext} from '../components/registry.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {AuthorityTransaction} from '../transport/protocol.js';
import {fail,hash,DIGEST,strictJSON} from '../transport/protocol.js';
import {object} from '../policy/programme.js';
import {isNativeAuthAuthority} from '../identity/native_auth.js';
import type {ConnectorQualificationAuthority} from '../agents/qualification.js';
import type {AdmissionPlanSelection} from '../agents/admission.js';
import {readRunnerBinding,readRunnerReadiness} from './bridge.js';

export async function declaredFleetAgentBinding(tx:AuthorityTransaction,scope:{organisation_id:string;run_id:string;session_id:string}):Promise<Record<string,any>|null>{
 assertPrimaryTransaction(tx);
 if(!(await tx.query("SELECT to_regclass('hyperfide.fleet_runtime_readiness') IS NOT NULL AS present")).rows[0]?.present)return null;
 const rows=(await tx.query(`SELECT s.connector,s.state,s.attempt_id,s.sandbox_id,s.sandbox_boot_generation,q.boot_id,
 w.native_profile_id AS auth_profile,w.native_profile_digest AS configuration_digest,r.session_id AS runner_session_id
 FROM hyperfide.agent_sessions s JOIN hyperfide.hierarchy_worker_registrations w ON w.organisation_id=s.organisation_id AND w.run_id=s.run_id AND w.session_id=s.id
 JOIN hyperfide.runner_registry r ON r.organisation_id=s.organisation_id AND r.run_id=s.run_id AND r.sandbox_id=s.sandbox_id AND r.boot_generation=s.sandbox_boot_generation AND r.slot_id=s.slot_id AND r.state='CURRENT'
 JOIN hyperfide.fleet_runtime_readiness q ON q.organisation_id=r.organisation_id AND q.run_id=r.run_id AND q.runner_session_id=r.session_id AND q.readiness_digest=r.readiness_digest
 WHERE s.organisation_id=$1 AND s.run_id=$2 AND s.id=$3 AND s.role='WORKER' AND s.native_session_id IS NULL AND s.state='REGISTERED' FOR SHARE OF s,w,r,q`,[scope.organisation_id,scope.run_id,scope.session_id])).rows;
 if(rows.length!==1)return null;
 const row=rows[0]!,runner=await readRunnerBinding(tx,{organisation_id:scope.organisation_id,run_id:scope.run_id,session_id:row.runner_session_id});
 const readiness=await readRunnerReadiness(tx,runner);
 if(readiness.kind!=='FLEET_MANIFEST_V1')fail('FLEET_NATIVE_PLAN_UNPREPARED','A declared worker requires current measured manifest readiness');
 return {...row,connector_version:null,process_exited:false,prelaunch:true};
}

export function connectorQualification(ctx:ComponentContext):ConnectorQualificationAuthority{
 return ctx.dependencies.require('13.2','agents.connector-qualification',(v:unknown):v is ConnectorQualificationAuthority=>object(v)&&typeof v.receipt==='function'&&typeof v.qualification==='function'&&typeof v.inspect==='function'&&typeof v.publicKey==='function');
}
export function qualifiedFleetProfile(ctx:ComponentContext,id:string):Record<string,any>{
 const native=ctx.dependencies.require('14.3','identity.native-auth',isNativeAuthAuthority),profile=native.resolve(id),authority=connectorQualification(ctx),q=authority.qualification(id),record=authority.inspect(id);
 if(q.state!=='QUALIFIED'||!q.live_qualified||!record?.receipt||record.payload.profile_digest!==profile.profile_digest)return {...profile,qualification:q};
 return {...profile,qualification:q,observed_model_id:record.payload.observed_model_id,observed_provider_id:record.payload.observed_provider_id};
}

export async function deriveFleetConnectorPlan(ctx:ComponentContext,tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string;session_id:string},admission:AdmissionPlanSelection,packetDigest:string):Promise<Record<string,unknown>|null>{
 const declared=await declaredFleetAgentBinding(tx,scope);if(!declared)return null;
 const profile=qualifiedFleetProfile(ctx,admission.auth_profile),authority=connectorQualification(ctx),receipt=authority.receipt(admission.auth_profile);
 if(!receipt||profile.profile_digest!==declared.configuration_digest||profile.qualification.receipt_digest!==admission.qualification_digest)fail('FLEET_NATIVE_PLAN_UNQUALIFIED','Current signed connector qualification required');
 const runner=await readRunnerBinding(tx,{organisation_id:scope.organisation_id,run_id:scope.run_id,session_id:declared.runner_session_id}),readiness=await readRunnerReadiness(tx,runner);
 const binary=ctx.env.HF_NATIVE_CONNECTOR_PLANNER_BINARY,expected=ctx.env.HF_NATIVE_CONNECTOR_PLANNER_DIGEST;
 if(!binary||!path.isAbsolute(binary)||!expected||!DIGEST.test(expected))fail('FLEET_NATIVE_PLANNER_UNCONFIGURED','Explicit pinned native connector planner required');
 const stat=await fs.lstat(binary);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o022||stat.size>268435456||hash(await fs.readFile(binary))!==expected)fail('FLEET_NATIVE_PLANNER_DRIFT','Native planner identity differs from its trusted runtime pin');
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'hyperfide-plan-'));
 try{
  const snapshot=path.join(directory,'snapshot.json'),signed=path.join(directory,'qualification.json'),key=path.join(directory,'key.hex');
  await fs.writeFile(snapshot,JSON.stringify(profile),{mode:0o600});await fs.writeFile(signed,JSON.stringify(receipt),{mode:0o600});await fs.writeFile(key,authority.publicKey(),{mode:0o600});
  const input={connector:admission.connector,expected_version:admission.connector_version,alias:profile.configured_model_alias,auth_profile:admission.auth_profile,workspace:runner.workspace_path,home:runner.home_path,temp:runner.tmp_path,permission_mode:'workspace-write'};
  const result=await new Promise<Record<string,unknown>>((resolve,reject)=>{
   const child=spawn(binary,['--component','13.1','--action','connector.plan'],{env:{PATH:'/usr/bin:/bin',HF_NATIVE_AUTH_SNAPSHOT_FILE:snapshot,HF_CONNECTOR_QUALIFICATION_RECEIPT_FILE:signed,HF_CONNECTOR_QUALIFICATION_PUBLIC_KEY_FILE:key},stdio:['pipe','pipe','ignore'],signal:tx.signal});
   const chunks:Buffer[]=[];let size=0;const timer=setTimeout(()=>child.kill('SIGKILL'),Math.max(1,Math.min(4000,tx.remainingMs())));
   child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1048576)child.kill('SIGKILL');else chunks.push(chunk);});child.once('error',reject);
   child.once('close',code=>{clearTimeout(timer);try{const parsed=strictJSON(Buffer.concat(chunks));if(code!==0||!object(parsed)||parsed.ok!==true||!object(parsed.result))fail('FLEET_NATIVE_PLAN_REFUSED','Pinned native planner refused the qualified profile');resolve(parsed.result);}catch(error){reject(error);}});child.stdin.end(JSON.stringify(input));
  });
  if(result.dispatch_eligible!==true||result.runtime_observed!==false||result.binary_digest!==profile.binary.digest||result.profile_digest!==profile.profile_digest||result.qualification_receipt_digest!==admission.qualification_digest||result.cwd!==runner.workspace_path||result.home!==runner.home_path||result.temp!==runner.tmp_path||!Array.isArray(result.argv)||result.argv[0]!==profile.binary.path)fail('FLEET_NATIVE_PLAN_MISMATCH','Derived native plan differs from admitted profile or measured worker paths');
  if(admission.connector!=='claude')fail('FLEET_NATIVE_INPUT_UNSUPPORTED','This manifest worker transport requires the qualified Claude stream adapter');
  const packet=(await tx.query('SELECT packet FROM hyperfide.hierarchy_execution_packets WHERE organisation_id=$1 AND run_id=$2 AND digest=$3',[scope.organisation_id,scope.run_id,packetDigest])).rows;
  if(packet.length!==1)fail('FLEET_NATIVE_PACKET_MISSING','Exactly one immutable accepted task packet required');
  const sourceEffects=(await tx.query("SELECT result FROM hyperfide.fleet_effect_receipts WHERE organisation_id=$1 AND run_id=$2 AND result->>'kind'='ASSIGN_WORKER' AND result->'assignment'->>'worker_id'=$3 AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'tasks') task WHERE task->>'attempt_id'=$4)",[scope.organisation_id,scope.run_id,scope.session_id,declared.attempt_id])).rows;
  const assignment=sourceEffects.length===1?sourceEffects[0]!.result.assignment:null;
  const nativeSource=assignment?.source?.source_backend==='native'?{schema_version:1,...assignment.source,assignment_id:assignment.assignment_id,worker_principal_id:assignment.worker_id,run_id:assignment.run_id,task_id:assignment.tasks[0].task_id,attempt_id:assignment.tasks[0].attempt_id,attempt_generation:assignment.tasks[0].attempt_generation}:null;
  const content='Implement the accepted task in this immutable execution packet. Preserve its scope, criteria, and verification requirements.\n'+(nativeSource?'Use native source control through `hyperfide source invoke --request-file FILE`; HF_SOURCE_CONFIG names your assigned signed client configuration. Write a protocol_version:1 SourceRequest with scope from config.transport.scope, a stable operation_id UUID, action and input; the CLI supplies your assigned authority. Upload and checkpoint edits in the assigned workspace, then submit the durable revision with source.fleet.submit. Task qualification remains a separate coordinator step.\n':'')+JSON.stringify(packet[0]!.packet);
  if(Buffer.byteLength(content)>262144)fail('FLEET_NATIVE_INPUT_TOO_LARGE','Accepted task input exceeds the admitted stream frame bound');
  const initial=JSON.stringify({type:'user',session_id:'',parent_tool_use_id:null,message:{role:'user',content}})+'\n';
  if(Buffer.byteLength(initial)>262144)fail('FLEET_NATIVE_INPUT_TOO_LARGE','Accepted task stream frame exceeds its byte bound');
  return {...result,...(nativeSource?{native_source:nativeSource}:{}),auth_profile_snapshot:profile,initial_input_base64:Buffer.from(initial).toString('base64url'),initial_input_digest:hash(Buffer.from(initial)),initial_packet_digest:packetDigest,readiness,binding:{uid:runner.uid,gid:runner.gid,boot_id:runner.boot_id,boot_generation:runner.boot_generation,workspace_path:runner.workspace_path,home_path:runner.home_path,tmp_path:runner.tmp_path},fleet_binding:{organisation_id:scope.organisation_id,run_id:scope.run_id,sandbox_id:runner.sandbox_id,boot_id:runner.boot_id,boot_generation:runner.boot_generation,slot_id:runner.slot_id,slot_generation:runner.slot_generation,uid:runner.uid,gid:runner.gid}};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
