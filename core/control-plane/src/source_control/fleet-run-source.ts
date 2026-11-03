import { parseUUID, type SourceScope } from "./contracts.js";
import { sourceDigest, sourceFailure } from "./metadata.js";
import { authorizeInvocationSource } from "./capabilities.js";
import {
  assertPrimaryTransaction,
  type PrimaryTransaction,
} from "../storage/transactions.js";
import {
  assertInvocation,
  type AuthorityTransaction,
  type InvocationContext,
} from "../transport/protocol.js";

export interface NativeFleetRunSource {
  scope: SourceScope;
  run_id: string;
  revision_id: string;
  root_tree_id: string;
  source_revision: string;
  source_manifest_digest: string;
  authority_epoch: string;
  source_authority_epoch: string;
  leader_generation: string;
  selection_id?: string;
  selection_generation?: string;
}

export async function listNativeFleetRunSources(
  tx: AuthorityTransaction,
  scope: { organisation_id: string; run_id: string },
  repositoryId?: string,
): Promise<NativeFleetRunSource[]> {
  await tx.query(
    "SELECT 1 FROM hyperfide.source_fleet_runs WHERE organisation_id=$1 AND run_id=$2 AND ($3::uuid IS NULL OR repository_id=$3) FOR SHARE",
    [
      parseUUID(scope.organisation_id),
      parseUUID(scope.run_id),
      repositoryId ? parseUUID(repositoryId) : null,
    ],
  );
  const rows = (
    await tx.query(
      `SELECT f.*,r.authority_epoch AS current_run_epoch,d.authority_epoch::text AS current_source_epoch,d.enabled,s.root_tree_id AS current_root,
      h.generation::text AS head_generation,picked.selection_id,picked.generation::text AS selection_generation,picked.revision_id AS selected_revision,picked.root_tree_id AS selected_root,
      picked.run_authority_epoch AS selection_run_epoch,picked.source_authority_epoch::text AS selection_source_epoch
    FROM hyperfide.source_fleet_runs f JOIN hyperfide.runs r ON r.organisation_id=f.organisation_id AND r.id=f.run_id
    JOIN hyperfide.source_authority_domains d ON d.organisation_id=f.organisation_id AND d.repository_id=f.repository_id AND d.security_domain_id=f.security_domain_id
    LEFT JOIN hyperfide.source_fleet_selection_heads h ON h.organisation_id=f.organisation_id AND h.repository_id=f.repository_id AND h.security_domain_id=f.security_domain_id AND h.run_id=f.run_id
    LEFT JOIN hyperfide.source_fleet_selections picked ON picked.organisation_id=h.organisation_id AND picked.repository_id=h.repository_id AND picked.security_domain_id=h.security_domain_id AND picked.run_id=h.run_id AND picked.selection_id=h.selection_id AND picked.generation=h.generation
    JOIN hyperfide.source_revisions s ON s.organisation_id=f.organisation_id AND s.repository_id=f.repository_id AND s.security_domain_id=f.security_domain_id AND s.revision_id=COALESCE(picked.revision_id,f.revision_id)
    WHERE f.organisation_id=$1 AND f.run_id=$2 AND ($3::uuid IS NULL OR f.repository_id=$3) FOR SHARE OF f,r,d,s`,
      [
        parseUUID(scope.organisation_id),
        parseUUID(scope.run_id),
        repositoryId ? parseUUID(repositoryId) : null,
      ],
    )
  ).rows;
  return rows.map((row) => {
    if (
      row.authority_epoch !== row.current_run_epoch ||
      String(row.source_authority_epoch) !== row.current_source_epoch ||
      row.enabled !== true ||
      (row.selected_root ?? row.root_tree_id) !== row.current_root ||
      (row.head_generation &&
        row.head_generation !== "0" &&
        !row.selection_id) ||
      (row.selection_id &&
        (row.selection_run_epoch !== row.current_run_epoch ||
          row.selection_source_epoch !== row.current_source_epoch))
    )
      sourceFailure(
        "FLEET_SOURCE_STALE",
        "The configured native run source is no longer current",
      );
    const sourceScope = {
      organisation_id: row.organisation_id,
      repository_id: row.repository_id,
      security_domain_id: row.security_domain_id,
    };
    const revision = row.selected_revision ?? row.revision_id,
      root = row.selected_root ?? row.root_tree_id;
    return {
      scope: sourceScope,
      run_id: row.run_id,
      revision_id: revision,
      root_tree_id: root,
      source_revision: revision,
      source_manifest_digest: sourceDigest({
        scope: sourceScope,
        revision_id: revision,
        root_tree_id: root,
      }),
      authority_epoch: row.authority_epoch,
      source_authority_epoch: String(row.source_authority_epoch),
      leader_generation: String(row.leader_generation),
      ...(row.selection_id
        ? {
            selection_id: row.selection_id,
            selection_generation: row.selection_generation,
          }
        : {}),
    };
  });
}

export async function readAdmittedNativeFleetSource(
  tx: AuthorityTransaction,
  scope: { organisation_id: string; run_id: string },
  repositoryId: string,
  revisionId: string,
): Promise<NativeFleetRunSource | null> {
  const current = await readNativeFleetRunSource(tx, scope, repositoryId);
  if (!current) return null;
  if (current.revision_id === revisionId) return current;
  const row = (
    await tx.query(
      `SELECT r.root_tree_id,s.selection_id,s.generation::text FROM hyperfide.source_fleet_runs f
    JOIN hyperfide.source_revisions r ON r.organisation_id=f.organisation_id AND r.repository_id=f.repository_id AND r.security_domain_id=f.security_domain_id AND r.revision_id=$4
    LEFT JOIN hyperfide.source_fleet_selections s ON s.organisation_id=f.organisation_id AND s.repository_id=f.repository_id AND s.security_domain_id=f.security_domain_id AND s.run_id=f.run_id AND s.revision_id=$4 AND s.run_authority_epoch=f.authority_epoch AND s.source_authority_epoch=f.source_authority_epoch
    WHERE f.organisation_id=$1 AND f.run_id=$2 AND f.repository_id=$3 AND (f.revision_id=$4 OR s.selection_id IS NOT NULL)
    ORDER BY s.generation DESC NULLS LAST LIMIT 1`,
      [scope.organisation_id, scope.run_id, repositoryId, revisionId],
    )
  ).rows[0];
  if (!row) return null;
  const {
    selection_id: _selected,
    selection_generation: _generation,
    ...base
  } = current;
  return {
    ...base,
    revision_id: revisionId,
    source_revision: revisionId,
    root_tree_id: row.root_tree_id,
    source_manifest_digest: sourceDigest({
      scope: current.scope,
      revision_id: revisionId,
      root_tree_id: row.root_tree_id,
    }),
    ...(row.selection_id
      ? { selection_id: row.selection_id, selection_generation: row.generation }
      : {}),
  };
}

export async function readNativeFleetRunSource(
  tx: AuthorityTransaction,
  scope: { organisation_id: string; run_id: string },
  repositoryId?: string,
): Promise<NativeFleetRunSource | null> {
  const rows = await listNativeFleetRunSources(tx, scope, repositoryId);
  if (rows.length > 1)
    sourceFailure(
      "FLEET_SOURCE_AMBIGUOUS",
      "Select an explicit repository for this multi-repository native run",
    );
  return rows[0] ?? null;
}

export async function validateNativeFleetSource(
  tx: PrimaryTransaction,
  i: InvocationContext,
  input: {
    repository_id: string;
    security_domain_id: string;
    revision_id: string;
  },
): Promise<NativeFleetRunSource> {
  assertPrimaryTransaction(tx);
  assertInvocation(i);
  await i.guard(tx);
  const current = await readNativeFleetRunSource(
    tx,
    {
      organisation_id: i.principal.organisation_id,
      run_id: i.principal.run_id,
    },
    input.repository_id,
  );
  if (
    !current ||
    current.scope.security_domain_id !== input.security_domain_id ||
    current.revision_id !== input.revision_id
  )
    sourceFailure(
      "FLEET_SOURCE_MISMATCH",
      "Installed native source differs from the explicit run binding",
    );
  await authorizeInvocationSource(tx, {
    invocation: i,
    scope: current.scope,
    action: "source.fleet.read",
    mutation: false,
    revision_id: current.revision_id,
  });
  return current;
}

export async function validateAdmittedNativeFleetSource(
  tx: PrimaryTransaction,
  i: InvocationContext,
  input: {
    repository_id: string;
    security_domain_id: string;
    revision_id: string;
  },
): Promise<NativeFleetRunSource> {
  assertPrimaryTransaction(tx);
  assertInvocation(i);
  await i.guard(tx);
  const admitted = await readAdmittedNativeFleetSource(
    tx,
    {
      organisation_id: i.principal.organisation_id,
      run_id: i.principal.run_id,
    },
    input.repository_id,
    input.revision_id,
  );
  if (
    !admitted ||
    admitted.scope.security_domain_id !== input.security_domain_id
  )
    sourceFailure(
      "FLEET_SOURCE_MISMATCH",
      "Retained source does not name an admitted native run revision",
    );
  await authorizeInvocationSource(tx, {
    invocation: i,
    scope: admitted.scope,
    action: "source.fleet.read",
    mutation: false,
    revision_id: admitted.revision_id,
  });
  return admitted;
}
