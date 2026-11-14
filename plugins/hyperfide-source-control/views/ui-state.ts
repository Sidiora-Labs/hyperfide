import type { SourceWorkspaceEvidence } from "../contract.js";

export type CheckpointDisplayState =
  | "OPEN"
  | "DIRTY"
  | "UPLOADING"
  | "UNKNOWN"
  | SourceWorkspaceEvidence["stage"];

export function checkpointDisplayState(input: {
  hostUnresolved: boolean;
  pending: boolean;
  dirty: boolean;
  evidenceStage?: SourceWorkspaceEvidence["stage"];
}): CheckpointDisplayState {
  if (input.hostUnresolved) return "UNKNOWN";
  if (input.pending) return "UPLOADING";
  if (input.dirty) return "DIRTY";
  return input.evidenceStage ?? "OPEN";
}
