/** Fleet leases are fenced by attempt; a disconnected executor cannot finish a retry. */
export interface FleetJob {
  id: string;
  threadId: string;
  payload: string;
  state: "queued" | "running" | "completed" | "failed";
  hostId: string | null;
  previousHosts: string[];
  attempt: number;
}
export interface FleetHost {
  id: string;
  capacity: number;
  lastSeen: number;
  online: boolean;
  sessionHash: string;
}
export interface FleetEnrollment {
  tokenHash: string;
  hostId: string;
  operatorId: string;
  capacity: number;
  expiresAt: number;
  consumed: boolean;
}
export interface FleetState {
  enrollments: FleetEnrollment[];
  hosts: FleetHost[];
  jobs: FleetJob[];
}
/** Implement with an authority transaction, including cross-process exclusion. */
export interface FleetAuthority {
  transaction<T>(operation: (state: FleetState) => T): Promise<T>;
}
export interface FleetTransport {
  enroll(token: string): Promise<{ hostId: string; session: string }>;
  poll(hostId: string, session: string): Promise<FleetJob[]>;
  complete(hostId: string, session: string, jobId: string, attempt: number, success: boolean): Promise<void>;
}
export type FleetScheduler = (hosts: readonly FleetHost[], job: FleetJob, jobs: readonly FleetJob[]) => string | null;
