// Local task 2.1 projection; replace with the read-model module when it lands.
export const statuses = ['pending', 'in_progress', 'implemented', 'done'] as const;
export type Status = typeof statuses[number];
export interface Task {
  id: string;
  title: string;
  status: Status;
  wave: number;
  owner: string;
  requires: string[];
  touches: string[];
  verify_cmd: string;
  do: string[];
  reqs: string[];
  criteria: { id: string; text: string }[];
  latestReceipt?: string;
}
export interface BoardModel { feature: string; tasks: Task[] }
export type BoardAction = 'start' | 'implemented';
export interface BoardRpc {
  tasks(feature: string): Promise<Task[]>;
  action(feature: string, id: string, action: BoardAction): Promise<void>;
}
