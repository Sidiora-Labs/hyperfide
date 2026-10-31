import {defineRpcContract,type HyperfidePluginApi} from '@hyperfide/plugin-sdk';
import {authorityConfiguration,createAuthorityClient} from '@hyperfide/authority';
import {z} from 'zod';

const decisionContract=defineRpcContract({
 managerDecision:{input:z.object({decision:z.record(z.string(),z.unknown())}),output:z.record(z.string(),z.unknown())},
});
export function registerManagerDecisions(api:HyperfidePluginApi){
 api.rpc.register(decisionContract,{
  async managerDecision({decision}){
   const config=authorityConfiguration(process.env);
   if(!config)throw new Error('WAITING_FOR_MANAGER: authenticated fleet authority is not configured');
   if(typeof decision.operation_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decision.operation_id))throw new Error('Manager decision requires its stable operation UUID');
   const client=await createAuthorityClient(config);
   return client.fleetDecision(decision,{operationId:decision.operation_id,idempotencyKey:decision.operation_id});
  },
 },{experimental_discoverable:true,experimental_description:'Execute an admitted Wave Manager decision through the authenticated fleet authority; no local planning fallback'});
}
