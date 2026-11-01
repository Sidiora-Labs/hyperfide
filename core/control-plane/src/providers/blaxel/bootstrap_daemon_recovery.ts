import path from 'node:path';
import type {ComponentContext} from '../../components/registry.js';
import {hash,strictJSON,uuid} from '../../transport/protocol.js';
import {object} from '../../policy/programme.js';
import {digestDocument,fail} from '../pools.js';
import {verifiedSandbox} from './bootstrap.js';
import type {DaemonRecoveryTransport,DaemonRecoveryBase} from '../bootstrap_daemon_recovery.js';
type Data=Record<string,any>;
function quoted(s:string):string{return "'"+s.replaceAll("'","'\\''")+"'";}
function code(process:Data):string{if(typeof process.stderr==='string'&&process.stderr.length<=16384){const match=[...process.stderr.matchAll(/^hyperfide native: ([A-Z][A-Z0-9_]{0,95})\r?$/gm)].at(-1);if(match)return match[1]!;}return 'DAEMON_RECOVERY_NATIVE_REFUSED';}
export function createBlaxelDaemonRecoveryTransport(context:ComponentContext):DaemonRecoveryTransport{
 const files=async(input:DaemonRecoveryBase,signal:AbortSignal)=>{
  const {sandbox,call}=await verifiedSandbox(context,input,signal);
  const read=async(filename:string,max=1048576)=>{const blob=await call<Blob>(()=>sandbox.fs.readBinary(filename));if(blob.size>max)fail('DAEMON_RECOVERY_FILE','Bounded original protected file required');return Buffer.from(await blob.arrayBuffer());};
  const manifestBytes=await read(input.manifest_path);if(hash(manifestBytes)!==input.manifest_digest)fail('DAEMON_RECOVERY_MANIFEST','Original bootstrap manifest changed');const manifest=strictJSON(manifestBytes);if(!object(manifest)||!object(manifest.template)||digestDocument(manifest.binding)!==digestDocument(input.binding))fail('DAEMON_RECOVERY_MANIFEST','Original bound template required');
  const root=path.join(String(manifest.template.state_root),input.binding.sandbox_id,input.binding.boot_id);return{sandbox,call,read,root,manifest,template:manifest.template};
 };
 return{
  async observeDaemon(input,signal){
   const {read,root,template}=await files(input,signal),receiptBytes=await read(path.join(root,'bootstrap-receipt.json')),configBytes=await read(path.join(root,'daemon.json')),transportBytes=await read(path.join(root,'transport.json')),stateBytes=await read(path.join(root,'daemon','daemon-state.json'));
   const receipt=strictJSON(receiptBytes),config=strictJSON(configBytes),transport=strictJSON(transportBytes),state=strictJSON(stateBytes);
   if(!object(receipt)||receipt.bootstrap_id!==input.binding.provisioning_intent_id||receipt.manifest_digest!==input.manifest_digest||digestDocument(receipt.binding)!==digestDocument(input.binding)||!object(receipt.daemon)||!object(config)||config.state_dir!==path.join(root,'daemon')||config.transport_config!==path.join(root,'transport.json')||config.organisation_id!==input.binding.organisation_id||config.preparation_digest!==input.binding.preparation_digest||!object(transport)||transport.origin!==template.origin||transport.ca_file!==template.ca_file||!uuid(transport.credential_id)||!object(state)||state.registered!==true||typeof state.state_version!=='string'||!/^\d+$/.test(state.state_version)||!object(state.pending)||state.pending.kind!=='heartbeat'||typeof state.pending.payload!=='string')fail('DAEMON_RECOVERY_STATE','Actual original registered observer files and pending heartbeat required');
   const payload=strictJSON(Buffer.from(state.pending.payload));if(!object(payload)||payload.run_id!==input.binding.run_id||!object(payload.input)||payload.input.expected_version!==state.state_version||![state.pending.operation_id,state.pending.idempotency_key,state.pending.correlation_id].every(uuid))fail('DAEMON_RECOVERY_STATE','Exact retained pending heartbeat envelope required');
   return{bootstrap_receipt_metadata_digest:digestDocument(receipt),bootstrap_receipt_digest:hash(receiptBytes),daemon_config_digest:hash(configBytes),transport_digest:hash(transportBytes),daemon_state_digest:hash(stateBytes),credential_id:transport.credential_id,previous_daemon:{pid:receipt.daemon.pid,pgid:receipt.daemon.pgid,start_time:receipt.daemon.start_time,os_boot_id:receipt.daemon.os_boot_id},pending:{kind:'heartbeat',operation_id:state.pending.operation_id,idempotency_key:state.pending.idempotency_key,correlation_id:state.pending.correlation_id,payload_digest:hash(Buffer.from(state.pending.payload)),expected_state_version:state.state_version}};
  },
  async recoverDaemon(input,signal){
   const {sandbox,call,read,root,template}=await files(input,signal),permit=strictJSON(input.recovery);
   if(!object(permit)||!uuid(permit.operation_id)||input.recovery_path!==path.join(root,'daemon-recoveries',permit.operation_id,'permit.json')||input.helper_path!==path.join('/opt/hyperfide/observer-recovery',input.helper_digest.slice(7),'hyperfide-native')||[template.state_root,template.slot_root,template.workspace_root,template.environment_root].some((protectedRoot:unknown)=>typeof protectedRoot==='string'&&(input.helper_path===protectedRoot||input.helper_path.startsWith(protectedRoot+'/')))||Array.isArray(template.files)&&template.files.some((file:Data)=>file.path===input.helper_path)||input.helper_path===input.manifest_path||input.helper_path===template.runner_binary||hash(input.recovery)!==input.recovery_digest||hash(input.helper)!==input.helper_digest)fail('DAEMON_RECOVERY_PERMIT','Exact separately pinned helper and protected permit required');
   const receiptPath=path.join(root,'daemon-recoveries',permit.operation_id,'receipt.json'),request={manifest_path:input.manifest_path,manifest_digest:input.manifest_digest,recovery_path:input.recovery_path,recovery_digest:input.recovery_digest},command=quoted(input.helper_path)+' --component 12.1 --action supervisor.daemon.recover --request-base64 '+quoted(Buffer.from(JSON.stringify(request)).toString('base64url'));
   const receipt=async()=>{try{const raw=await read(receiptPath);const parsed=strictJSON(raw);if(!object(parsed))return null;return{receipt:parsed,receipt_raw_digest:hash(raw)};}catch{return null;}};
   const observe=async(process:Data)=>{if(process.command!==command||process.name!==input.process_id)fail('DAEMON_RECOVERY_PROCESS','Retained process command differs from immutable recovery attempt');const captured=await receipt();if(captured)return{state:'COMPLETED' as const,...captured};if(['failed','killed','stopped'].includes(process.status)||process.status==='completed'&&Number.isInteger(process.exitCode)&&process.exitCode!==0)return{state:'UNKNOWN' as const,receipt:null,failure_code:code(process),process:{name:input.process_id,command_digest:hash(command),status:process.status,exit_code:process.exitCode??null}};return{state:process.status==='running'?'RUNNING' as const:'UNKNOWN' as const,receipt:null};};
   let existing:Data|null=null;try{existing=await call<Data>(s=>sandbox.process.get(input.process_id,{signal:s,retry:false}));}catch(error){if(!error||typeof error!=='object'||![(error as Data).status,(error as Data).statusCode].includes(404))throw error;}
   if(existing)return observe(existing);if(input.resume_only){const captured=await receipt();return captured?{state:'COMPLETED',...captured}:{state:'UNKNOWN',receipt:null};}
   await input.assertCurrent();await call(()=>sandbox.fs.mkdir(path.dirname(input.helper_path),'0700'));await call(()=>sandbox.fs.uploadWithMultipart(input.helper_path,new Blob([new Uint8Array(input.helper)]),'0500'));if(hash(await read(input.helper_path,16777216))!==input.helper_digest)fail('DAEMON_RECOVERY_ARTIFACT','Recovery helper provider readback differs');
   await input.assertCurrent();await call(()=>sandbox.fs.mkdir(path.dirname(input.recovery_path),'0700'));await call(()=>sandbox.fs.uploadWithMultipart(input.recovery_path,new Blob([new Uint8Array(input.recovery)]),'0600'));if(hash(await read(input.recovery_path))!==input.recovery_digest)fail('DAEMON_RECOVERY_ARTIFACT','Recovery permit provider readback differs');
   await input.markSubmitting();
   // Native owns the durable monitor; no bounded wrapper may reap the recovered daemon.
   const launched=await call<Data>(()=>sandbox.process.exec({name:input.process_id,command,workingDir:'/',waitForCompletion:false,timeout:0,keepAlive:true}));return observe(launched);
  }
 };
}
