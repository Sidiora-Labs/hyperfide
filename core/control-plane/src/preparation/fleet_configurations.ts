import path from 'node:path';
import {object} from '../policy/programme.js';
import {fail} from '../transport/protocol.js';
export interface FleetConfiguration {kind:'config-ref'|'secret-ref';reference:string;target:string;mode:string;required:boolean;}
export interface FleetConfigurationSlot {slot:number;worker_slot_id:string;home:string;}
export interface FleetConfigurationTarget {slot:number;worker_slot_id:string;target:string;}
export interface FleetConfigurationEnvironmentBinding {name:string;reference:string;environment_name:string;}
export function fleetConfigurationEnvironmentBindings(manifest:Record<string,unknown>):FleetConfigurationEnvironmentBinding[]{
 const result:FleetConfigurationEnvironmentBinding[]=[];
 for(const key of Object.keys(manifest).filter(key=>key.startsWith('configuration.')).sort()){
  const candidate=manifest[key];if(!object(candidate)||!['config-ref','secret-ref'].includes(String(candidate.kind))||typeof candidate.reference!=='string'||!candidate.reference.startsWith(String(candidate.kind)+':'))fail('FLEET_INSTALL_CONFIGURATION','Validated configuration reference required');
  const reference=candidate.reference;
  if(candidate.kind==='secret-ref')result.push({name:key.slice(14),reference,environment_name:'FLEET_CONFIG_'+result.length});
 }
 return result;
}
export function fleetConfigurationTargets(config:FleetConfiguration,slots:readonly FleetConfigurationSlot[]):FleetConfigurationTarget[]{
 const privateConfig=config.kind==='secret-ref'||config.mode!=='0444';
 if(!Array.isArray(slots)||slots.length<1||slots.length>1024||new Set(slots.map(slot=>slot.slot)).size!==slots.length||new Set(slots.map(slot=>slot.worker_slot_id)).size!==slots.length)fail('FLEET_INSTALL_CONFIGURATION','Distinct signed worker slot mapping required');
 if(!privateConfig){if(/[{}]/.test(config.target))fail('FLEET_INSTALL_CONFIGURATION','Shared configuration cannot use a worker template');return [];}
 if(config.target.split('{slot}').length!==2||/[{}]/.test(config.target.replace('{slot}','0'))||!/^0[0-7]{3}$/.test(config.mode)||(parseInt(config.mode,8)&0o077)!==0)fail('FLEET_INSTALL_CONFIGURATION','Private configuration requires an explicit worker target template and owner-only mode');
 return slots.map(slot=>{
  const target=config.target.replace('{slot}',String(slot.slot));
  if(!Number.isSafeInteger(slot.slot)||slot.slot<0||!path.isAbsolute(target)||path.resolve(target)!==target||!path.isAbsolute(slot.home)||path.resolve(slot.home)!==slot.home||!target.startsWith(slot.home+'/'))fail('FLEET_INSTALL_CONFIGURATION','Private configuration target differs from the signed worker home');
  return {slot:slot.slot,worker_slot_id:slot.worker_slot_id,target};
 });
}
