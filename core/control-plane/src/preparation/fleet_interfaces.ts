import {verifyFleetInterfaceSelection} from '../contracts/fleet/index.mjs';
import {fail,hash,strictJSON} from '../transport/protocol.js';
export interface FleetInterfacePins {
 interface_fragment_digest:string;interface_publication_digest:string;interface_proof_digest:string;interface_consumer_id:string;package_digest:string;
}
export interface FleetInterfaceManifest {catalogue_digest:string;source_revision:string;selected_ids:readonly string[];max_blocks:number;max_bytes:number;}
export async function verifyFleetInterfaceFragment(input:{fragment:Uint8Array;proof:Uint8Array;plan:FleetInterfacePins;interfaces:FleetInterfaceManifest}) {
 const {fragment,proof,plan,interfaces}=input;
 if(fragment.byteLength>interfaces.max_bytes||proof.byteLength>interfaces.max_bytes||hash(Buffer.from(fragment))!==plan.interface_fragment_digest)fail('FLEET_INSTALL_INTERFACE_PIN','Bounded fragment differs from registered plan');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(fragment);}catch{fail('FLEET_INSTALL_INTERFACE_ENCODING','Interface fragment must be valid UTF-8');}
 return verifyFleetInterfaceSelection({fragment:text,proof:strictJSON(Buffer.from(proof),interfaces.max_bytes),expected:{publicationDigest:plan.interface_publication_digest,proofDigest:plan.interface_proof_digest,consumerId:plan.interface_consumer_id,packageDigest:plan.package_digest,sourceRevision:interfaces.source_revision,catalogueDigest:interfaces.catalogue_digest,ids:interfaces.selected_ids,maxBlocks:interfaces.max_blocks,maxBytes:interfaces.max_bytes}});
}
