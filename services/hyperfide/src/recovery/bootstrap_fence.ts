import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {FoundationError,object} from '../policy/programme.js';
import {hash,NAME} from '../transport/protocol.js';
import {loadIsolationPermitVerifier,type IsolationPermitClaims,type IsolationPermitExpectation,type VerifiedIsolationPermit} from '../identity/credentials.js';
import {createProviderIsolation,createDestructionPreflight,isolationConfiguration,type IsolationConfiguration} from '../providers/placement.js';
import {createProviderRuntimeRegistry,registerIsolationTransport} from '../providers/pools.js';
import {configuredRailwayIsolationTransport} from '../providers/railway/reconciliation.js';
import {createBlaxelIsolationTransport} from '../providers/blaxel/processes.js';
import {readArtifactDestructionPreflight} from '../artifacts/destruction.js';
import {createLegacyWriterAdmission,legacyWriterTopology} from '../migration/legacy.js';
import {bindProviderIsolation,createExternalWriterFence,externalFenceTopologyDigest,FileExternalFenceJournal,type ExternalFenceTopology} from './fencing.js';
import type {TransactionGateway} from '../storage/transactions.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_PERMIT_BYTES=131072;
function fail(code:string,message:string):never{throw new FoundationError(code,message);}
function canonical(value:unknown):string{
 const sorted=(v:unknown):unknown=>Array.isArray(v)?v.map(sorted):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
 return JSON.stringify(sorted(value));
}
function deploymentOf(env:Readonly<NodeJS.ProcessEnv>):string{
 const id=env.HYPERFIDE_DEPLOYMENT_ID;if(typeof id!=='string'||!UUID.test(id))fail('BOOTSTRAP_FENCE_CONFIG','Trusted deployment identity is required');return id;
}
async function privateTarget(name:string|undefined,code:string,directory:boolean):Promise<string>{
 if(!name||!path.isAbsolute(name)||path.resolve(name)!==name)fail(code,'An absolute canonical path is required');
 const info=await fs.lstat(name);
 if(info.isSymbolicLink()||(directory?!info.isDirectory():!info.isFile())||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||await fs.realpath(name)!==name)
  fail(code,'The path must be owned by the invoking user with no group or world access');
 return name;
}

export interface BootstrapTopology {topology:ExternalFenceTopology;topology_digest:string;isolation:IsolationConfiguration;consistent:boolean}
/** Derives the LIVE_PROVIDER writer topology from the protected isolation and legacy writer configuration. */
export async function bootstrapFenceTopology(env:Readonly<NodeJS.ProcessEnv>):Promise<BootstrapTopology>{
 const deployment=deploymentOf(env),isolation=await isolationConfiguration(env);
 if(isolation.deployment_id!==deployment||isolation.source_epoch!==null)fail('BOOTSTRAP_FENCE_SCOPE','Isolation configuration must name this deployment with no source epoch');
 if(isolation.evidence_scope!=='LIVE_PROVIDER')fail('EXTERNAL_FENCE_EVIDENCE_SCOPE_MISMATCH','Bootstrap activation requires live provider isolation');
 const legacy=await legacyWriterTopology(env,{deployment_id:deployment,source_epoch:null});
 const writers=isolation.resources.map(r=>r.reference_key).sort();
 if(!writers.includes(legacy.legacy_writer_id))fail('EXTERNAL_FENCE_CONFIG_INCOMPLETE','The legacy writer must be one of the configured provider resources');
 const topology:ExternalFenceTopology={schema_version:1,deployment_id:deployment,organisation_id:isolation.organisation_id,run_id:isolation.run_id,source_epoch:null,evidence_scope:'LIVE_PROVIDER',
  legacy_topology_digest:legacy.topology_digest,legacy_pid_namespace:legacy.pid_namespace,legacy_mount_namespace:legacy.mount_namespace,required_writer_ids:writers,
  resources:writers.map(key=>({reference_key:key,topology_digest:'sha256:'+'0'.repeat(64),writer_ids:[key],backend:'PROVIDER' as const}))};
 // The resource digests are excluded from the topology digest; the placeholder is replaced by it below.
 const digest=externalFenceTopologyDigest(topology);
 for(const r of topology.resources)r.topology_digest=digest;
 return {topology,topology_digest:digest,isolation,consistent:isolation.topology_digest===digest&&isolation.resources.every(r=>r.resource_topology_digest===digest)};
}
function assertConsistent(value:BootstrapTopology):void{
 if(!value.consistent)fail('EXTERNAL_FENCE_TOPOLOGY_DIGEST_MISMATCH','Isolation configuration digests differ from the derived writer topology');
}
export function isolationPermitSigningInput(keyId:string,payload:Buffer):Buffer{
 if(!NAME.test(keyId))fail('ISOLATION_PERMIT_CONFIG','A trusted issuer key id is required');
 return Buffer.from('HYPERFIDE-ISOLATION-PERMIT-V1\n'+keyId+'\n'+hash(payload)+'\n','utf8');
}
/** The canonical claims an operator signs off-box; nothing here reads a signing key. */
export async function isolationPermitPayload(env:Readonly<NodeJS.ProcessEnv>,request:{operation_id:string;key_id:string;ttl_seconds:number}):Promise<{claims:IsolationPermitClaims;payload:Buffer;signing_input:Buffer;topology_digest:string}>{
 if(!UUID.test(request.operation_id)||!Number.isSafeInteger(request.ttl_seconds)||request.ttl_seconds<60||request.ttl_seconds>3600)fail('ISOLATION_PERMIT_CONFIG','Operation id and a 60 to 3600 second lifetime are required');
 const derived=await bootstrapFenceTopology(env);assertConsistent(derived);
 const now=Date.now(),t=derived.topology;
 const claims:IsolationPermitClaims={schema_version:1,purpose:'EXTERNAL_WRITER_ISOLATION_ONLY',deployment_id:t.deployment_id,operation_id:request.operation_id,organisation_id:t.organisation_id,run_id:t.run_id,source_epoch:null,
  topology_digest:derived.topology_digest,resources:t.resources.map(r=>({reference_key:r.reference_key,topology_digest:r.topology_digest})),
  issued_at:new Date(now).toISOString(),expires_at:new Date(now+request.ttl_seconds*1000).toISOString(),nonce:randomUUID()};
 const payload=Buffer.from(canonical(claims),'utf8');
 return {claims,payload,signing_input:isolationPermitSigningInput(request.key_id,payload),topology_digest:derived.topology_digest};
}
export function sealIsolationPermit(keyId:string,payload:Buffer,signature:Buffer):string{
 if(signature.length!==64)fail('ISOLATION_PERMIT_INVALID','A raw 64-byte Ed25519 signature is required');
 isolationPermitSigningInput(keyId,payload);
 return canonical({schema_version:1,key_id:keyId,payload_b64:payload.toString('base64url'),signature_b64:signature.toString('base64url')});
}
async function readPermit(env:Readonly<NodeJS.ProcessEnv>):Promise<Buffer>{
 const name=await privateTarget(env.HYPERFIDE_ISOLATION_PERMIT_FILE,'ISOLATION_PERMIT_REQUIRED',false);
 const file=await fs.open(name,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await file.stat();if(!info.isFile()||info.size<1||info.size>MAX_PERMIT_BYTES)fail('ISOLATION_PERMIT_INVALID','A bounded signed permit envelope is required');return await file.readFile();}
 finally{await file.close();}
}
/** Verifies a signed permit against the configured public keys and the exact bootstrap scope. */
export async function verifyBootstrapPermit(env:Readonly<NodeJS.ProcessEnv>,expected:IsolationPermitExpectation,serialized?:Buffer):Promise<VerifiedIsolationPermit>{
 const verifierFile=env.HYPERFIDE_ISOLATION_PERMIT_VERIFIER_FILE;
 if(!verifierFile)fail('ISOLATION_PERMIT_CONFIG','Trusted permit verifier configuration is required');
 const verifier=await loadIsolationPermitVerifier(verifierFile),bytes=serialized??await readPermit(env);
 try{return verifier.verify(bytes,expected);}
 catch(error){
  const code=object(error)&&typeof error.code==='string'?error.code:'';
  if(code.startsWith('ISOLATION_PERMIT_'))throw error;
  fail('ISOLATION_PERMIT_INVALID','The isolation permit is not a signed canonical envelope');
 }
}
export function bootstrapPermitExpectation(derived:BootstrapTopology,operationId:string):IsolationPermitExpectation{
 const t=derived.topology;return {deployment_id:t.deployment_id,operation_id:operationId,organisation_id:t.organisation_id,run_id:t.run_id,source_epoch:null,topology_digest:derived.topology_digest};
}
export interface BootstrapFenceDependencies {
 resources:{readonly gateway:Pick<TransactionGateway,'withPrimaryTransaction'>};
 request:{deployment_id:string;operation_id:string};
 signal?:AbortSignal;
}
/** Production arguments for activateBootstrapAuthority. The permit is verified before any epoch can be minted. */
export async function createBootstrapFenceArguments(env:Readonly<NodeJS.ProcessEnv>,deps:BootstrapFenceDependencies):Promise<Parameters<typeof createExternalWriterFence>>{
 if(!object(deps)||!deps.resources?.gateway||!object(deps.request)||typeof deps.request.operation_id!=='string'||!UUID.test(deps.request.operation_id))fail('BOOTSTRAP_FENCE_CONFIG','Primary gateway and operation identity are required');
 const derived=await bootstrapFenceTopology(env);
 if(deps.request.deployment_id!==derived.topology.deployment_id)fail('BOOTSTRAP_FENCE_SCOPE','Activation names another deployment');
 assertConsistent(derived);
 const permit=await verifyBootstrapPermit(env,bootstrapPermitExpectation(derived,deps.request.operation_id));
 const journal=new FileExternalFenceJournal(await privateTarget(env.HYPERFIDE_EXTERNAL_FENCE_JOURNAL_DIR,'EXTERNAL_FENCE_JOURNAL_UNSAFE',true));
 const signal=deps.signal??new AbortController().signal,registry=createProviderRuntimeRegistry();
 registry.destructionPreflight=readArtifactDestructionPreflight;
 registerIsolationTransport(registry,'railway',scope=>configuredRailwayIsolationTransport({env},scope));
 registerIsolationTransport(registry,'blaxel',scope=>createBlaxelIsolationTransport(scope,{env,signal}));
 const gateway=deps.resources.gateway;
 const isolate=createProviderIsolation({env,signal,registry:registry.isolation,gateway,destructionPreflight:createDestructionPreflight({env,gateway,registry})});
 return [derived.topology,bindProviderIsolation({isolateConfiguredResource:isolate},permit),createLegacyWriterAdmission(env),journal,{kind:'ISOLATION_PERMIT',permit}];
}
