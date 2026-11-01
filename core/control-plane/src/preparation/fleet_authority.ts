import {lockRun} from '../events/outbox.js';
import {closeExpiredFailedInstallAllocation} from './fleet_failed_allocation.js';
import {proveInstallNotStarted} from './fleet_not_started.js';
import {proveInstallPreProviderRefusal} from './fleet_pre_provider_refusal.js';
import {readBootstrapInstallAllocationEpoch} from './fleet_install_lineage.js';
import {verifyFleetTransfer} from './fleet_transfer.js';
import path from 'node:path';
import {createPublicKey, verify} from 'node:crypto';
import {runnerCanonical, runnerResultSigningBytes} from '../runner/bridge.js';
import {verifyPreparationReceipt} from '../runner/preparation_receipts.js';
import type {Component, ComponentContext} from '../components/registry.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {assertPrimaryTransaction} from '../storage/transactions.js';
import type {InvocationContext} from '../transport/protocol.js';
import {assertInvocation, DIGEST, exact, fail, hash, strictJSON, uuid, decimal} from '../transport/protocol.js';
import {object,FoundationError} from '../policy/programme.js';
import {publishVerifiedFleetReadiness} from './fleet_readiness.js';
import {fleetConfigurationTargets,type FleetConfiguration} from './fleet_configurations.js';
import {canonicalJSON} from './manifests.js';
import {ContractError,parseNeron, parsePackage, scopeContains} from '../contracts/fleet/index.mjs';
import {assertFleetActor, localProcessIdentity, withAdmittedDecision} from '../agents/fleet_authority.js';

type RecordValue = Record<string, any>;
const digest = (value: unknown): string => hash(canonicalJSON(value));
const stages = ['bootstrap-preflight','authority-resolution','plan-resolution','source-preparation','toolchain-preparation','dependency-preparation','configuration-preparation','interface-preparation','readiness-probes'];
const receiptKeys = ['schema_version','kind','operation_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','authority_epoch','admission_digest','package_digest','source_config_digest','plan_digest','source_revision','source_manifest_digest','prepared_root','stages','source_files','toolchains','dependencies','configurations','interfaces','probes','slots','completed_at','receipt_digest'];
const scoped = (i: InvocationContext) => [i.principal.organisation_id, i.principal.run_id];
function invalid(message: string): never { return fail('FLEET_INSTALL_INVALID', message); }
function records(value: unknown, maximum = 10000): RecordValue[] {
 if (!Array.isArray(value) || value.length > maximum || value.some(item => !object(item))) invalid('Bounded object list required');
 return value as RecordValue[];
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value) && !/^sha256:0{64}$/.test(value);
const same = (a: unknown,b: unknown): boolean => canonicalJSON(a) === canonicalJSON(b);
function boundedText(value: unknown, maximum = 4096): value is string {return typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=maximum&&!/[\x00-\x1f\x7f]/.test(value);}
function absolute(value:unknown):value is string {return boundedText(value)&&String(value).startsWith('/')&&!String(value).includes('\\')&&String(value).split('/').slice(1).every(part=>part&&part!=='.'&&part!=='..');}
function relative(value:unknown):value is string {return boundedText(value)&&!String(value).startsWith('/')&&!String(value).includes('\\')&&!/^[A-Za-z]:/.test(String(value))&&String(value).split('/').every(part=>part&&part!=='.'&&part!=='..');}
function named(rows: RecordValue[], name: string): RecordValue {
 const found = rows.filter(row => row.name === name);
 if (found.length !== 1) invalid('Required evidence missing or duplicated');
 return found[0]!;
}
function unique(rows:RecordValue[], key:string):void {if(new Set(rows.map(row=>row[key])).size!==rows.length)invalid('Duplicate evidence identity');}
async function databaseNow(tx:PrimaryTransaction):Promise<number>{const row=(await tx.query('SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS now_ms')).rows[0];const value=Number(row?.now_ms);if(!Number.isFinite(value))fail('FLEET_INSTALL_CLOCK','Primary clock unavailable');return value;}
async function currentBoot(tx: PrimaryTransaction, i: InvocationContext, binding: RecordValue): Promise<void> {
 const rows = await tx.query(`SELECT r.authority_epoch FROM hyperfide.runs r
 JOIN hyperfide.sandboxes s ON s.organisation_id=r.organisation_id AND s.id=$3
 JOIN hyperfide.sandbox_boots b ON b.organisation_id=s.organisation_id AND b.sandbox_id=s.id AND b.boot_generation=s.boot_generation
 WHERE r.organisation_id=$1 AND r.id=$2 AND r.state='RUNNING' AND r.authority_epoch=$4
 AND s.observed_state='RUNNING' AND s.desired_state='RUNNING' AND b.boot_id=$5 AND b.boot_generation=$6 FOR SHARE OF r,s,b`,
 [...scoped(i), binding.sandbox_id, binding.authority_epoch, binding.boot_id, binding.boot_generation]);
 if (rows.rowCount !== 1) fail('FLEET_INSTALL_STALE','Install belongs to a superseded run or sandbox boot');
}
async function currentEnvironmentIdentity(tx:PrimaryTransaction,i:InvocationContext,a:RecordValue,p:RecordValue):Promise<void>{
 const actual=(await tx.query(`SELECT s.preparation_digest,e.content_digest,e.runtime_platform,e.manifest FROM hyperfide.sandboxes s JOIN hyperfide.provider_pools pool ON pool.organisation_id=s.organisation_id AND pool.id=s.pool_id JOIN hyperfide.environment_profiles e ON e.organisation_id=pool.organisation_id AND e.id=pool.profile_id WHERE s.organisation_id=$1 AND s.id=$2 AND s.boot_generation=$3 FOR SHARE OF s,pool,e`,[i.principal.organisation_id,a.sandbox_id,a.boot_generation])).rows[0];
 if(!actual||actual.preparation_digest!==actual.content_digest||!object(actual.manifest)||!object(actual.manifest.profile)||!object(actual.manifest.profile.image)||!validDigest(actual.manifest.profile.image.digest)||typeof actual.runtime_platform!=='string')fail('FLEET_INSTALL_IMAGE_EVIDENCE_REQUIRED','Current boot requires a full pinned image identity from its accepted pool profile; tags and preparation hashes are insufficient');
 if(actual.runtime_platform!==p.environment.platform||actual.manifest.profile.image.digest!==p.environment.image_digest)fail('FLEET_INSTALL_ENVIRONMENT_MISMATCH','Package platform or runtime base image differs from the current accepted pool profile');
}
async function currentOwner(tx:PrimaryTransaction,i:InvocationContext,row:RecordValue):Promise<void>{
 const owner=(await tx.query(`SELECT c.controller_identity FROM hyperfide.feature_packages p
 JOIN hyperfide.hierarchy_packages h ON h.organisation_id=p.organisation_id AND h.run_id=p.run_id AND h.package_id=p.id
 JOIN hyperfide.hierarchy_leaders l ON l.organisation_id=p.organisation_id AND l.run_id=p.run_id
 JOIN hyperfide.fleet_delegations d ON d.organisation_id=p.organisation_id AND d.run_id=p.run_id AND d.package_id=p.id
 JOIN hyperfide.fleet_cohorts c ON c.organisation_id=p.organisation_id AND c.run_id=p.run_id AND c.id=$7
 JOIN hyperfide.fleet_actor_sessions a ON a.organisation_id=p.organisation_id AND a.run_id=p.run_id AND a.session_id=$4
 WHERE p.organisation_id=$1 AND p.run_id=$2 AND p.id=$3
 AND p.manager_session_id=$4 AND h.owner_generation=$5 AND h.state IN('ASSIGNED','ACTIVE','BLOCKED','CLOSING')
 AND d.manager_session_id=$4 AND d.manager_generation=$5 AND d.leader_generation=$6
 AND l.generation=$6 AND l.authority_epoch=$9
 AND c.leader_generation=$6 AND c.authority_epoch=$9 AND c.cohort_generation=$8
 AND a.actor_role='WAVE_MANAGER' AND a.delegation_id=p.id AND a.manager_generation=$5
 AND a.cohort_id=$7 AND a.cohort_generation=$8 FOR SHARE OF p,h,l,d,c,a`,[...scoped(i),row.package_id,row.manager_session_id,row.manager_generation,row.leader_generation,row.cohort_id,row.cohort_generation,row.authority_epoch])).rows[0];
 if(!owner)fail('FLEET_INSTALL_STALE_OWNER','Install delegation, manager or supervisory cohort was superseded');
 let actual;try{actual=localProcessIdentity(Number(owner.controller_identity.pid));}catch{fail('FLEET_INSTALL_STALE_OWNER','Supervisory controller is unavailable');}
 if(!same(actual,owner.controller_identity)||actual.kernel_boot_id!==localProcessIdentity().kernel_boot_id)fail('FLEET_INSTALL_STALE_OWNER','Supervisory controller identity changed');
}
function runner(i: InvocationContext, admission: RecordValue): void {
 const p = i.principal;
 if (p.role !== 'RUNNER' || p.sandbox_id !== admission.sandbox_id || p.boot_id !== admission.boot_id || p.boot_generation !== admission.boot_generation)
  fail('FLEET_INSTALL_SCOPE','Only the admitted sandbox runner may install or report readiness');
}
function validateSlotBindings(value:unknown,count:number):RecordValue[]{
 const bindings=records(value,1024);if(bindings.length!==count)invalid('Install slot mapping coverage differs');
 const ids=new Set<string>(),ordinals=new Set<number>();
 for(const item of bindings){exact(item,Object.hasOwn(item,'uid')?['slot','worker_slot_id','uid','gid','slot_generation','source','home','build','temporary','dirty','worker_root']:['slot','worker_slot_id']);if(typeof item.slot!=='number'||!Number.isSafeInteger(item.slot)||item.slot<0||item.slot>=count||!uuid(item.worker_slot_id)||ids.has(item.worker_slot_id)||ordinals.has(item.slot))invalid('Install slot mapping has invalid or duplicate identity');ids.add(item.worker_slot_id);ordinals.add(item.slot);}
 return bindings;
}
async function deriveSlotBindings(tx:PrimaryTransaction,i:InvocationContext,a:RecordValue,p:RecordValue,selection:unknown):Promise<RecordValue[]>{
 const chosen=validateSlotBindings(selection,p.workers.slots);for(const item of chosen)exact(item,['slot','worker_slot_id']);
 const rows=(await tx.query(`SELECT r.slot_id::text,r.uid,r.gid,r.slot_generation::text,r.workspace_path,r.home_path,r.tmp_path,s.capacity_kind FROM hyperfide.runner_registry r JOIN hyperfide.worker_slots s ON s.organisation_id=r.organisation_id AND s.id=r.slot_id WHERE r.organisation_id=$1 AND r.run_id=$2 AND r.sandbox_id=$3 AND r.boot_id=$4 AND r.boot_generation=$5 AND r.state IN('PREPARING','CURRENT') FOR SHARE OF r,s`,[...scoped(i),a.sandbox_id,a.boot_id,a.boot_generation])).rows;
 const prep=rows.filter(r=>r.capacity_kind==='PREPARATION');if(!prep.length)invalid('Actual enrolled preparation identity required');
 const uids=new Set<number>(),gids=new Set<number>(),result:RecordValue[]=[];
 for(const item of chosen){const enrolled=rows.filter(r=>r.slot_id===item.worker_slot_id&&r.capacity_kind==='AGENT');if(enrolled.length!==1)invalid('Exactly one enrolled worker identity required');const r=enrolled[0];if(!r)invalid('Enrolled identity unavailable');
  if(!Number.isSafeInteger(r.uid)||r.uid<1||r.uid>2147483647||!Number.isSafeInteger(r.gid)||r.gid<1||r.gid>2147483647||uids.has(r.uid)||gids.has(r.gid)||prep.some(x=>x.uid===r.uid||x.gid===r.gid))invalid('Workers require distinct nonroot identities separate from preparation');uids.add(r.uid);gids.add(r.gid);
  const b:RecordValue={...item,uid:r.uid,gid:r.gid,slot_generation:r.slot_generation};for(const name of ['source','home','build','temporary','dirty'])b[name]=p.workers[name+'_template'].replace('{slot}',String(item.slot));
  b.worker_root=path.dirname(b.source);if(!absolute(b.worker_root)||!b.worker_root.startsWith(p.environment.root+'/')||['source','home','build','temporary','dirty'].some(name=>path.dirname(b[name])!==b.worker_root)||r.workspace_path!==b.source||r.home_path!==b.home||r.tmp_path!==b.temporary)invalid('Worker template paths differ from actual enrolled private view');
  result.push(b);
 }
 return result;
}
async function currentSlots(tx:PrimaryTransaction,i:InvocationContext,a:RecordValue,count:number,readyOnly:boolean):Promise<void>{
 const bindings=validateSlotBindings(a.slot_bindings,count),ids=bindings.map(item=>item.worker_slot_id);
 if(new Set(bindings.map(b=>b.uid)).size!==count||new Set(bindings.map(b=>b.gid)).size!==count)fail('FLEET_INSTALL_SLOT_STALE','Worker UNIX identities must remain distinct');
 const slots=await tx.query('SELECT id::text,state,capacity_kind FROM hyperfide.worker_slots WHERE organisation_id=$1 AND sandbox_id=$2 AND boot_generation=$3 AND id=ANY($4::uuid[]) FOR SHARE',[i.principal.organisation_id,a.sandbox_id,a.boot_generation,ids]);
 if(slots.rowCount!==ids.length||slots.rows.some(slot=>slot.capacity_kind!=='AGENT'||!(readyOnly?['READY']:['READY','ALLOCATED']).includes(slot.state)))fail('FLEET_INSTALL_SLOT_STALE','Installed slot mapping does not name current compatible agent slots');
 const enrolled=(await tx.query("SELECT slot_id::text,uid,gid,slot_generation::text,workspace_path,home_path,tmp_path FROM hyperfide.runner_registry WHERE organisation_id=$1 AND run_id=$2 AND sandbox_id=$3 AND boot_id=$4 AND boot_generation=$5 AND state=ANY($7::text[]) AND slot_id=ANY($6::uuid[]) FOR SHARE",[...scoped(i),a.sandbox_id,a.boot_id,a.boot_generation,ids,readyOnly?['PREPARING','CURRENT']:['CURRENT']])).rows;
 for(const b of bindings){const matches=enrolled.filter(r=>r.slot_id===b.worker_slot_id);if(matches.length!==1)fail('FLEET_INSTALL_SLOT_STALE','Current enrolled worker identity required');const r=matches[0];if(!r||r.uid!==b.uid||r.gid!==b.gid||r.slot_generation!==b.slot_generation||r.workspace_path!==b.source||r.home_path!==b.home||r.tmp_path!==b.temporary)fail('FLEET_INSTALL_SLOT_STALE','Enrolled worker identity or private roots changed');}

}
async function load(tx: PrimaryTransaction, i: InvocationContext, operation: unknown, ownerRequired=true): Promise<RecordValue> {
 if (!uuid(operation)) invalid('Install operation UUID required');
 const row = (await tx.query(`SELECT e.*,s.package_spec,s.source_config,s.install_plan FROM hyperfide.fleet_environment_installs e
 JOIN hyperfide.fleet_environment_specs s USING(organisation_id,run_id,input_digest)
 WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.operation_id=$3 FOR UPDATE OF e`, [...scoped(i),operation])).rows[0];
 if (!row) fail('FLEET_INSTALL_NOT_FOUND','Install operation is not admitted');
 const head=(await tx.query('SELECT current_operation_id FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2 AND environment_id=$3 AND environment_generation=$4 AND sandbox_id=$5 AND boot_id=$6 AND boot_generation=$7 FOR SHARE',[...scoped(i),row.environment_id,row.environment_generation,row.sandbox_id,row.boot_id,row.boot_generation])).rows[0];
 if(!head||head.current_operation_id!==row.operation_id)fail('FLEET_INSTALL_SUPERSEDED','Install execution is not the current admitted environment head');
 const adoption=(await tx.query('SELECT * FROM hyperfide.fleet_install_adoptions WHERE organisation_id=$1 AND run_id=$2 AND install_operation_id=$3 ORDER BY adoption_sequence DESC LIMIT 1',[...scoped(i),operation])).rows[0];
 row.adoption_id=adoption?.adoption_id??null;
 if(adoption)for(const key of ['manager_session_id','manager_generation','leader_generation','cohort_id','cohort_generation'])row[key]=adoption[key];
 await currentBoot(tx,i,row);await currentEnvironmentIdentity(tx,i,row,row.package_spec);if(ownerRequired)await currentOwner(tx,i,row);await currentSlots(tx,i,row.admission,row.package_spec.workers.slots,row.state!=='READY');
 return row;
}
function validateSourceFiles(value:unknown,p:RecordValue,n:RecordValue):RecordValue[]{
 const rows=records(value),metadataOnly=n.client.mode==='api_only';
 if(metadataOnly){if(rows.length||Object.keys(p).some(key=>key.startsWith('mount.')||key.startsWith('dependency.')))invalid('Metadata-only environments cannot declare source inventory, mounts or dependencies');return rows;}
 if(!rows.length)invalid('Pinned source inventory is required');
 const seen=new Set<string>();let bytes=0;
 for(const entry of rows){exact(entry,['mount','path','digest','size','mode']);const mount=p['mount.'+entry.mount];
  if(!boundedText(entry.mount,64)||!mount||!relative(entry.path)||!validDigest(entry.digest)||typeof entry.size!=='number'||!Number.isSafeInteger(entry.size)||entry.size<0||typeof entry.mode!=='string'||!['100644','100755'].includes(entry.mode)||!scopeContains(n.workspace.read_scope,entry.path)||!scopeContains(mount.paths,entry.path))invalid('Source inventory differs from admitted mount scope');
  if(entry.path==='.neron'||seen.has(entry.mount+':'+entry.path))invalid('Reserved or duplicate source inventory path');seen.add(entry.mount+':'+entry.path);bytes+=entry.size;
 }
 if(bytes>64*1024*1024)invalid('Pinned source inventory exceeds prerequisite byte bound');
 return rows;
}
function validatePlan(value:unknown,p:RecordValue,n:RecordValue,identity:RecordValue):RecordValue{
 exact(value,['schema_version','kind','package_digest','source_config_digest','source_manifest_digest','runtime_files','configuration_versions','interface_fragment_digest','interface_publication_digest','interface_proof_digest','interface_consumer_id','source_files']);
 const plan=value as RecordValue;
 if(plan.schema_version!==1||plan.kind!=='hyperfide.fleet-install-plan')invalid('Versioned install plan required');
 for(const key of ['package_digest','source_config_digest','source_manifest_digest'])if(plan[key]!==identity[key])invalid('Install plan differs from registered package/source');
 for(const key of ['interface_fragment_digest','interface_publication_digest','interface_proof_digest'])if(!validDigest(plan[key]))invalid('Pinned interface fragment, publication and membership proof required');
 if(typeof plan.interface_consumer_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(plan.interface_consumer_id))invalid('Pinned interface consumer identity required');
 const runtime=records(plan.runtime_files,128);if(!runtime.length)invalid('Pinned runtime inventory required');unique(runtime,'path');
 for(const entry of runtime){exact(entry,['path','digest']);if(!absolute(entry.path)||!validDigest(entry.digest))invalid('Runtime artifact identity invalid');}
 const configurations=records(plan.configuration_versions,128);unique(configurations,'name');
 const names=Object.keys(p).filter(name=>name.startsWith('configuration.')).map(name=>name.slice(14));
 if(configurations.length!==names.length)invalid('Resolved configuration inventory differs');
 for(const name of names){const config=p['configuration.'+name],pin=named(configurations,name);
  exact(pin,config.kind==='secret-ref'?['name','reference','version']:['name','reference','version','digest']);
  if(pin.reference!==config.reference||!boundedText(pin.version,255)||config.kind!=='secret-ref'&&!validDigest(pin.digest)||config.kind==='secret-ref'&&!decimal(pin.version,true))invalid('Configuration version or provenance invalid');
 }
 validateSourceFiles(plan.source_files,p,n);return plan;
}
function verifyReceipt(receipt: unknown, row: RecordValue, now:number): RecordValue {
 exact(receipt,object(receipt)&&'transfer' in receipt?[...receiptKeys,'transfer']:receiptKeys);
 const r = receipt as RecordValue, a = row.admission as RecordValue, p = row.package_spec as RecordValue, plan=row.install_plan as RecordValue;
 if('transfer' in r)verifyFleetTransfer(r.transfer,r.operation_id);
 const {receipt_digest: supplied, ...body} = r;
 if (r.schema_version !== 1 || r.kind !== 'hyperfide.fleet-install-receipt' || supplied !== digest(body)||Buffer.byteLength(canonicalJSON(r))>2*1024*1024) invalid('Receipt digest, size or schema differs');
 for (const key of ['operation_id','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','authority_epoch','admission_digest','package_digest','source_config_digest','plan_digest','source_revision','source_manifest_digest']) if (r[key] !== a[key]) invalid('Receipt differs from admitted inputs');
 if (r.prepared_root !== p.environment.root || typeof r.completed_at!=='string'||!Number.isFinite(Date.parse(r.completed_at))||new Date(r.completed_at).toISOString()!==r.completed_at||Date.parse(r.completed_at)>now+5000||Date.parse(r.completed_at)<new Date(row.created_at).getTime()-5000) invalid('Prepared root or completion time differs');
 const stageRows = records(r.stages,stages.length), probes = records(r.probes,128);unique(stageRows,'name');unique(probes,'name');
 if(stageRows.length!==stages.length)invalid('Install stage coverage differs');
 for (const name of stages) {const s = named(stageRows,name);exact(s,['name','status','evidence_digest']);if (s.status !== (name==='readiness-probes'?'DEFERRED':'PASS') || !validDigest(s.evidence_digest)) invalid('Required install stage failed');}
 const probeNames=p.readiness.require_probes as string[];if(probes.length!==0)invalid('Prepared receipts defer all probes to native worker readiness');
 const tools=records(r.toolchains,128),dependencies=records(r.dependencies,128),configurations=records(r.configurations,128);unique(tools,'name');unique(dependencies,'name');unique(configurations,'name');
 if(tools.length!==Object.keys(p).filter(k=>k.startsWith('toolchain.')).length||dependencies.length!==Object.keys(p).filter(k=>k.startsWith('dependency.')).length)invalid('Toolchain/dependency inventory differs');
 for (const [section, expected] of Object.entries(p) as [string,RecordValue][]) {
  if (section.startsWith('toolchain.')) {const actual = named(tools,section.slice(10));exact(actual,['name','version','executable','digest']);if (actual.version !== expected.version || actual.executable !== expected.executable || actual.digest !== expected.artifact_digest) invalid('Toolchain identity differs');}
  if (section.startsWith('dependency.')) {const actual = named(dependencies,section.slice(11));exact(actual,['name','manager','version','lockfile_digest','selection','closure_digest']);if (actual.manager !== expected.manager || actual.version !== expected.version || actual.lockfile_digest !== expected.lockfile_digest || !same(actual.selection,expected.include) || !validDigest(actual.closure_digest)) invalid('Dependency identity differs');}
  if (section.startsWith('configuration.') && expected.required) named(configurations,section.slice(14));
 }
 for(const actual of configurations){const expectedConfig=p['configuration.'+actual.name];const privateConfig=expectedConfig&&(expectedConfig.kind==='secret-ref'||expectedConfig.mode!=='0444');exact(actual,privateConfig?['name','reference','version','target','mode','slots']:['name','reference','version','target','mode']);if(!boundedText(actual.name,64))invalid('Configuration name invalid');const expected=p['configuration.'+actual.name],pin=named(records(plan.configuration_versions,128),actual.name);if(!expected||actual.reference!==expected.reference||actual.target!==expected.target||actual.mode!==expected.mode||actual.version!==pin.version)invalid('Configuration identity or pinned version differs');if(privateConfig&&!same(actual.slots,fleetConfigurationTargets(expected as FleetConfiguration,a.slot_bindings)))invalid('Private configuration worker targets differ from admission');}
 exact(r.interfaces,['catalogue_digest','source_revision','selected_ids','fragment_digest','publication_digest','proof_digest','consumer_id','consumer_digest']);
 const consumer={kind:'hyperfide.fleet-interface-consumer',consumer_id:plan.interface_consumer_id,package_digest:a.package_digest,source_revision:p.interfaces.source_revision,selected_ids:p.interfaces.selected_ids};
 if(r.interfaces.publication_digest!==plan.interface_publication_digest||r.interfaces.proof_digest!==plan.interface_proof_digest||r.interfaces.consumer_id!==plan.interface_consumer_id||r.interfaces.consumer_digest!==digest(consumer))invalid('Interface publication membership or consumer provenance differs');
 if (r.interfaces.catalogue_digest !== p.interfaces.catalogue_digest || r.interfaces.source_revision !== p.interfaces.source_revision || !same(r.interfaces.selected_ids,p.interfaces.selected_ids) || r.interfaces.fragment_digest!==plan.interface_fragment_digest) invalid('Interface provenance differs');
 const slots = records(r.slots,1024);
 if (slots.length !== p.workers.slots || new Set(slots.map(s=>s.slot)).size !== slots.length) invalid('Worker slot coverage differs');
 for (const slot of slots) {exact(slot,['slot','worker_slot_id','source','home','build','temporary','dirty','dependency_inventory_digest','source_config_digest']);if(!validDigest(slot.dependency_inventory_digest)||!validDigest(slot.source_config_digest))invalid('Worker dependency or effective source configuration digest missing');if (typeof slot.slot!=='number' || !Number.isSafeInteger(slot.slot) || slot.slot < 0 || slot.slot >= p.workers.slots) invalid('Worker slot identity differs');const pinned=validateSlotBindings(a.slot_bindings,p.workers.slots).find(binding=>binding.slot===slot.slot);if(!pinned||slot.worker_slot_id!==pinned.worker_slot_id)invalid('Worker physical slot differs from admitted mapping');for (const name of ['source','home','build','temporary','dirty']) if (slot[name] !== p.workers[name+'_template'].replace('{slot}',String(slot.slot))) invalid('Worker roots differ');}
 const sources=validateSourceFiles(r.source_files,p,row.source_config);const ordered=(items:RecordValue[])=>[...items].sort((x,y)=>(x.mount+':'+x.path).localeCompare(y.mount+':'+y.path));
 if(!same(ordered(sources),ordered(plan.source_files)))invalid('Prepared source inventory differs from pinned plan');
 const evidence=[{runtime_files:plan.runtime_files,installer:p.bootstrap},{admission_digest:a.admission_digest},{plan_digest:a.plan_digest,source_manifest_digest:a.source_manifest_digest},{source_revision:a.source_revision,entries:sources.map(({path,digest,mode,size})=>({path,digest,mode,size}))},tools,dependencies,configurations,r.interfaces,{status:'DEFERRED_TO_NATIVE_READINESS',required_probes:probeNames}];
 for(const [index,name]of stages.entries())if(named(stageRows,name).evidence_digest!==digest(evidence[index]))invalid('Install stage evidence is not bound to receipt content');
 return r;
}
function verifyIsolationEvidence(value:unknown,row:RecordValue,receipt:RecordValue):void{
 exact(value,['schema_version','operation_id','prepared_receipt_digest','environment_id','environment_generation','input_digest','method','status','slots']);
 if(value.schema_version!==1||value.operation_id!==row.operation_id||value.prepared_receipt_digest!==receipt.receipt_digest||value.environment_id!==row.environment_id||String(value.environment_generation)!==String(row.environment_generation)||value.input_digest!==row.input_digest||value.method!=='UNIX_UID_GID'||value.status!=='ENFORCED'||!same(value.slots,row.admission.slot_bindings)||receipt.prepared_root!==row.admission.environment_root)invalid('Native isolation evidence differs from admitted identities and prepared receipt');
}
async function signedPreparationJob(tx:PrimaryTransaction,i:InvocationContext,operation:string,planDigest:string,resultDigest?:string):Promise<RecordValue>{
 const job=(await tx.query(`SELECT j.*,p.public_key_b64 FROM hyperfide.runner_remote_jobs j
 LEFT JOIN hyperfide.identity_principals p ON p.credential_id=j.executor_credential_id
 WHERE j.organisation_id=$1 AND j.run_id=$2 AND j.operation_id=$3 FOR SHARE OF j`,[...scoped(i),operation])).rows[0];
 if(!job||job.state!=='COMPLETED'||job.job_class!=='PREPARATION'||job.plan_digest!==planDigest||resultDigest!==undefined&&job.result_digest!==resultDigest||!object(job.plan)||!object(job.result)||hash(runnerCanonical(job.plan))!==job.plan_digest||hash(runnerCanonical(job.result))!==job.result_digest||typeof job.public_key_b64!=='string'||typeof job.result_signature!=='string')invalid('Completed immutable signed preparation execution required');
 const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(job.public_key_b64,'base64url')]),format:'der',type:'spki'});
 if(!verify(null,runnerResultSigningBytes(job.organisation_id,job.run_id,job.operation_id,job.plan_digest,job.result_digest),key,Buffer.from(job.result_signature,'base64url')))invalid('Execution result signature differs');
 return job;
}
export function validateFleetInstallRecovery(value:unknown):RecordValue{
 if(object(value)&&value.kind==='PRE_PROVIDER_REFUSAL'){exact(value,['kind','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','proof_id','proof_digest']);if(!uuid(value.install_operation_id)||!uuid(value.runner_operation_id)||value.install_operation_id!==value.runner_operation_id||!uuid(value.proof_id)||!validDigest(value.admission_digest)||!validDigest(value.runner_plan_digest)||!validDigest(value.proof_digest))invalid('Exact retained pre-provider refusal proof required');return value;}
 if(object(value)&&value.kind==='NOT_STARTED'){exact(value,['kind','install_operation_id','admission_digest','runner_operation_id','runner_plan_digest']);if(!uuid(value.install_operation_id)||!uuid(value.runner_operation_id)||value.install_operation_id!==value.runner_operation_id||!validDigest(value.admission_digest)||!validDigest(value.runner_plan_digest))invalid('Exact expired unclaimed install recovery required');return value;}
 exact(value,['install_operation_id','admission_digest','runner_operation_id','runner_plan_digest','quiescence_operation_id','quiescence_receipt_digest']);
 if(!uuid(value.install_operation_id)||!uuid(value.runner_operation_id)||!uuid(value.quiescence_operation_id)||!validDigest(value.admission_digest)||!validDigest(value.runner_plan_digest)||!validDigest(value.quiescence_receipt_digest)||value.runner_operation_id!==value.quiescence_operation_id)invalid('Exact failed-install recovery binding required');return value;
}
async function recoveryPredecessor(tx:PrimaryTransaction,i:InvocationContext,value:unknown,next:RecordValue,packageId:string|null):Promise<{binding:RecordValue;install:RecordValue;job:RecordValue;logical_operation_id:string;native_logical_operation_id:string;proof?:RecordValue;fresh_allocation_epoch?:true}>{
 const binding=validateFleetInstallRecovery(value),old=await load(tx,i,binding.install_operation_id,false);
 if(old.state!=='ADMITTED'||old.package_id!==packageId||old.admission_digest!==binding.admission_digest)fail('FLEET_INSTALL_RECOVERY_DENIED','Only the failed current install of this delegation may be recovered');
 for(const key of ['input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation'])if(String(old[key])!==String(next[key]))fail('FLEET_INSTALL_RECOVERY_DENIED','Recovery cannot change environment, source inputs or physical boot');
 if(binding.kind==='PRE_PROVIDER_REFUSAL'){const {job,proof}=await proveInstallPreProviderRefusal(tx,i,binding,old),lineage=await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:old.operation_id});return {binding,install:old,job,proof,logical_operation_id:lineage.logical_operation_id,native_logical_operation_id:old.operation_id};}
 if(binding.kind==='NOT_STARTED'){if(new Date(old.expires_at).getTime()>await databaseNow(tx))fail('FLEET_INSTALL_NOT_STARTED_UNPROVEN','Original install admission has not expired');const {job,proof}=await proveInstallNotStarted(tx,i,binding,old),lineage=await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:old.operation_id});return {binding,install:old,job,proof,logical_operation_id:lineage.logical_operation_id,native_logical_operation_id:old.operation_id};}
 const job=await signedPreparationJob(tx,i,binding.runner_operation_id,binding.runner_plan_digest),result=job.result,plan=job.plan;
 if(job.authority_epoch!==old.authority_epoch||plan.preparation_request?.job_binding?.namespace!=='FLEET_INSTALL'||plan.preparation_request.job_binding.job_id!==old.operation_id||plan.preparation_request.job_binding.input_packet_digest!==old.admission_digest||plan.binding?.sandbox_id!==old.sandbox_id||plan.binding?.boot_id!==old.boot_id||String(plan.binding?.boot_generation)!==String(old.boot_generation)||result.outcome!=='FAILED'||result.cleanup?.complete!==true||result.cleanup?.observed_process_absent!==true||result.cleanup_status!=='CONFIRMED'||result.cleanup.receipt_digest!==binding.quiescence_receipt_digest||result.native_receipt?.digest!==binding.quiescence_receipt_digest)fail('FLEET_INSTALL_RECOVERY_NOT_QUIESCENT','A signed completed FAILED execution with confirmed native quiescence is required; uncertain outcomes cannot be retried');
 const artifact=(await tx.query("SELECT content_digest FROM hyperfide.runner_result_artifacts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND role='native_receipt' FOR SHARE",[...scoped(i),job.operation_id])).rows[0];
 if(!artifact||artifact.content_digest!==binding.quiescence_receipt_digest)fail('FLEET_INSTALL_RECOVERY_NOT_QUIESCENT','Retained native quiescence capture required');
 const allocation=(await tx.query(`SELECT a.* FROM hyperfide.resource_job_allocations a JOIN hyperfide.reservations r ON r.organisation_id=a.organisation_id AND r.run_id=a.run_id AND r.id=a.reservation_id WHERE a.organisation_id=$1 AND a.run_id=$2 AND a.id=$3 AND a.state='ACTIVE' AND a.job_kind='PREPARATION' AND r.state='ALLOCATED' AND r.expires_at>clock_timestamp() FOR SHARE OF a,r`,[...scoped(i),plan.allocation?.allocation_id])).rows[0];
 let fresh: {fresh_allocation_epoch:true}|undefined;
 if(!allocation)fresh=await closeExpiredFailedInstallAllocation(tx,i,binding,old,job);
 else if(allocation.reservation_id!==job.reservation_id||allocation.sandbox_id!==old.sandbox_id||String(allocation.sandbox_boot_generation)!==String(old.boot_generation)||allocation.slot_id!==plan.binding.slot_id||allocation.assignee_session_id!==job.session_id)fail('FLEET_INSTALL_RECOVERY_ALLOCATION','Recovery requires the actual current preparation allocation and reservation');
 const lineage=await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:old.operation_id});return {binding,install:old,job,logical_operation_id:lineage.logical_operation_id,native_logical_operation_id:old.admission.logical_operation_id??old.operation_id,...fresh};
}
export interface FleetInstallExecutionProof {runner_operation_id:string;runner_plan_digest:string;runner_result_digest:string;stdout_base64:string;native_receipt_base64:string}
export async function completeVerifiedFleetInstallExecution(tx:PrimaryTransaction,i:InvocationContext,proof:FleetInstallExecutionProof):Promise<Record<string,unknown>>{
 return completeFleetInstallExecution(tx,i,proof,false);
}
export async function completeCollectedFleetInstallExecution(tx:PrimaryTransaction,i:InvocationContext,proof:FleetInstallExecutionProof):Promise<Record<string,unknown>>{
 if(!['COORDINATOR','OPERATOR'].includes(i.principal.role))fail('FLEET_INSTALL_SCOPE','Programme collection authority required');
 return completeFleetInstallExecution(tx,i,proof,true);
}
async function completeFleetInstallExecution(tx:PrimaryTransaction,i:InvocationContext,proof:FleetInstallExecutionProof,collectionOnly:boolean):Promise<Record<string,unknown>>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 exact(proof,['runner_operation_id','runner_plan_digest','runner_result_digest','stdout_base64','native_receipt_base64']);
 if(!['FEATURE_MANAGER','COORDINATOR','OPERATOR'].includes(i.principal.role)||!uuid(proof.runner_operation_id)||!validDigest(proof.runner_plan_digest)||!validDigest(proof.runner_result_digest))fail('FLEET_INSTALL_SCOPE','Trusted manager or coordinator execution completion required');
 const job=await signedPreparationJob(tx,i,proof.runner_operation_id,proof.runner_plan_digest,proof.runner_result_digest);
 const plan=job.plan as RecordValue,result=job.result as RecordValue,request=plan.request,binding=plan.binding,preparation=plan.preparation_request;
 if(!object(request)||!object(binding)||!object(preparation)||!object(preparation.job_binding)||preparation.job_binding.namespace!=='FLEET_INSTALL')invalid('Fleet install preparation binding required');
 const row=await load(tx,i,preparation.job_binding.job_id);
 if(String(preparation.job_binding.lease_generation)!==String(row.environment_generation)||preparation.job_binding.input_packet_digest!==row.admission_digest||preparation.job_binding.reservation_id!==job.reservation_id||!object(preparation.source)||preparation.source.repository_key!==row.source_config.source.repository||preparation.source.source_object_id!==row.admission.source_revision.slice(4)||preparation.source.source_manifest_digest!==row.admission.source_manifest_digest)invalid('Preparation authority and source pins differ from install admission');
 if(i.principal.role==='FEATURE_MANAGER'&&i.principal.actor_id!==row.manager_session_id)fail('FLEET_INSTALL_SCOPE','Current owning manager required');
 if(job.authority_epoch!==row.authority_epoch||binding.sandbox_id!==row.sandbox_id||binding.boot_id!==row.boot_id||String(binding.boot_generation)!==String(row.boot_generation)||result.outcome!=='SUCCEEDED'||result.exit_code!==0||result.output_complete!==true||result.stdout?.complete!==true||result.cleanup?.complete!==true)invalid('Execution does not prove successful preparation of the admitted boot');
 const decode=(value:unknown,reference:unknown,maximum:number):Buffer=>{
  if(typeof value!=='string'||value.length>Math.ceil(maximum/3)*4||!object(reference))invalid('Bounded captured bytes required');
  const bytes=Buffer.from(value,'base64');if(bytes.length>maximum||bytes.toString('base64')!==value||hash(bytes)!==reference.digest||String(bytes.length)!==String(reference.size_bytes))invalid('Captured bytes differ from committed result');return bytes;
 };
 const stdout=decode(proof.stdout_base64,result.stdout,2097152),native=decode(proof.native_receipt_base64,result.native_receipt,1048576);
 if(!Array.isArray(request.argv)||request.argv.some(arg=>typeof arg!=='string')||typeof request.executable_digest!=='string'||typeof binding.workspace_path!=='string'||typeof binding.uid!=='number'||typeof binding.gid!=='number')invalid('Committed native execution inputs required');
 const verified=verifyPreparationReceipt(native,{operation_id:job.operation_id,plan_digest:job.plan_digest,argv:request.argv,executable_digest:request.executable_digest,workspace_path:binding.workspace_path,uid:binding.uid,gid:binding.gid});
 const nativeReceipt=verified.receipt as RecordValue;
 if(nativeReceipt.exit_code!==0||nativeReceipt.stdout?.digest!==hash(stdout)||nativeReceipt.stdout?.base64!==proof.stdout_base64||nativeReceipt.stdout?.complete!==true)invalid('Native capture chain differs from installer stdout');
 const output=strictJSON(stdout,2097152);if(!object(output)||output.state!=='PREPARED'||!object(output.receipt))invalid('Installer PREPARED output required');
 exact(output,['state','receipt']);const receipt=verifyReceipt(output.receipt,row,await databaseNow(tx));
 // Collection may be delayed; execution must still have completed inside its original lease.
 const nativeStarted=Date.parse(nativeReceipt.started_at),nativeEnded=Date.parse(nativeReceipt.ended_at),preparedAt=Date.parse(receipt.completed_at),admittedAt=new Date(row.created_at).getTime(),expiresAt=new Date(row.expires_at).getTime();
 if(![nativeStarted,nativeEnded,preparedAt,admittedAt,expiresAt].every(Number.isFinite)||nativeStarted<admittedAt-5000||nativeEnded<nativeStarted||nativeEnded>expiresAt||preparedAt<nativeStarted||preparedAt>nativeEnded)
  fail('FLEET_INSTALL_EXPIRED','Verified native preparation must finish within the original install admission');
 if(receipt.transfer&&canonicalJSON(receipt.transfer.native_stage)!==canonicalJSON(verified.stage.artifact_transfer??null))invalid('Installer transfer differs from authenticated native capture');
 verifyIsolationEvidence(nativeReceipt.fleet_isolation,row,receipt);
 await publishVerifiedFleetReadiness(tx,i,{install:row,receipt,nativeReceipt,job});
 await currentSlots(tx,i,row.admission,row.package_spec.workers.slots,false);
 if(row.admission.slot_bindings.some((b:RecordValue)=>b.uid===binding.uid||b.gid===binding.gid))invalid('Preparation identity must differ from every worker identity');
 if(row.state==='READY'){if(row.receipt_digest!==receipt.receipt_digest)fail('FLEET_INSTALL_CONFLICT','A different receipt already completed this operation');return {state:'READY',logical_operation_id:(await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:row.operation_id})).logical_operation_id,receipt:row.receipt,receipt_digest:row.receipt_digest,readiness_witnesses:await readinessWitnesses(tx,i,row.operation_id)};}
 if(!collectionOnly&&new Date(row.expires_at).getTime()<=await databaseNow(tx))fail('FLEET_INSTALL_EXPIRED','Install lease expired before readiness publication');
 const done=await tx.query("UPDATE hyperfide.fleet_environment_installs SET state='READY',receipt=$4,receipt_digest=$5,completed_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND state='ADMITTED' AND expires_at>=$6::timestamptz RETURNING operation_id",[...scoped(i),row.operation_id,JSON.stringify(receipt),receipt.receipt_digest,nativeReceipt.ended_at]);
 if(done.rowCount!==1)fail('FLEET_INSTALL_EXPIRED','Install lease expired before readiness publication');
 return {state:'READY',logical_operation_id:(await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:row.operation_id})).logical_operation_id,receipt,receipt_digest:receipt.receipt_digest,readiness_witnesses:await readinessWitnesses(tx,i,row.operation_id)};
}
async function readinessWitnesses(tx:PrimaryTransaction,i:InvocationContext,operation:string):Promise<RecordValue[]>{
 const rows=(await tx.query('SELECT slot_id::text,readiness_digest,measurement_digest,runner_result_digest FROM hyperfide.fleet_runtime_readiness WHERE organisation_id=$1 AND run_id=$2 AND install_operation_id=$3 ORDER BY slot_id',[...scoped(i),operation])).rows;
 if(!rows.length)fail('FLEET_INSTALL_NOT_READY','Native readiness witnesses are unavailable');return rows;
}
/** Read retained inputs for capture collection only; this does not authorize execution. */
export async function fleetInstallCollectionInputs(tx:PrimaryTransaction,i:InvocationContext,operation_id:string):Promise<Record<string,unknown>>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(!['COORDINATOR','OPERATOR'].includes(i.principal.role))fail('FLEET_INSTALL_SCOPE','Programme collection authority required');
 const row=await load(tx,i,operation_id);
 const lineage=await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:row.operation_id});
 return {admission:row.admission,...lineage,package_spec:row.package_spec,source_config:row.source_config,install_plan:row.install_plan};
}
export async function fleetInstallDeliveryInputs(tx:PrimaryTransaction,i:InvocationContext,operation_id:string):Promise<Record<string,unknown>>{
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 if(!['COORDINATOR','OPERATOR'].includes(i.principal.role))fail('FLEET_INSTALL_SCOPE','Programme delivery authority required');
 const row=await load(tx,i,operation_id);
 if(row.state!=='READY'&&new Date(row.expires_at).getTime()<=await databaseNow(tx))fail('FLEET_INSTALL_EXPIRED','Install lease expired');
 const lineage=await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:row.operation_id});
 return {admission:row.admission,...lineage,package_spec:row.package_spec,source_config:row.source_config,install_plan:row.install_plan};
}
export interface ReadyFleetInstallBinding {operation_id:string;environment_id:string;environment_generation:number;sandbox_id:string;boot_id:string;boot_generation:string;input_digest:string;}
export async function readReadyFleetInstall(tx:PrimaryTransaction,i:InvocationContext,binding:ReadyFleetInstallBinding):Promise<RecordValue> {
 assertPrimaryTransaction(tx);assertInvocation(i);await i.guard(tx);
 const row = await load(tx,i,binding.operation_id);
 for (const key of ['environment_id','environment_generation','sandbox_id','boot_id','boot_generation','input_digest'] as const) if (String(row[key]) !== String(binding[key])) fail('FLEET_INSTALL_SCOPE','Environment binding differs');
 if(i.principal.role==='RUNNER')runner(i,row.admission);
 else if(i.principal.role==='FEATURE_MANAGER'){if(i.principal.actor_id!==row.manager_session_id)fail('FLEET_INSTALL_SCOPE','Manager does not own this install');}
 else fail('FLEET_INSTALL_SCOPE','Current owning manager or bound runner required');
 if (row.state !== 'READY') fail('FLEET_INSTALL_NOT_READY','Environment preparation has not completed');
 return {logical_operation_id:(await readBootstrapInstallAllocationEpoch(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,operation_id:row.operation_id})).logical_operation_id,receipt:row.receipt,receipt_digest:row.receipt_digest,readiness_witnesses:await readinessWitnesses(tx,i,row.operation_id),manifest_digest:row.admission.package_digest,source_revision:row.admission.source_revision,input_digest:row.input_digest,package_id:row.package_id,manager_generation:String(row.manager_generation),read_scope:row.source_config.workspace.read_scope,write_scope:row.source_config.workspace.write_scope};
}
export function createComponent(ctx:ComponentContext):Component {
 const transact = <T>(i:InvocationContext,fn:(tx:PrimaryTransaction)=>Promise<T>,exclusiveRun=false) => ctx.resources.gateway.withPrimaryTransaction({signal:i.signal,guard:async tx=>{if(exclusiveRun)await lockRun(tx,{organisation_id:i.principal.organisation_id,run_id:i.principal.run_id},'exclusive');await i.guard(tx);},timeoutMs:5000},fn);
 const guard = (fn:(input:unknown,i:InvocationContext)=>Promise<unknown>) => async(input:unknown,request:ComponentContext) => { assertInvocation(request.invocation); return fn(input,request.invocation); };
 const component:Component={apiVersion:1,actions:{
  'fleet.install.register':guard(async(input,i)=>{
   if (!['OPERATOR','COORDINATOR'].includes(i.principal.role)) fail('FLEET_INSTALL_SCOPE','Only programme authority registers executable environment plans');
   exact(input,['package_kvx','source_config_kvx','source_manifest_digest','plan_digest','install_plan']);
   if (typeof input.package_kvx !== 'string' || typeof input.source_config_kvx !== 'string' || Buffer.byteLength(input.package_kvx)+Buffer.byteLength(input.source_config_kvx)>524288 || !validDigest(input.source_manifest_digest) || !validDigest(input.plan_digest)) invalid('Bounded pinned environment inputs required');
   let n:ReturnType<typeof parseNeron>,p:ReturnType<typeof parsePackage>;
   try { n=parseNeron(input.source_config_kvx);p=parsePackage(input.package_kvx,{neron:n}); }
   catch(error){if(error instanceof ContractError)throw new FoundationError(error.code,error.message);throw error;}
   const package_digest = digest(p), source_config_digest = digest(n);
   if (p.source.config_digest !== source_config_digest || n.source.source_backend !== 'git' || !uuid(n.source.repository)) invalid('Pinned registered Git repository and source configuration required');
   const identity = {package_digest,source_config_digest,source_manifest_digest:input.source_manifest_digest,plan_digest:input.plan_digest}, input_digest = digest(identity);
   const plan=validatePlan(input.install_plan,p,n,identity);
   if(digest(plan)!==input.plan_digest||Buffer.byteLength(canonicalJSON(plan))>2*1024*1024)invalid('Install plan digest or size differs');
   return transact(i,async tx=>{
    const repository = await tx.query('SELECT repository_id FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 AND repository_id=$3 AND source_object_id=$4 FOR SHARE',[...scoped(i),n.source.repository,n.source.revision.slice(4)]);
    if (repository.rowCount !== 1) fail('FLEET_INSTALL_SOURCE','Source is not the run accepted repository revision');
    await tx.query('INSERT INTO hyperfide.fleet_environment_specs(organisation_id,run_id,input_digest,package_digest,source_config_digest,source_manifest_digest,plan_digest,package_spec,source_config,install_plan,registered_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING',[...scoped(i),input_digest,package_digest,source_config_digest,input.source_manifest_digest,input.plan_digest,JSON.stringify(p),JSON.stringify(n),JSON.stringify(plan),i.principal.actor_id]);
    return {input_digest,...identity};
   });
  }),
  'fleet.install.admit':guard(async(input,i)=>{
   exact(input,['decision']);
   return transact(i,tx=>withAdmittedDecision(tx,i,input.decision,'fleet.install.admit',async decision=>{
    if (decision.actor_role !== 'WAVE_MANAGER') fail('FLEET_INSTALL_SCOPE','Wave Manager decision required');
    const owner = await assertFleetActor(tx,i,decision), v = decision.input as RecordValue;
    exact(v,['input_digest','environment_id','environment_generation','sandbox_id','boot_id','boot_generation','ttl_seconds','slot_bindings',...(Object.hasOwn(v,'recovery_of')?['recovery_of']:[])]);
    if (!validDigest(v.input_digest) || !uuid(v.sandbox_id) || !uuid(v.boot_id) || !decimal(v.boot_generation,true) || !positive(v.environment_generation) || !positive(v.ttl_seconds) || v.ttl_seconds>3600) invalid('Environment identity or install lease invalid');
    const spec = (await tx.query('SELECT * FROM hyperfide.fleet_environment_specs WHERE organisation_id=$1 AND run_id=$2 AND input_digest=$3 FOR SHARE',[...scoped(i),v.input_digest])).rows[0];
    if (!spec) fail('FLEET_INSTALL_UNREGISTERED','Executable environment plan has not been registered');
    const p=spec.package_spec,n=spec.source_config;const slot_bindings=await deriveSlotBindings(tx,i,v,p,v.slot_bindings);
    if (v.environment_id!==p.environment.environment_id || v.environment_generation!==p.environment.environment_generation || n.workspace.authority_epoch!==decision.authority_epoch||decision.source_revision!==n.source.revision) invalid('Environment source, generation or authority epoch differs from plan');
    const sandbox=(await tx.query(`SELECT s.id FROM hyperfide.sandboxes s WHERE s.organisation_id=$1 AND s.id=$3
     AND EXISTS(SELECT 1 FROM hyperfide.fleet_effect_receipts e WHERE e.organisation_id=$1 AND e.run_id=$2 AND e.result->>'delegation_id'=$4 AND e.result->>'sandbox_id'=s.id::text AND e.result->>'kind' IN('PROVISION_SANDBOX','REUSE_SANDBOX')) FOR SHARE OF s`,[...scoped(i),v.sandbox_id,owner.package_id])).rows[0];
    if(!sandbox)fail('FLEET_INSTALL_SCOPE','Sandbox has no admitted provisioning/reuse effect in this delegation');
    const cohort=(await tx.query('SELECT cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...scoped(i),owner.cohort_id])).rows[0];if(!cohort)fail('FLEET_INSTALL_STALE_OWNER','Supervisory cohort unavailable');
    const recovery=Object.hasOwn(v,'recovery_of')?await recoveryPredecessor(tx,i,v.recovery_of,v,owner.package_id):null;
    if(recovery&&(!same(recovery.install.admission.slot_bindings,slot_bindings)||recovery.install.operation_id===decision.operation_id||recovery.binding.runner_operation_id===decision.operation_id))fail('FLEET_INSTALL_RECOVERY_DENIED','Recovery requires a new execution identity and the exact previous enrolled worker mapping');
    const prior = (await tx.query('SELECT current_operation_id FROM hyperfide.fleet_install_heads WHERE organisation_id=$1 AND run_id=$2 AND environment_id=$3 AND environment_generation=$4 AND sandbox_id=$5 AND boot_id=$6 AND boot_generation=$7 FOR UPDATE',[...scoped(i),v.environment_id,v.environment_generation,v.sandbox_id,v.boot_id,v.boot_generation])).rows[0];
    if(recovery?prior?.current_operation_id!==recovery.install.operation_id:!!prior)fail('FLEET_INSTALL_CONFLICT','Environment head changed or already exists');
    const now=await databaseNow(tx);
    const admission:RecordValue={schema_version:1,kind:'hyperfide.fleet-install-admission',environment_root:p.environment.root,operation_id:decision.operation_id,logical_operation_id:recovery&&!recovery.proof?recovery.native_logical_operation_id:decision.operation_id,...(recovery&&!recovery.proof?{recovery_of:recovery.binding}:{}),organisation_id:i.principal.organisation_id,run_id:i.principal.run_id,environment_id:v.environment_id,environment_generation:v.environment_generation,sandbox_id:v.sandbox_id,boot_id:v.boot_id,boot_generation:v.boot_generation,authority_epoch:decision.authority_epoch,input_digest:v.input_digest,package_digest:spec.package_digest,source_config_digest:spec.source_config_digest,plan_digest:spec.plan_digest,source_revision:n.source.revision,source_manifest_digest:spec.source_manifest_digest,read_scope:n.workspace.read_scope,write_scope:n.workspace.write_scope,slot_bindings,expires_at:new Date(now+v.ttl_seconds*1000).toISOString()};
    await currentBoot(tx,i,admission);await currentEnvironmentIdentity(tx,i,admission,p);await currentSlots(tx,i,admission,p.workers.slots,true);admission.admission_digest=digest(admission);
    await tx.query('INSERT INTO hyperfide.fleet_environment_installs(organisation_id,run_id,operation_id,input_digest,environment_id,environment_generation,sandbox_id,boot_id,boot_generation,authority_epoch,package_id,manager_session_id,manager_generation,leader_generation,cohort_id,cohort_generation,admission,admission_digest,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)',[...scoped(i),decision.operation_id,v.input_digest,v.environment_id,v.environment_generation,v.sandbox_id,v.boot_id,v.boot_generation,decision.authority_epoch,owner.package_id,decision.actor_id,owner.manager_generation,decision.leader_generation,owner.cohort_id,cohort.cohort_generation,JSON.stringify(admission),admission.admission_digest,admission.expires_at]);
    if(recovery){
     if(recovery.proof){
      if(recovery.binding.kind==='PRE_PROVIDER_REFUSAL')await tx.query('INSERT INTO hyperfide.fleet_install_pre_provider_recoveries(organisation_id,run_id,operation_id,predecessor_install_operation_id,logical_operation_id,proof_id,decision_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...scoped(i),decision.operation_id,recovery.install.operation_id,recovery.logical_operation_id,recovery.proof.id,decision.decision_id]);
      else await tx.query('INSERT INTO hyperfide.fleet_install_not_started_recoveries(organisation_id,run_id,operation_id,predecessor_install_operation_id,logical_operation_id,proof_id,decision_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...scoped(i),decision.operation_id,recovery.install.operation_id,recovery.logical_operation_id,recovery.proof.id,decision.decision_id]);
     }
     else await tx.query('INSERT INTO hyperfide.fleet_install_recoveries(organisation_id,run_id,operation_id,predecessor_install_operation_id,logical_operation_id,predecessor_admission_digest,runner_operation_id,runner_plan_digest,runner_result_digest,quiescence_operation_id,quiescence_receipt_digest,decision_id,allocation_epoch_operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[...scoped(i),decision.operation_id,recovery.install.operation_id,recovery.logical_operation_id,recovery.binding.admission_digest,recovery.binding.runner_operation_id,recovery.binding.runner_plan_digest,recovery.job.result_digest,recovery.binding.quiescence_operation_id,recovery.binding.quiescence_receipt_digest,decision.decision_id,recovery.fresh_allocation_epoch?decision.operation_id:null]);
     const advanced=await tx.query('UPDATE hyperfide.fleet_install_heads SET current_operation_id=$5,updated_at=clock_timestamp() WHERE organisation_id=$1 AND run_id=$2 AND environment_id=$3 AND environment_generation=$4 AND current_operation_id=$6 AND sandbox_id=$7 AND boot_id=$8 AND boot_generation=$9 RETURNING current_operation_id',[...scoped(i),v.environment_id,v.environment_generation,decision.operation_id,recovery.install.operation_id,v.sandbox_id,v.boot_id,v.boot_generation]);if(advanced.rowCount!==1)fail('FLEET_INSTALL_CONFLICT','Recovery predecessor was superseded');
    }else{
     const created=await tx.query('INSERT INTO hyperfide.fleet_install_heads(organisation_id,run_id,environment_id,environment_generation,logical_operation_id,current_operation_id,sandbox_id,boot_id,boot_generation) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING current_operation_id',[...scoped(i),v.environment_id,v.environment_generation,decision.operation_id,v.sandbox_id,v.boot_id,v.boot_generation]);if(created.rowCount!==1)fail('FLEET_INSTALL_CONFLICT','Environment head already admitted');
    }
    return {admission,state:'ADMITTED'};
   }),true);
  }),
  'fleet.install.adopt':guard(async(input,i)=>{
   exact(input,['decision']);return transact(i,tx=>withAdmittedDecision(tx,i,input.decision,'fleet.install.adopt',async decision=>{
    if(decision.actor_role!=='WAVE_MANAGER')fail('FLEET_INSTALL_SCOPE','Current Wave Manager adoption decision required');
    const v=decision.input;exact(v,['install_operation_id','previous_adoption_id','admission_digest','receipt_digest','input_digest','handoff_id','runner_operation_id','runner_result_digest']);
    if(!uuid(v.install_operation_id)||v.previous_adoption_id!==null&&!uuid(v.previous_adoption_id)||!validDigest(v.admission_digest)||!validDigest(v.input_digest)||v.receipt_digest!==null&&!validDigest(v.receipt_digest)||v.handoff_id!==null&&!uuid(v.handoff_id)||v.runner_operation_id!==null&&!uuid(v.runner_operation_id)||v.runner_result_digest!==null&&!validDigest(v.runner_result_digest))invalid('Exact pinned adoption identities required');
    const row=await load(tx,i,v.install_operation_id,false);
    if(row.authority_epoch!==decision.authority_epoch||row.package_id!==decision.delegation_id||row.admission.source_revision!==decision.source_revision||row.adoption_id!==v.previous_adoption_id||row.admission_digest!==v.admission_digest||row.input_digest!==v.input_digest||row.receipt_digest!==v.receipt_digest)fail('FLEET_INSTALL_ADOPTION_STALE','Historical install pins or adoption predecessor differ');
    const owner=await assertFleetActor(tx,i,decision),cohort=(await tx.query('SELECT cohort_generation::text FROM hyperfide.fleet_cohorts WHERE organisation_id=$1 AND run_id=$2 AND id=$3 FOR SHARE',[...scoped(i),owner.cohort_id])).rows[0];
    if(!cohort)fail('FLEET_INSTALL_STALE_OWNER','Current cohort unavailable');
    if(row.manager_session_id===decision.actor_id&&String(row.manager_generation)===decision.manager_generation&&String(row.leader_generation)===decision.leader_generation&&row.cohort_id===owner.cohort_id&&String(row.cohort_generation)===cohort.cohort_generation)fail('FLEET_INSTALL_ADOPTION_UNNECESSARY','Install already belongs to this current owner');
    if(row.manager_session_id!==decision.actor_id||String(row.manager_generation)!==decision.manager_generation){
     if(!v.handoff_id)invalid('Acknowledged hierarchy handoff required for manager replacement');
     const handoff=(await tx.query(`SELECT h.package_snapshot FROM hyperfide.hierarchy_handoffs h JOIN hyperfide.hierarchy_handoff_acknowledgements a ON a.organisation_id=h.organisation_id AND a.run_id=h.run_id AND a.handoff_id=h.id WHERE h.organisation_id=$1 AND h.run_id=$2 AND h.id=$3 AND h.predecessor_id=$4 AND h.successor_id=$5 AND h.authority_epoch=$6 FOR SHARE OF h,a`,[...scoped(i),v.handoff_id,row.manager_session_id,decision.actor_id,decision.authority_epoch])).rows[0];
     if(!handoff||!Array.isArray(handoff.package_snapshot)||!handoff.package_snapshot.some((p:RecordValue)=>p.package_id===row.package_id&&String(p.owner_generation)===String(row.manager_generation)))fail('FLEET_INSTALL_HANDOFF_REQUIRED','Acknowledged handoff does not cover previous install owner');
    }else if(v.handoff_id!==null)invalid('Cohort-only adoption does not accept an unrelated handoff');
    if(row.state==='ADMITTED'){
     if(!v.runner_operation_id||!v.runner_result_digest)invalid('Outstanding install requires a reconciled completed execution');
     const jobs=await tx.query(`SELECT operation_id,state,result_digest,result,plan,plan_digest FROM hyperfide.runner_remote_jobs WHERE organisation_id=$1 AND run_id=$2 AND job_class='PREPARATION' AND plan->'preparation_request'->'job_binding'->>'namespace'='FLEET_INSTALL' AND plan->'preparation_request'->'job_binding'->>'job_id'=$3 FOR SHARE`,[...scoped(i),row.operation_id]);
     const retained=jobs.rows[0];
     if(jobs.rowCount!==1||!retained)fail('FLEET_INSTALL_RECONCILIATION_REQUIRED','Exactly one retained execution required');
     if(retained.operation_id!==v.runner_operation_id||retained.state!=='COMPLETED'||retained.result_digest!==v.runner_result_digest||!['SUCCEEDED','FAILED'].includes(retained.result?.outcome)||retained.plan?.preparation_request?.job_binding?.input_packet_digest!==row.admission_digest||retained.plan?.binding?.sandbox_id!==row.sandbox_id||retained.plan?.binding?.boot_id!==row.boot_id||String(retained.plan?.binding?.boot_generation)!==String(row.boot_generation))fail('FLEET_INSTALL_RECONCILIATION_REQUIRED','Only the existing completed install execution may be adopted; uncertain jobs cannot be replaced');
     const terminal=await signedPreparationJob(tx,i,retained.operation_id,retained.plan_digest,v.runner_result_digest),result=terminal.result;
     if(terminal.authority_epoch!==row.authority_epoch||!terminal.claim_id||!terminal.native_claimed_at||!terminal.completed_at||result.operation_id!==terminal.operation_id||result.cleanup_status!=='CONFIRMED'||result.cleanup?.complete!==true||result.cleanup?.observed_process_absent!==true||!validDigest(result.native_receipt?.digest)||result.cleanup?.receipt_digest!==result.native_receipt.digest)
      fail('FLEET_INSTALL_RECONCILIATION_REQUIRED','Adoption requires the original signed terminal native cleanup');
     const capture=(await tx.query("SELECT content_digest FROM hyperfide.runner_result_artifacts WHERE organisation_id=$1 AND run_id=$2 AND operation_id=$3 AND role='native_receipt' FOR SHARE",[...scoped(i),terminal.operation_id])).rows[0];
     if(!capture||capture.content_digest!==result.native_receipt.digest)fail('FLEET_INSTALL_RECONCILIATION_REQUIRED','Retained native capture is required for terminal adoption');
     if(result.outcome==='SUCCEEDED'){
      const started=Date.parse(result.started_at),ended=Date.parse(result.ended_at);
      if(!Number.isFinite(started)||!Number.isFinite(ended)||started<new Date(row.created_at).getTime()-5000||ended<started||ended>new Date(row.expires_at).getTime()||result.exit_code!==0||result.output_complete!==true)
       fail('FLEET_INSTALL_EXPIRED','Successful execution must have completed within its original admission');
     }
     // FAILED adoption transfers recovery custody only; the expired admission still cannot execute.
    }else if(v.runner_operation_id!==null||v.runner_result_digest!==null)invalid('READY adoption pins the immutable receipt directly');
    const effective={...row,manager_session_id:decision.actor_id,manager_generation:decision.manager_generation,leader_generation:decision.leader_generation,cohort_id:owner.cohort_id,cohort_generation:cohort.cohort_generation};
    await currentOwner(tx,i,effective);
    await tx.query(`INSERT INTO hyperfide.fleet_install_adoptions(organisation_id,run_id,adoption_id,install_operation_id,previous_adoption_id,admission_digest,receipt_digest,input_digest,authority_epoch,manager_session_id,manager_generation,leader_generation,cohort_id,cohort_generation,handoff_id,runner_operation_id,runner_result_digest,decision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[...scoped(i),decision.operation_id,row.operation_id,row.adoption_id,row.admission_digest,row.receipt_digest,row.input_digest,row.authority_epoch,decision.actor_id,decision.manager_generation,decision.leader_generation,owner.cohort_id,cohort.cohort_generation,v.handoff_id,v.runner_operation_id,v.runner_result_digest,decision.decision_id]);
    return {kind:'INSTALL_ADOPTED',adoption_id:decision.operation_id,install_operation_id:row.operation_id,state:row.state,receipt_digest:row.receipt_digest,admission_digest:row.admission_digest};
   }));
  }),
  'fleet.install.status':guard(async(input,i)=>{
   exact(input,['operation_id']);
   return transact(i,async tx=>{const row=await load(tx,i,input.operation_id);runner(i,row.admission);
    if (row.state!=='READY' && new Date(row.expires_at).getTime()<=await databaseNow(tx)) fail('FLEET_INSTALL_EXPIRED','Install lease expired');
    return {admission:row.admission,state:row.state,receipt:row.receipt,receipt_digest:row.receipt_digest};});
  }),
  'fleet.install.complete':guard(async(input,i)=>{
   exact(input,['operation_id','receipt','receipt_digest','isolation']);
   return transact(i,async tx=>{const row=await load(tx,i,input.operation_id);runner(i,row.admission);
    fail('FLEET_INSTALL_NATIVE_ISOLATION_REQUIRED','Readiness requires the captured completed native preparation finalizer; an asserted local isolation receipt cannot publish READY');
   });
  })
 }};
 component.capabilities={'fleet.install.v1':Object.freeze({deliveryInputs:fleetInstallDeliveryInputs,collectionInputs:fleetInstallCollectionInputs,completeCollectedExecution:completeCollectedFleetInstallExecution,completeVerifiedExecution:completeVerifiedFleetInstallExecution,adopt:async(decision:unknown,i:InvocationContext):Promise<Record<string,unknown>>=>await component.actions['fleet.install.adopt']!({decision},{...ctx,invocation:i}) as Record<string,unknown>,admit:async(decision:unknown,i:InvocationContext):Promise<Record<string,unknown>>=>await component.actions['fleet.install.admit']!({decision},{...ctx,invocation:i}) as Record<string,unknown>})};
 return component;
}
