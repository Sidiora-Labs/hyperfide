import type {Component,ComponentContext} from '../components/registry.js';
import type {InvocationContext} from '../transport/protocol.js';
import type {PrimaryTransaction} from '../storage/transactions.js';
import {object} from '../policy/programme.js';
import type {FleetDecision} from './fleet_authority.js';
import {executePrimarySource,observePrimarySources,PRIMARY_SOURCE_ACTIONS} from './fleet_source_actions.js';
interface SourceBridge {install(value:{execute(i:InvocationContext,d:FleetDecision):Promise<Record<string,unknown>>;observe(tx:PrimaryTransaction,i:InvocationContext):Promise<Record<string,unknown>>}):void}
export function createComponent(ctx:ComponentContext):Component {
 const bridge=ctx.dependencies.require('fleet-orchestration','fleet.source.bridge',(value:unknown):value is SourceBridge=>object(value)&&typeof value.install==='function');
 bridge.install({execute:(i,d)=>executePrimarySource(ctx,i,d),observe:observePrimarySources});
 return {apiVersion:1,actions:{'fleet.source.describe':()=>({schema_version:1,decision_action:'SOURCE_OPERATION',role:'PRIMARY',source_actions:PRIMARY_SOURCE_ACTIONS})}};
}
