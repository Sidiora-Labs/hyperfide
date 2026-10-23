import { defineRpcContract } from '@hyperfide/plugin-sdk';
import { z } from 'zod';
import type { Task } from './model.js';

const text = z.string().min(1).refine(value => !value.includes('\0'));
export const scopeSchema = z.object({ hostId: text, repository: text, feature: text }).strict();
export const actionSchema = scopeSchema.extend({ id: text, action: z.enum(['start', 'implemented']) });
export const boardContract = defineRpcContract({
  tasks: { input: scopeSchema, output: z.custom<Task[]>() },
  action: { input: actionSchema, output: z.void() },
});
