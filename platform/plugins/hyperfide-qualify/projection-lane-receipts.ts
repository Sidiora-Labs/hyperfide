import { writeReceipt, type PassedLane } from "./receipts";
import { runBinary, type Runner } from "../hyperfide-spec/projection-run-task";
// Projection of 4.1's lane completion event; replace this adapter when its host lands.
export interface LaneReceiptHost {
  onLaneFinished(handler: (lane: PassedLane) => Promise<void>): void;
  recordReceipt(task: string, path: string): Promise<void>;
}
export function registerLaneReceipts(host: LaneReceiptHost, runner: Runner = runBinary) {
  const handler = async (lane: PassedLane) => {
    const result = await writeReceipt(lane, runner);
    if (result) await host.recordReceipt(lane.task, result.path);
  };
  host.onLaneFinished(handler);
  return handler;
}
