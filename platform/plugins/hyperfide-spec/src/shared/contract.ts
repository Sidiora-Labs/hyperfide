import { defineRpcContract } from '@hyperfide/plugin-sdk';
import { z } from 'zod';
import { statuses, type Task } from './model.js';
import { durableMemorySchema } from '../../../memory/durable-memory.js';

export const taskSchema: z.ZodType<Task> = z.object({
  id: z.string(), feature: z.string(), title: z.string(), status: z.enum(statuses),
  wave: z.number(), requires: z.array(z.string()), touches: z.array(z.string()),
  verify_cmd: z.string(), do: z.array(z.string()), reqs: z.array(z.string()),
  owner: z.string(), criteria: z.array(z.object({ id: z.string(), text: z.string() })),
  recalledDecisions: z.array(durableMemorySchema).optional(),
}).catchall(z.string());
const scope = z.object({ repository: z.string().min(1).optional() });
const feature = scope.extend({ feature: z.string().min(1) });
export const specContract = defineRpcContract({
  features: { input: scope, output: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), tasks: z.array(taskSchema) })) },
  tasks: { input: feature, output: z.array(taskSchema) },
  task: { input: feature.extend({ id: z.string().min(1) }), output: taskSchema },
  waves: { input: feature, output: z.array(z.object({ wave: z.number(), tasks: z.array(taskSchema) })) },
});
