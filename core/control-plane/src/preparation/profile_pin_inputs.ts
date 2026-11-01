import {createHash} from 'node:crypto';
import type {EnvironmentProfile,FilePin} from './manifests.js';
export function preparationFilePins(profile:EnvironmentProfile):FilePin[]{
 const pins=new Map<string,FilePin>();for(const pin of [profile.recipe,...profile.generated_inputs,...profile.build_config,...profile.package_managers.flatMap(manager=>manager.locks),...profile.preparation_evidence]){const old=pins.get(pin.path);if(old&&old.digest!==pin.digest)throw new Error('PREPARATION_PIN_CONFLICT');pins.set(pin.path,pin);}return [...pins.values()];
}
export function preparationPinInputs(profile:EnvironmentProfile):Array<FilePin&{origin:'SOURCE'|'PROFILE_ARTIFACT';role:string}>{
 const origins=new Map(profile.result_preparation?.inputs.map(pin=>[pin.path,pin.origin]));
 return preparationFilePins(profile).map(pin=>{const origin=profile.schema_version===1?'SOURCE':origins.get(pin.path);if(!origin)throw new Error('PREPARATION_PIN_ORIGIN_REQUIRED');return {...pin,origin,role:'profile-pin:'+createHash('sha256').update(pin.path).digest('hex')};});
}
