import type { Task as SpecTask } from '../shared/model.js';
export { statuses } from '../shared/model.js';
export type Task = SpecTask & { latestReceipt?: string; recalledDecisions?: { id: number; type: string; body: string }[] };
export interface BoardModel { feature: string; tasks: Task[] }
export type BoardAction = 'start' | 'implemented';
export interface BoardRpc {
  tasks(feature: string): Promise<Task[]>;
  task?(feature: string, id: string): Promise<Task>;
  action(feature: string, id: string, action: BoardAction): Promise<void>;
}
