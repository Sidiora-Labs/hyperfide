import type { SourceSQL } from "./metadata.js";
import {
  listNativeFleetRunSources,
  readAdmittedNativeFleetSource,
} from "./fleet-run-source.js";
import { sourceFailure } from "./metadata.js";

export interface FleetRepositoryPin {
  [key: string]: unknown;
  repository_id: string;
  source_object_id: string;
  integration_ref: string | null;
  source_backend?: "native";
  security_domain_id?: string;
  root_tree_id?: string;
}
export async function readFleetRepositoryPins(
  tx: SourceSQL,
  organisation_id: string,
  run_id: string,
): Promise<FleetRepositoryPin[]> {
  const native = await listNativeFleetRunSources(tx, {
    organisation_id,
    run_id,
  });
  const replaced = new Set(native.map((source) => source.scope.repository_id));
  const legacy = (
    await tx.query<FleetRepositoryPin>(
      "SELECT repository_id,source_object_id,integration_ref FROM hyperfide.run_repositories WHERE organisation_id=$1 AND run_id=$2 ORDER BY repository_id",
      [organisation_id, run_id],
    )
  ).rows;
  return [
    ...legacy.filter((source) => !replaced.has(source.repository_id)),
    ...native.map((source) => ({
      repository_id: source.scope.repository_id,
      source_object_id: source.revision_id,
      integration_ref: null,
      source_backend: "native" as const,
      security_domain_id: source.scope.security_domain_id,
      root_tree_id: source.root_tree_id,
    })),
  ].sort((a, b) => a.repository_id.localeCompare(b.repository_id));
}
export function fleetSourceRevision(
  pin: FleetRepositoryPin | undefined,
): string | null {
  return pin
    ? pin.source_backend === "native"
      ? pin.source_object_id
      : "git:" + pin.source_object_id
    : null;
}

/** A current bound attempt retains its admitted source; prospective packets use the current selection. */
export async function readFleetRepositoryPinsForAttempt(
  tx: SourceSQL,
  organisation_id: string,
  run_id: string,
  input: {
    attempt_id: string;
    attempt_generation: string;
    packet_digest: string;
    repositories: readonly unknown[];
  },
): Promise<FleetRepositoryPin[]> {
  const current = await readFleetRepositoryPins(tx, organisation_id, run_id);
  const assignments = (
    await tx.query(
      `SELECT f.*,revision.root_tree_id AS admitted_root FROM hyperfide.source_fleet_assignments f
 JOIN hyperfide.attempts a ON a.organisation_id=f.organisation_id AND a.run_id=f.run_id AND a.id=f.attempt_id AND a.generation=f.attempt_generation AND a.task_id=f.task_id
 JOIN hyperfide.tasks t ON t.organisation_id=a.organisation_id AND t.run_id=a.run_id AND t.id=a.task_id AND t.current_attempt_id=a.id AND t.generation=a.generation
 JOIN hyperfide.runs r ON r.organisation_id=a.organisation_id AND r.id=a.run_id AND r.authority_epoch=f.run_authority_epoch
 JOIN hyperfide.source_workspaces w ON w.organisation_id=f.organisation_id AND w.repository_id=f.repository_id AND w.security_domain_id=f.security_domain_id AND w.workspace_id=f.workspace_id AND w.principal_id=f.worker_principal_id AND w.authority_epoch=f.source_authority_epoch AND w.closed_at IS NULL
 JOIN hyperfide.source_authority_domains d ON d.organisation_id=f.organisation_id AND d.repository_id=f.repository_id AND d.security_domain_id=f.security_domain_id AND d.authority_epoch=f.source_authority_epoch AND d.enabled
 JOIN hyperfide.source_revisions revision ON revision.organisation_id=f.organisation_id AND revision.repository_id=f.repository_id AND revision.security_domain_id=f.security_domain_id AND revision.revision_id=f.base_revision_id
 WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.attempt_id=$3 AND f.attempt_generation=$4 AND a.input_packet_digest=$5
 AND f.submission_id IS NULL AND a.compute_authority='CURRENT' AND a.lease_expires_at>clock_timestamp() AND a.authority_epoch=f.run_authority_epoch
 AND a.sandbox_id=f.sandbox_id AND a.slot_id=f.slot_id AND a.sandbox_boot_generation=f.sandbox_boot_generation FOR SHARE OF f,a,t,r,w,d,revision`,
      [
        organisation_id,
        run_id,
        input.attempt_id,
        input.attempt_generation,
        input.packet_digest,
      ],
    )
  ).rows;
  if (!assignments.length) return current;
  if (assignments.length !== 1)
    sourceFailure(
      "EXECUTION_INPUTS_STALE",
      "Native attempt has ambiguous source assignments",
    );
  const assigned = assignments[0]!,
    pinned = input.repositories.find(
      (value): value is FleetRepositoryPin =>
        value !== null &&
        typeof value === "object" &&
        (value as FleetRepositoryPin).repository_id === assigned.repository_id,
    );
  if (
    !pinned ||
    pinned.source_backend !== "native" ||
    pinned.security_domain_id !== assigned.security_domain_id ||
    pinned.source_object_id !== assigned.base_revision_id ||
    pinned.root_tree_id !== assigned.admitted_root
  )
    sourceFailure(
      "EXECUTION_INPUTS_STALE",
      "Native assignment differs from its immutable execution packet",
    );
  const admitted = await readAdmittedNativeFleetSource(
    tx,
    { organisation_id, run_id },
    assigned.repository_id,
    assigned.base_revision_id,
  );
  if (
    !admitted ||
    admitted.scope.security_domain_id !== assigned.security_domain_id ||
    admitted.root_tree_id !== assigned.admitted_root
  )
    sourceFailure(
      "EXECUTION_INPUTS_STALE",
      "Native attempt source is no longer an admitted revision",
    );
  return current.map((pin) =>
    pin.repository_id === assigned.repository_id
      ? {
          ...pin,
          source_object_id: assigned.base_revision_id,
          root_tree_id: assigned.admitted_root,
        }
      : pin,
  );
}
