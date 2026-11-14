import { SourceControlError } from "../contracts.js";
import {
  sourceScopeValues,
  type SourceContext,
  type SourceMetadata,
  type SourceSQL,
} from "../metadata.js";
import { parseConsolidationManifest } from "./consolidation.js";

export interface NativeMigrationInventory {
  legacy_writer_ids: string[];
  installed_schema: {
    source: {
      versions: number[];
      tables: { name: string; columns: string[] }[];
    };
    evidence: {
      versions: number[];
      tables: { name: string; columns: string[] }[];
    };
  };
  open_workspaces: number;
  workspaces: {
    workspace_id: string;
    authority_epoch: string;
    principal_id: string;
    base_revision_id: string;
    checkpoint_revision_id: string | null;
    root_tree_id: string;
    dirty_paths: string[];
    dirty_paths_complete: false;
    custody_holders: { custody_id: string; owner_principal_id: string }[];
  }[];
  pending_uploads: number;
  unresolved_publications: number;
  incomplete_imports: number;
  acknowledged_revisions: number;
  selected_history: {
    project_id: string;
    import_id: string;
    commits: number;
    revisions: number;
    collapsed: number;
    mapped: number;
  }[];
  external_publication_effects: {
    operation_id: string;
    destination_id: string;
    target_ref: string;
    status: string;
  }[];
}
export async function migrationInventory(
  tx: SourceSQL,
  context: SourceContext,
): Promise<NativeMigrationInventory> {
  const scope = sourceScopeValues(context.scope);
  const bounded = async (query: string, values: unknown[] = scope) => {
    const rows = (await tx.query(query, values)).rows;
    if (rows.length > 10000)
      throw new SourceControlError(
        "MIGRATION_INVENTORY_LIMIT",
        "Migration inventory requires a narrower scope",
      );
    return rows;
  };
  const count = async (table: string, condition: string) =>
    Number(
      (
        await tx.query(
          "SELECT count(*)::int AS n FROM hyperfide." +
            table +
            " WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND " +
            condition,
          scope,
        )
      ).rows[0]!.n,
    );
  const cutover = (
    await tx.query(
      "SELECT manifest FROM hyperfide.source_native_cutovers WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND state<>'ABORTED'",
      scope,
    )
  ).rows[0];
  const manifest = cutover
    ? parseConsolidationManifest(cutover.manifest)
    : undefined;
  const schema = (
    await tx.query(
      "SELECT c.relname AS name,array_agg(a.attname ORDER BY a.attnum) AS columns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE n.nspname='hyperfide' AND c.relkind='r' AND c.relname=ANY($1::text[]) GROUP BY c.relname ORDER BY c.relname",
      [
        [
          "source_revisions",
          "source_workspaces",
          "source_git_imports",
          "source_native_assurance_evidence",
          "source_candidate_qualifications",
          "source_native_custodies",
        ],
      ],
    )
  ).rows as { name: string; columns: string[] }[];
  const versions = async (table: string, column: string) =>
    (
      await tx.query(
        "SELECT DISTINCT (" +
          column +
          "->>'schema_version')::int AS version FROM hyperfide." +
          table +
          " WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 ORDER BY version",
        scope,
      )
    ).rows.map((r) => Number(r.version));
  const workspaces: NativeMigrationInventory["workspaces"] = [];
  for (const row of await bounded(
    "SELECT workspace_id,authority_epoch::text,principal_id,base_revision_id,checkpoint_revision_id,root_tree_id,write_paths FROM hyperfide.source_workspaces WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND closed_at IS NULL ORDER BY workspace_id LIMIT 10001",
  )) {
    const holders = await bounded(
      "SELECT custody_id,owner_principal_id FROM hyperfide.source_native_custodies WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND revision_id=ANY($4::text[]) AND revoked_at IS NULL ORDER BY custody_id LIMIT 10001",
      [
        ...scope,
        [row.base_revision_id, row.checkpoint_revision_id].filter(Boolean),
      ],
    );
    // Local overlays are outside the metadata transaction: every writable path remains suspect until checkpoint/closure.
    workspaces.push({
      workspace_id: row.workspace_id,
      authority_epoch: row.authority_epoch,
      principal_id: row.principal_id,
      base_revision_id: row.base_revision_id,
      checkpoint_revision_id: row.checkpoint_revision_id,
      root_tree_id: row.root_tree_id,
      dirty_paths: row.write_paths,
      dirty_paths_complete: false,
      custody_holders: holders.map((h) => ({
        custody_id: h.custody_id,
        owner_principal_id: h.owner_principal_id,
      })),
    });
  }
  const selected_history: NativeMigrationInventory["selected_history"] = [];
  for (const project of manifest?.projects ?? []) {
    const row = (
      await tx.query(
        "SELECT count(*)::int AS commits,count(DISTINCT revision_id)::int AS revisions,count(*) FILTER(WHERE disposition='COLLAPSED')::int AS collapsed,count(*) FILTER(WHERE disposition='MAPPED')::int AS mapped FROM hyperfide.source_git_import_commits WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND import_id=$4",
        [...scope, project.import_id],
      )
    ).rows[0]!;
    selected_history.push({
      project_id: project.project_id,
      import_id: project.import_id,
      commits: row.commits,
      revisions: row.revisions,
      collapsed: row.collapsed,
      mapped: row.mapped,
    });
  }
  const effects = await bounded(
    "SELECT operation_id,request->>'destination_id' AS destination_id,target_ref,status FROM hyperfide.source_git_publications WHERE organisation_id=$1 AND repository_id=$2 AND security_domain_id=$3 AND status IN ('QUEUED','READY','DISPATCHED','OUTCOME_UNKNOWN') ORDER BY operation_id LIMIT 10001",
  );
  return {
    legacy_writer_ids: manifest?.legacy_writer_ids ?? [],
    installed_schema: {
      source: {
        versions: await versions("source_revisions", "descriptor"),
        tables: schema.filter((t) =>
          [
            "source_revisions",
            "source_workspaces",
            "source_git_imports",
          ].includes(t.name),
        ),
      },
      evidence: {
        versions: await versions("source_native_assurance_evidence", "receipt"),
        tables: schema.filter(
          (t) =>
            ![
              "source_revisions",
              "source_workspaces",
              "source_git_imports",
            ].includes(t.name),
        ),
      },
    },
    open_workspaces: workspaces.length,
    workspaces,
    pending_uploads: await count(
      "source_object_uploads",
      "status IN ('UPLOADING','UNKNOWN')",
    ),
    unresolved_publications: effects.length,
    external_publication_effects: effects.map((r) => ({
      operation_id: r.operation_id,
      destination_id: r.destination_id,
      target_ref: r.target_ref,
      status: r.status,
    })),
    incomplete_imports: await count("source_git_imports", "state='IMPORTING'"),
    acknowledged_revisions: await count(
      "source_cutover_acknowledgements",
      "true",
    ),
    selected_history,
  };
}
export async function inspectMigrationInventory(
  metadata: SourceMetadata,
  context: SourceContext,
) {
  return metadata.transaction(async (tx) => {
    await metadata.guard(tx, context, "source.migration.read");
    return migrationInventory(tx, context);
  });
}
