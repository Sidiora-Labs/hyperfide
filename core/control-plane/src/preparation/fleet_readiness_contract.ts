import path from 'node:path';
import {createHash} from 'node:crypto';
type Data=Record<string,any>;
export function fleetReadinessCanonical(value:any):string{return JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(fleetReadinessCanonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(fleetReadinessCanonical(value[k]))])):value);}
export const fleetReadinessDigest=(value:unknown):string=>'sha256:'+createHash('sha256').update(fleetReadinessCanonical(value)).digest('hex');
function refuse():never{throw Object.assign(new Error('Complete pinned manifest runtime inputs required'),{code:'FLEET_RUNTIME_INPUT_INVALID'});}
export interface FleetReadinessInput {verifier:{node_path:string;node_digest:string;module_path:string;module_digest:string};readiness_input:Data;input_digest:string;source_state_digest:string;workspace_digest:string;}
export function deriveFleetReadinessInputs(input:{admission:Data;package_spec:Data;source_config:Data;install_plan:Data;receipt:Data}):FleetReadinessInput[]{
 const {admission:a,package_spec:p,source_config:n,install_plan:plan,receipt:r}=input;
 if(!Array.isArray(a.slot_bindings)||!Array.isArray(r.slots)||!Array.isArray(plan.runtime_files)||!Array.isArray(r.source_files)||!Array.isArray(r.configurations)||!Array.isArray(r.toolchains)||a.operation_id!==r.operation_id||a.admission_digest!==r.admission_digest||a.plan_digest!==r.plan_digest)refuse();
 const modulePins=plan.runtime_files.filter((row:Data)=>String(row.path).endsWith('/preparation/fleet_readiness_probe.js'));
 const nodePins=plan.runtime_files.filter((row:Data)=>path.basename(String(row.path))==='node');
 if(modulePins.length!==1||nodePins.length!==1)refuse();
 const verifier={node_path:nodePins[0].path,node_digest:nodePins[0].digest,module_path:modulePins[0].path,module_digest:modulePins[0].digest};
 const files=new Map<string,Data>();for(const row of r.source_files as Data[]){const {mount:_mount,...entry}=row,previous=files.get(row.path);if(previous&&fleetReadinessCanonical(previous)!==fleetReadinessCanonical(entry))refuse();files.set(row.path,entry);}
 let encodedBytes=0;
 const source_files=[...files.values()].sort((x,y)=>x.path.localeCompare(y.path));
 const source_state_digest=fleetReadinessDigest({kind:'FLEET_MANIFEST_SOURCE_V1',repository_id:n.source.repository,revision:a.source_revision,source_manifest_digest:a.source_manifest_digest,files:source_files});
 return a.slot_bindings.map((binding:Data)=>{
  const slots=r.slots.filter((s:Data)=>s.slot===binding.slot&&s.worker_slot_id===binding.worker_slot_id);if(slots.length!==1)refuse();const actual=slots[0];
  if(typeof actual.source_config_digest!=='string'||typeof actual.dependency_inventory_digest!=='string')refuse();
  const slot={...binding};
  for(const key of ['source','home','temporary','build','dirty'])if(actual[key]!==slot[key])refuse();
  const configurations=(r.configurations as Data[]).map(row=>{
   const specification=p['configuration.'+row.name],pin=(plan.configuration_versions as Data[]).find(c=>c.name===row.name);if(!specification||!pin)refuse();
   const privateConfig=specification.kind==='secret-ref'||specification.mode!=='0444';
   const target=privateConfig?row.slots?.find((s:Data)=>s.slot===slot.slot&&s.worker_slot_id===slot.worker_slot_id)?.target:row.target;
   if(typeof target!=='string')refuse();
   return {name:row.name,kind:specification.kind,reference:row.reference,version:row.version,target,mode:row.mode,private:privateConfig,...(specification.kind==='config-ref'?{digest:pin.digest}:{seal_path:path.join(slot.worker_root,'.hyperfide-seals','configuration-'+row.name+'.json')})};
  });
  const remap=(value:string):string=>{
   for(const row of configurations){const specification=p['configuration.'+row.name];if(value===specification.target)return row.target;}
   const mounts=Object.entries(p).filter(([key])=>key.startsWith('mount.')).map(([,v])=>v as Data).sort((x,y)=>String(y.target).length-String(x.target).length);
   for(const mount of mounts)if(value===mount.target||value.startsWith(mount.target+'/'))return path.join(slot.source,path.relative(mount.target,value));
   return value;
  };
  const toolchain_manifest=Object.fromEntries(Object.entries(p).filter(([key])=>key.startsWith('toolchain.')));
  const probes=(p.readiness.require_probes as string[]).map(name=>{const probe=p['probe.'+name];return {name,argv:probe.argv.map(remap),cwd:remap(probe.cwd),timeout_seconds:probe.timeout_seconds,expected_exit:probe.expected_exit};});
  const interfaces={target:p.interfaces.output,digest:r.interfaces.fragment_digest,catalogue_digest:r.interfaces.catalogue_digest,source_revision:r.interfaces.source_revision,selected_ids:r.interfaces.selected_ids,publication_digest:r.interfaces.publication_digest,proof_digest:r.interfaces.proof_digest,consumer_id:r.interfaces.consumer_id,consumer_digest:r.interfaces.consumer_digest,max_blocks:p.interfaces.max_blocks,max_bytes:p.interfaces.max_bytes};
  const workspace_digest=fleetReadinessDigest({kind:'FLEET_MANIFEST_WORKSPACE_V1',slot,source_config_digest:actual.source_config_digest,dependency_inventory_digest:actual.dependency_inventory_digest,configuration_versions:configurations,interfaces,plan_digest:a.plan_digest});
  const readiness_input={schema_version:1,kind:'FLEET_MANIFEST_V1',operation_id:a.operation_id,environment_root:a.environment_root,admission_digest:a.admission_digest,plan_digest:a.plan_digest,package_digest:a.package_digest,source_manifest_digest:a.source_manifest_digest,source_revision:a.source_revision,slot,source_files,source_config_digest:actual.source_config_digest,dependency_inventory_digest:actual.dependency_inventory_digest,toolchains:r.toolchains,toolchain_manifest,configurations,interfaces,probes,source_state_digest,workspace_digest};
  const result={verifier,readiness_input,input_digest:fleetReadinessDigest(readiness_input),source_state_digest,workspace_digest};encodedBytes+=Buffer.byteLength(fleetReadinessCanonical(result));if(encodedBytes>4*1024*1024)refuse();return result;
 });
}
