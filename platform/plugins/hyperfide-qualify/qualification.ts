import { defineRpcContract, type PluginRpc, type PluginRealtime } from '@hyperfide/plugin-sdk';
import { z } from 'zod';
import { LaneService, type Lane } from './lanes';
import { createQualificationAdapter, type QualificationAdapter } from './adapter';
export const LANE_CHANNEL = 'hyperfide-qualify:lane';
const id = z.object({id: z.string().min(1)}).strict();
const lane = z.custom<Lane>();
export const qualifyRpcContract = defineRpcContract({
  start: {input: z.object({repository: z.string().min(1), feature: z.string().regex(/^[\w-]+$/), task: z.string().min(1), mode: z.enum(['verify', 'done']).optional(), postgres: z.boolean().optional(), busyTimeoutMs: z.number().int().positive().optional()}).strict(), output: lane},
  cancel: {input: id, output: lane}, get: {input: id, output: lane},
  list: {input: z.object({repository: z.string().optional()}).strict(), output: z.array(lane)},
  log: {input: id.extend({after: z.number().int().nonnegative().default(0)}), output: z.array(z.object({sequence: z.number(), stream: z.enum(['stdout', 'stderr']), text: z.string()}))}
});
export interface QualificationHost { rpc: PluginRpc; realtime: PluginRealtime; onDispose(callback: () => void | Promise<void>): void }
export function registerQualification(host: QualificationHost, adapter: QualificationAdapter = createQualificationAdapter()) {
  const lanes = new LaneService(adapter, event => host.realtime.publish(LANE_CHANNEL, event));
  host.rpc.register(qualifyRpcContract, {
    start: input => lanes.start(input), cancel: ({id}) => lanes.cancel(id), get: ({id}) => lanes.get(id),
    list: ({repository}) => lanes.list(repository), log: ({id, after}) => lanes.log(id, after)
  });
  host.onDispose(() => lanes.close());
  return lanes;
}
