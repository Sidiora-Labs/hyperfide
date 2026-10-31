import type {PrimaryTransaction} from '../storage/transactions.js';
import {readRunnerBinding,readRunnerReadiness} from './bridge.js';
import {findFleetRuntimeSlot} from '../preparation/fleet_readiness.js';
import {fail} from '../transport/protocol.js';
import {object} from '../policy/programme.js';

/** A verified manifest publication is its own workspace dialect, never a slice/full-tree exemption. */
export interface FleetManifestDeclaration {
 mode:'FLEET_MANIFEST';readiness_digest:string;install_operation_id:string;workspace_path:string;
 slot_generation:string;source_digest:string;source_object_id:string;source_tree_id:string;
 source_state_digest:string;workspace_digest:string;uid:number;gid:number;
}
export interface FleetManifestWorkspace extends FleetManifestDeclaration {
 source:'VERIFIED_INSTALL_SNAPSHOT';materialisation_id:null;slice_digest:null;fallback_reason:null;
}
export async function resolveFleetManifestWorkspace(tx:PrimaryTransaction,scope:{organisation_id:string;run_id:string},slot:{sandbox_id:string;slot_id:string;sandbox_boot_generation:string}):Promise<FleetManifestWorkspace|null>{
 const selected=await findFleetRuntimeSlot(tx,scope,slot);
 if(!selected)return null;
 const binding=await readRunnerBinding(tx,{...scope,session_id:selected.runner_session_id});
 const ready=await readRunnerReadiness(tx,binding);
 if(ready.kind!=='FLEET_MANIFEST_V1'||ready.readiness_digest!==selected.readiness_digest||ready.readiness_input?.slot?.source!==selected.workspace_path||String(ready.slot_generation)!==String(selected.slot_generation)||binding.workspace_path!==selected.workspace_path)
  fail('WORKER_FLEET_MANIFEST_STALE','Current runner must bind the exact verified manifest publication and private workspace');
 return {mode:'FLEET_MANIFEST',source:'VERIFIED_INSTALL_SNAPSHOT',materialisation_id:null,slice_digest:null,fallback_reason:null,
  readiness_digest:String(ready.readiness_digest),install_operation_id:String(ready.install_operation_id),workspace_path:selected.workspace_path,
  slot_generation:String(ready.slot_generation),source_digest:String(ready.source_digest),source_object_id:String(ready.source_object_id),source_tree_id:String(ready.source_tree_id),
  source_state_digest:String(ready.source_state_digest),workspace_digest:String(ready.workspace_digest),uid:Number(ready.uid),gid:Number(ready.gid)};
}
export function fleetManifestDeclaration(workspace:FleetManifestWorkspace):FleetManifestDeclaration{
 const {source:_source,materialisation_id:_materialisation,slice_digest:_slice,fallback_reason:_fallback,...declared}=workspace;
 return declared;
}
export function assertFleetManifestDeclaration(value:unknown,workspace:FleetManifestWorkspace):void{
 if(!object(value))fail('WORKER_FLEET_MANIFEST_UNDECLARED','Manifest-backed admission must name its verified workspace dialect');
 const expected=fleetManifestDeclaration(workspace);
 if(Object.keys(value).length!==Object.keys(expected).length||Object.entries(expected).some(([key,pin])=>value[key]!==pin))
  fail('WORKER_FLEET_MANIFEST_MISMATCH','Admission workspace differs from its current manifest source, slot identity or same-UID measurements');
}
